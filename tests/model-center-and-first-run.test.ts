import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFirstRunStatus } from '../src/setup.js';
import { validateConfig } from '../src/config.js';
import {
  PROVIDER_REGISTRY,
  VERIFIED_CAPABILITIES,
  inferCapabilities,
  filterAndPaginate,
  getStaticModels
} from '../src/model-center/catalog.js';
import { maskApiKey, sanitizeError } from '../src/model-center/keyring.js';
import { categorizeError } from '../src/model-center/tester.js';
import {
  buildExecutionRoute,
  isFallbackEligible,
  getRoutePlan
} from '../src/model-center/routing.js';
import {
  COLORS,
  DEFAULT_THEME,
  validThemeSettings,
  windowsTerminalProfile,
  type ThemeSettings
} from '../src/ui/themes.js';
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  checkDuplicateRisk
} from '../src/task-manager.js';
import { stringWidth, clip } from '../src/ui/tokyo.js';
import type { AppConfig } from '../src/types.js';

test('First-run status check handles initial unconfigured state gracefully', async () => {
  const status = await checkFirstRunStatus();
  assert.equal(typeof status.modelConfigured, 'boolean');
  assert.equal(typeof status.accountConfigured, 'boolean');
  assert.equal(typeof status.browserTaskConfigured, 'boolean');
  assert.ok(Array.isArray(status.details));
});

test('Multi-website and multi-account AppConfig validation passes for valid structures', () => {
  const validMultiSite: AppConfig = {
    allowedHosts: ['courses.hust.edu.vn', 'forms.google.com', 'forms.office.com'],
    approvedForAIUse: true,
    parallelTabs: 2,
    authUrls: [],
    deadlinePages: ['https://courses.hust.edu.vn/calendar'],
    tasks: [
      { id: 'quiz-1', url: 'https://courses.hust.edu.vn/mod/quiz/view.php?id=123', aiPermitted: true, maxPages: 5 },
      { id: 'form-1', url: 'https://forms.google.com/test', aiPermitted: true, maxPages: 10 }
    ],
    provider: { profileId: 'main-gpt4o', allowVision: true },
    fallbackProfileIds: ['backup-gemini', 'groq-fast'],
    autoDiscover: true
  };

  const res = validateConfig(validMultiSite);
  assert.equal(res.allowedHosts.length, 3);
  assert.equal(res.tasks.length, 2);
  assert.equal(res.fallbackProfileIds?.length, 2);
});

test('Model Center Catalog contains all 5 required providers with valid specs', () => {
  const providers = ['openai', 'gemini', 'anthropic', 'groq', 'custom'] as const;
  for (const p of providers) {
    const meta = PROVIDER_REGISTRY[p];
    assert.ok(meta, `Provider ${p} must exist in registry`);
    assert.equal(meta.id, p);
    assert.ok(meta.name.length > 0);
    assert.ok(['openai-compatible', 'gemini', 'anthropic'].includes(meta.kind));
  }
});

test('Verified capabilities accurately reflect vision and context window', () => {
  const gpt4o = VERIFIED_CAPABILITIES['gpt-4o'];
  assert.equal(gpt4o.vision, true);
  assert.equal(gpt4o.contextWindow, 128000);
  assert.ok(gpt4o.taskCompatibility.includes('Vision'));

  const sonnet = VERIFIED_CAPABILITIES['claude-3-5-sonnet-20241022'];
  assert.equal(sonnet.vision, true);
  assert.equal(sonnet.contextWindow, 200000);

  const llama = VERIFIED_CAPABILITIES['llama-3.3-70b-versatile'];
  assert.equal(llama.vision, false);
});

test('InferCapabilities detects vision and reasoning from model naming heuristics', () => {
  const customVision = inferCapabilities('deepseek-vl-7b');
  assert.equal(customVision.vision, true);

  const customReasoning = inferCapabilities('deepseek-r1-distill');
  assert.ok(customReasoning.taskCompatibility.includes('Reasoning'));
});

test('Catalog search and pagination works accurately', () => {
  const allModels = getStaticModels('openai');
  assert.ok(allModels.length > 0);

  const paginated = filterAndPaginate(allModels, '', 1, 2);
  assert.equal(paginated.items.length, 2);
  assert.equal(paginated.currentPage, 1);
  assert.ok(paginated.totalPages >= 1);

  const searched = filterAndPaginate(allModels, 'mini', 1, 10);
  assert.ok(searched.items.every(m => m.id.toLowerCase().includes('mini')));
});

test('maskApiKey protects secret material while showing identifier hints', () => {
  assert.equal(maskApiKey(''), '••••••••');
  assert.equal(maskApiKey('short'), '••••••••');
  const masked = maskApiKey('sk-proj-1234567890abcdefghijklmnop');
  assert.ok(masked.startsWith('sk-proj'));
  assert.ok(masked.endsWith('mnop'));
  assert.ok(!masked.includes('1234567890'));
});

test('sanitizeError removes sensitive tokens and API keys from error messages', () => {
  const secretKey = 'sk-proj-SUPERSECRET1234567890KEY';
  const rawErr = `Failed request with key ${secretKey} at https://api.openai.com/v1/chat`;
  const sanitized = sanitizeError(rawErr, secretKey);

  assert.ok(!sanitized.includes(secretKey));
  assert.ok(sanitized.includes('[REDACTED_KEY]'));
});

test('categorizeError accurately maps HTTP status codes and error messages', () => {
  const authErr = categorizeError(401, 'Invalid API key provided');
  assert.equal(authErr.category, 'AUTH_INVALID_KEY');

  const quotaErr = categorizeError(429, 'Rate limit exceeded: You exceeded your current quota');
  assert.equal(quotaErr.category, 'QUOTA_EXCEEDED');

  const notFound = categorizeError(404, 'The model gpt-invalid does not exist');
  assert.equal(notFound.category, 'MODEL_NOT_FOUND');

  const networkErr = categorizeError(undefined, 'fetch failed: ETIMEDOUT');
  assert.equal(networkErr.category, 'NETWORK_ERROR');
});

test('buildExecutionRoute prevents infinite loops and deduplicates model fallbacks', () => {
  const available = {
    'primary-model': { provider: 'openai', kind: 'openai-compatible', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1/chat/completions' },
    'fallback-1': { provider: 'gemini', kind: 'gemini', model: 'gemini-2.5-flash', endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
    'fallback-2': { provider: 'groq', kind: 'openai-compatible', model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions' }
  } as any;

  // With duplicates and self-references
  const route = buildExecutionRoute('primary-model', ['fallback-1', 'primary-model', 'fallback-2', 'fallback-1'], available);
  assert.deepEqual(route, ['primary-model', 'fallback-1', 'fallback-2']);
});

test('isFallbackEligible triggers on transient failures but refuses auth and validation errors', () => {
  // Transient failures -> should fallback
  assert.equal(isFallbackEligible(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isFallbackEligible(new Error('HTTP 503 Service Unavailable')), true);
  assert.equal(isFallbackEligible(new Error('fetch failed: timeout')), true);
  assert.equal(isFallbackEligible(new Error('Provider returned no text')), true);

  // Auth / Permission failures -> must NEVER fallback
  assert.equal(isFallbackEligible(new Error('HTTP 401 Unauthorized: Invalid API key')), false);
  assert.equal(isFallbackEligible(new Error('HTTP 403 Forbidden')), false);
  assert.equal(isFallbackEligible(new Error('Invalid Exact model ID')), false);
});

test('Both Tokyo Night and Cyberpunk themes have exact specified palette colors', () => {
  const tn = COLORS['tokyo-night'];
  assert.equal(tn.midnight, '#1a1b26');
  assert.equal(tn.purple, '#bb9af7');
  assert.equal(tn.cyan, '#7dcfff');
  assert.equal(tn.blue, '#7aa2f7');
  assert.equal(tn.green, '#73daca');
  assert.equal(tn.fg, '#c0caf5');

  const cp = COLORS['cyberpunk'];
  assert.equal(cp.midnight, '#0b0614');
  assert.equal(cp.purple, '#ff2bd6'); // Neon Pink
  assert.equal(cp.cyan, '#00f5ff');   // Neon Cyan
  assert.equal(cp.violet, '#a855f7'); // Purple
  assert.equal(cp.yellow, '#fcee0a'); // Yellow
});

test('ThemeSettings validation accepts cursorShape and animations', () => {
  const validSetting: ThemeSettings = {
    theme: 'cyberpunk',
    font: 'JetBrains Mono',
    fontSize: 14,
    opacity: 90,
    animations: false,
    cursorShape: 'underscore'
  };
  assert.equal(validThemeSettings(validSetting), true);

  const wtProfile = windowsTerminalProfile(validSetting);
  assert.equal(wtProfile.name, 'AutoTask Cyberpunk');
  assert.equal(wtProfile.background, '#0b0614');
});

test('Task checkpoints can be saved, loaded, and cleared reliably', async () => {
  const sampleTaskId = 'test-checkpoint-task-001';
  await saveCheckpoint({
    taskId: sampleTaskId,
    url: 'https://courses.hust.edu.vn/test',
    status: 'PARTIAL',
    stepsCompleted: 3,
    totalSteps: 5,
    questionsFound: 10,
    questionsFilled: 6,
    modelUsed: 'gpt-4o',
    lastUpdated: new Date().toISOString()
  });

  const loaded = await loadCheckpoint(sampleTaskId);
  assert.ok(loaded);
  assert.equal(loaded.taskId, sampleTaskId);
  assert.equal(loaded.questionsFilled, 6);
  assert.equal(loaded.status, 'PARTIAL');

  await clearCheckpoint(sampleTaskId);
  const cleared = await loadCheckpoint(sampleTaskId);
  assert.equal(cleared, null);
});

test('stringWidth accurately counts ASCII, Vietnamese diacritics and emojis', () => {
  assert.equal(stringWidth('AutoTask'), 8);
  // Vietnamese characters with tone marks are single width in terminal monospace
  assert.equal(stringWidth('Tiếng Việt'), 10);
  assert.equal(stringWidth('Hạn chót nộp bài'), 16);
  // Clip function truncates accurately to size
  assert.equal(clip('Hạn chót nộp bài tập lớn', 12), 'Hạn chót nộ…');
});
