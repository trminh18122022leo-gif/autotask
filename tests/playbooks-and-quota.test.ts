import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createAgentContext, runAgentLoop } from '../src/agent/loop.js';
import { buildHistoryPrompt } from '../src/agent/planner.js';
import {
  ModelRouter,
  resetProfileCooldowns,
  getKeySlotTelemetrySnapshot,
  type KeyRotationEvent
} from '../src/model-center/model-router.js';
import {
  addApiKeysToProfile,
  replaceApiKeyInSlot,
  removeApiKeySlotFromProfile
} from '../src/model-center/key-manager.js';
import { readProfilesDb, saveProfilesDb, getProfileKeySlots } from '../src/model-center/routing.js';
import { promptModelSelection } from '../src/agent/cli.js';
import type { ModelProfilesDb } from '../src/model-center/types.js';
import {
  buildVietnameseAcronym,
  extractCourseCode,
  findBestMatchingCourse,
  registerAllowedUrlHost,
  sanitizePlaybookUrl,
  learnPlaybookFromRun,
  findMatchingPlaybooks,
  listPlaybooks,
  deletePlaybook,
  formatPlaybookPromptBlock
} from '../src/agent/playbooks.js';
import {
  getPacificMidnightResetInVietnam,
  formatQuotaReport,
  formatSingleKeySpecReport,
  checkAllProfilesQuota,
  inspectSingleApiKeySpecs,
  type QuotaCheckReport
} from '../src/model-center/quota-checker.js';
import { parseProviderHttpError, extractRateLimitHeaders } from '../src/providers.js';
import { parseExtractedJson } from '../src/utils/json.js';
import { canFallback } from '../src/provider-fallback.js';

test('PB-01: Learns verified playbook safely, strips secrets/sesskey, and indexes Vietnamese acronym', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autotask-pb-'));
  const storePath = join(dir, 'playbooks.json');
  const fakePassword = 'SuperSecretPass#2026//';

  try {
    const ctx = createAgentContext({
      targetWebUrl: 'https://lms.hust.edu.vn/my/?sesskey=secret123',
      targetCourse: 'MI2020 - Xác suất thống kê',
      userIntent: 'CHECK_DEADLINES',
      playbookStorePath: storePath
    });
    ctx.activeUrl = 'https://lms.hust.edu.vn/course/view.php?id=4201&sesskey=leakme';
    ctx.collectedFindings = {
      courses: [
        { name: 'MI2020 - Xác suất thống kê (20251)', code: 'MI2020', url: 'https://lms.hust.edu.vn/course/view.php?id=4201&sesskey=leakme' }
      ]
    };
    ctx.history = [
      {
        stepIndex: 1,
        thought: 'Log in via SSO',
        toolCall: { tool: 'account.login', args: {} },
        result: { success: true, observationText: 'Logged in', urlAfter: 'https://lms.hust.edu.vn/my/' },
        timestamp: new Date().toISOString()
      },
      {
        stepIndex: 2,
        thought: 'Fill password test',
        toolCall: { tool: 'browser.fill', args: { selector: '#passwordInput', value: fakePassword } },
        result: { success: true, observationText: 'Filled' },
        timestamp: new Date().toISOString()
      },
      {
        stepIndex: 3,
        thought: 'Open course page',
        toolCall: { tool: 'browser.navigate', args: { url: 'https://lms.hust.edu.vn/course/view.php?id=4201&sesskey=leakme' } },
        result: { success: true, observationText: 'Opened', urlAfter: 'https://lms.hust.edu.vn/course/view.php?id=4201&sesskey=leakme' },
        timestamp: new Date().toISOString()
      },
      {
        stepIndex: 4,
        thought: 'Extract deadlines',
        toolCall: { tool: 'browser.extractStructuredData', args: { type: 'deadlines' } },
        result: { success: true, observationText: 'Extracted' },
        timestamp: new Date().toISOString()
      }
    ];

    const saved = await learnPlaybookFromRun(
      `Vào lms hust mật khẩu là ${fakePassword} kiểm tra môn xác suất thống kê mi2020`,
      ctx,
      {
        goal: 'check',
        status: 'DONE',
        steps: ctx.history,
        summary: 'Done',
        durationMs: 100,
        modelCalls: 2,
        finalUrl: ctx.activeUrl
      },
      [fakePassword]
    );

    assert.ok(saved, 'Playbook should be saved on DONE');
    assert.equal(saved!.courseCode, 'MI2020');
    assert.equal(saved!.courseUrl, 'https://lms.hust.edu.vn/course/view.php?id=4201');
    assert.ok(saved!.keywords.includes('xstk'), 'Should auto-generate Vietnamese subject acronym "xstk"');
    assert.equal(buildVietnameseAcronym('MI2020 - Xác suất thống kê (20251)'), 'xstk');

    const rawFile = await readFile(storePath, 'utf8');
    assert.equal(rawFile.includes(fakePassword), false, 'Password must NEVER be persisted in playbooks.json');
    assert.equal(rawFile.includes('sesskey='), false, 'sesskey token must be stripped from persisted URLs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PB-02: Casual & abbreviated prompts match saved playbook and inject compact hint in planner prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autotask-pb-match-'));
  const storePath = join(dir, 'playbooks.json');

  try {
    const ctxDeadline = createAgentContext({
      targetWebUrl: 'https://lms.hust.edu.vn',
      targetCourse: 'MI2020 - Xác suất thống kê',
      userIntent: 'CHECK_DEADLINES',
      playbookStorePath: storePath
    });
    ctxDeadline.collectedFindings = {
      courses: [{ name: 'MI2020 - Xác suất thống kê', code: 'MI2020', url: 'https://lms.hust.edu.vn/course/view.php?id=4201' }]
    };
    ctxDeadline.history = [{
      stepIndex: 1,
      thought: 'Extract deadlines',
      toolCall: { tool: 'browser.extractStructuredData', args: { type: 'deadlines' } },
      result: { success: true, observationText: 'ok', urlAfter: 'https://lms.hust.edu.vn/course/view.php?id=4201' },
      timestamp: new Date().toISOString()
    }];
    await learnPlaybookFromRun('check hạn nộp mi2020 xác suất thống kê', ctxDeadline, {
      goal: 'check', status: 'DONE', steps: ctxDeadline.history, summary: 'ok', durationMs: 10, modelCalls: 1
    });

    const ctxQuiz = createAgentContext({
      targetWebUrl: 'https://lms.hust.edu.vn',
      targetCourse: 'MI2020 - Xác suất thống kê',
      userIntent: 'SOLVE_QUIZ',
      playbookStorePath: storePath
    });
    ctxQuiz.collectedFindings = ctxDeadline.collectedFindings;
    ctxQuiz.history = [{
      stepIndex: 1,
      thought: 'Solve quiz',
      toolCall: { tool: 'quiz.solve', args: { autoSubmit: true } },
      result: { success: true, observationText: 'submitted', urlAfter: 'https://lms.hust.edu.vn/course/view.php?id=4201' },
      timestamp: new Date().toISOString()
    }];
    await learnPlaybookFromRun('làm quiz môn xác suất thống kê mi2020', ctxQuiz, {
      goal: 'quiz', status: 'DONE', steps: ctxQuiz.history, summary: 'ok', durationMs: 10, modelCalls: 1
    });

    const casualCheck = await findMatchingPlaybooks('vào xstk xem bài tập', { userIntent: 'CHECK_DEADLINES', storePath });
    assert.ok(casualCheck.length >= 1);
    assert.equal(casualCheck[0].playbook.intent, 'CHECK_DEADLINES');
    assert.equal(casualCheck[0].playbook.courseUrl, 'https://lms.hust.edu.vn/course/view.php?id=4201');

    const casualQuiz = await findMatchingPlaybooks('làm bài xstk', { userIntent: 'SOLVE_QUIZ', storePath });
    assert.ok(casualQuiz.length >= 1);
    assert.equal(casualQuiz[0].playbook.intent, 'SOLVE_QUIZ');

    const bareAcronym = await findMatchingPlaybooks('xstk', { storePath });
    assert.ok(bareAcronym.length >= 1, 'Single-word acronym "xstk" should still recall MI2020 playbook');

    const promptCtx = createAgentContext({ targetWebUrl: 'https://lms.hust.edu.vn' }, { matchedPlaybooks: [casualQuiz[0].playbook] });
    const promptText = buildHistoryPrompt(promptCtx, 'làm bài xstk');
    assert.match(promptText, /PLAYBOOK HINT/);
    assert.match(promptText, /https:\/\/lms\.hust\.edu\.vn\/course\/view\.php\?id=4201/);
    assert.ok(formatPlaybookPromptBlock(casualQuiz.map(m => m.playbook)).length < 900, 'Playbook hint should stay concise for TPM budget');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PB-03: Failed/WAITING_FOR_AUTH runs are never saved; deletePlaybook removes entries cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autotask-pb-del-'));
  const storePath = join(dir, 'playbooks.json');

  try {
    const ctx = createAgentContext({ targetWebUrl: 'https://lms.hust.edu.vn', playbookStorePath: storePath });
    ctx.history = [{
      stepIndex: 1,
      thought: 'fail',
      toolCall: { tool: 'account.login', args: {} },
      result: { success: true, observationText: 'ok' },
      timestamp: new Date().toISOString()
    }];

    const skipped = await learnPlaybookFromRun('login', ctx, {
      goal: 'login', status: 'FAILED', steps: ctx.history, summary: 'err', durationMs: 10, modelCalls: 1
    });
    assert.equal(skipped, null);
    assert.equal((await listPlaybooks(storePath)).length, 0);

    const saved = await learnPlaybookFromRun('xem môn IT3080', createAgentContext({
      targetWebUrl: 'https://lms.hust.edu.vn', targetCourse: 'IT3080', userIntent: 'CHECK_DEADLINES', playbookStorePath: storePath
    }, { history: ctx.history }), {
      goal: 'ok', status: 'DONE', steps: ctx.history, summary: 'done', durationMs: 10, modelCalls: 1
    });
    assert.ok(saved);
    assert.equal((await listPlaybooks(storePath)).length, 1);

    const { removed } = await deletePlaybook(saved!.id, storePath);
    assert.equal(removed, 1);
    assert.equal((await listPlaybooks(storePath)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PB-04: End-to-end runAgentLoop auto-saves playbook on run 1 and recalls host + course on casual run 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autotask-pb-e2e-'));
  const storePath = join(dir, 'playbooks.json');
  const realExecute = ModelRouter.execute;

  const srv = createServer((req, res) => {
    const u = req.url || '/';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u.startsWith('/course/view.php')) {
      res.end('<html><body><h1>IT4409 - Công nghệ Web</h1><div class="activity-item">Quiz tuần 1</div></body></html>');
    } else {
      res.end('<html><body><h1>LMS Dashboard</h1><a href="/course/view.php?id=99">IT4409 - Công nghệ Web</a></body></html>');
    }
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    let phase = 1;
    (ModelRouter as any).execute = async (req: any) => {
      let decision: any;
      if (phase === 1) {
        if (req.text.includes('Chưa mở')) {
          decision = { thought: 'Open dashboard', action: { tool: 'browser.open', args: { url: `${baseUrl}/` } } };
        } else if (req.text.includes('/course/view.php?id=99')) {
          decision = { thought: 'Report', action: { tool: 'agent.reportResult', args: { status: 'DONE', summary: 'Checked IT4409' } } };
        } else if (req.text.includes('MÔN HỌC MỤC TIÊU PHÙ HỢP')) {
          decision = { thought: 'Navigate to IT4409', action: { tool: 'browser.navigate', args: { url: `${baseUrl}/course/view.php?id=99` } } };
        } else {
          decision = { thought: 'Extract courses', action: { tool: 'browser.extractStructuredData', args: { type: 'courses' } } };
        }
      } else {
        // Phase 2 verifies planner prompt already received the remembered playbook + direct URL
        assert.match(req.text, /PLAYBOOK HINT/);
        assert.match(req.text, /course\/view\.php\?id=99/);
        decision = { thought: 'Done from recalled hint', action: { tool: 'agent.reportResult', args: { status: 'DONE', summary: 'Recalled IT4409' } } };
      }
      return { output: JSON.stringify(decision), initialProfile: 't', finalProfile: 't', modelUsed: 'test', attempts: 1, fallbackCount: 0, history: [] };
    };

    const ctx1 = createAgentContext({
      allowedHosts: ['127.0.0.1'],
      targetWebUrl: baseUrl,
      targetCourse: 'IT4409 - Công nghệ Web',
      userIntent: 'CHECK_DEADLINES',
      playbookStorePath: storePath,
      maxSteps: 10,
      timeoutMs: 15000,
      headless: true,
      verbose: false
    }, { browser, isLoggedIn: true });

    const res1 = await runAgentLoop(`vào ${baseUrl} kiểm tra bài tập môn Công nghệ Web IT4409`, ctx1);
    assert.equal(res1.status, 'DONE');

    const stored = await listPlaybooks(storePath);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].courseCode, 'IT4409');
    assert.equal(stored[0].courseUrl, `${baseUrl}/course/view.php?id=99`);

    // Second run with bare casual prompt (no URL, no course code, just acronym "cnw")
    phase = 2;
    const ctx2 = createAgentContext({
      allowedHosts: ['127.0.0.1'],
      playbookStorePath: storePath,
      maxSteps: 10,
      timeoutMs: 15000,
      headless: true,
      verbose: false
    }, { browser, isLoggedIn: true });

    const res2 = await runAgentLoop('check bài cnw', ctx2);
    assert.equal(res2.status, 'DONE');
    assert.equal(ctx2.config.targetWebUrl, baseUrl);
    assert.match(ctx2.config.targetCourse || '', /IT4409/);
  } finally {
    (ModelRouter as any).execute = realExecute;
    await browser.close().catch(() => {});
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('QUOTA-01: Pacific midnight reset hour maps accurately to Vietnam UTC+7 (PST 15:00 / PDT 14:00) and redacts keys', () => {
  const winterDate = new Date('2026-11-11T04:00:00Z'); // PST (UTC-8) -> 15:00 VN
  assert.match(getPacificMidnightResetInVietnam(winterDate), /15:00 giờ Việt Nam/);

  const summerDate = new Date('2026-07-15T04:00:00Z'); // PDT (UTC-7) -> 14:00 VN
  assert.match(getPacificMidnightResetInVietnam(summerDate), /14:00 giờ Việt Nam/);

  assert.equal(
    sanitizePlaybookUrl('https://lms.hust.edu.vn/course/view.php?id=10&sesskey=abc&ticket=ST-1'),
    'https://lms.hust.edu.vn/course/view.php?id=10'
  );

  const mockReport: QuotaCheckReport = {
    checkedAt: '2026-11-11T04:00:00.000Z',
    vietnamResetTimeText: '15:00 giờ Việt Nam (00:00 Midnight PT — PST mùa đông)',
    sharedProjectSuspected: false,
    sharedProjectReason: '2 keys differ',
    profiles: [
      {
        profileId: 'prf_1',
        configuredModel: 'gemini-3.5-flash-lite',
        keyHint: 'AIzaSy...1234',
        keyValid: true,
        listedModelsCount: 45,
        results: [
          { model: 'gemini-3.5-flash-lite', state: 'AVAILABLE', httpStatus: 200, latencyMs: 320, knownTierLimits: '15 RPM | 500 RPD' },
          { model: 'gemini-3.6-flash', state: 'DAILY_EXHAUSTED', httpStatus: 429, latencyMs: 280, knownTierLimits: '5 RPM | 20 RPD', quotaLimitValue: '20', retryAfterText: '3h50m' }
        ]
      }
    ]
  };
  const formatted = formatQuotaReport(mockReport);
  assert.match(formatted, /prf_1 \[AIzaSy\.\.\.1234\]/);
  assert.match(formatted, /SẴN SÀNG/);
  assert.match(formatted, /HẾT RPD NGÀY/);
  assert.match(formatted, /Limit báo về: 20/);
});

test('DEDUP-01: Unified helpers (extractCourseCode, registerAllowedUrlHost, findBestMatchingCourse, parseProviderHttpError, parseExtractedJson, canFallback)', () => {
  // 1. Course code extraction ignores non-course tokens like HTTP/UTF8 while matching CS50 & MI2020
  assert.equal(extractCourseCode('https://lms.hust.edu.vn/ utf8 môn mi 2020'), 'MI2020');
  assert.equal(extractCourseCode('Khóa học CS50 Intro'), 'CS50');

  // 2. Allowed host registration adds root institutional SSO subdomains without duplicates
  const hosts: string[] = ['localhost'];
  const added = registerAllowedUrlHost(hosts, 'https://courses.vnu.edu.vn/my/', ['extra.vnu.edu.vn']);
  assert.equal(added, 'courses.vnu.edu.vn');
  assert.ok(hosts.includes('courses.vnu.edu.vn'));
  assert.ok(hosts.includes('sso.vnu.edu.vn'));
  assert.ok(hosts.includes('id.vnu.edu.vn'));
  assert.ok(hosts.includes('extra.vnu.edu.vn'));

  // 3. Course matching supports course code, unaccented Vietnamese, and acronym ("xstk")
  const sampleCourses = [
    { name: 'MI2020 - Xác suất thống kê', url: 'https://lms.hust.edu.vn/course/view.php?id=1' },
    { name: 'IT3080 - Mạng máy tính', url: 'https://lms.hust.edu.vn/course/view.php?id=2' }
  ];
  assert.equal(findBestMatchingCourse(sampleCourses, 'xstk')?.url, 'https://lms.hust.edu.vn/course/view.php?id=1');
  assert.equal(findBestMatchingCourse(sampleCourses, 'mang may tinh')?.url, 'https://lms.hust.edu.vn/course/view.php?id=2');
  assert.equal(findBestMatchingCourse(sampleCourses, 'mi2020')?.url, 'https://lms.hust.edu.vn/course/view.php?id=1');

  // 4. Unified provider error parser extracts QuotaFailure details, retryDelay, and redacts API key
  const raw429 = JSON.stringify({
    error: {
      message: 'Quota exceeded with key AIzaSecretKey999. Please retry in 42.5s.',
      details: [
        {
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaValue: '20' }],
          retryDelay: '42s'
        }
      ]
    }
  });
  const parsedErr = parseProviderHttpError(429, raw429, null, ['AIzaSecretKey999']);
  assert.equal(parsedErr.rateLimitScope, 'DAILY');
  assert.equal(parsedErr.quotaLimitValue, '20');
  assert.equal(parsedErr.retryAfterText, '42s');
  assert.equal(parsedErr.retryAfterMs, 42000);
  assert.equal(parsedErr.reasonSnippet.includes('AIzaSecretKey999'), false);

  // 5. Unified JSON unpacking and fallback predicate
  assert.deepEqual(parseExtractedJson('Reasoning...\n```json\n{"action":{"kind":"done"}}\n```'), { action: { kind: 'done' } });
  assert.equal(canFallback(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(canFallback(new Error('HTTP 401 Unauthorized')), false);
});

test('QUOTA-02: Measures quota & rate limits per API key and per model across Gemini & OpenAI-compatible/Groq endpoints', async () => {
  resetProfileCooldowns();
  const keyGem1 = 'AIzaSyFakeGemOne000000000000001';
  const keyGem2 = 'AIzaSyFakeGemTwo000000000000002';
  const keyGroq1 = 'gsk_FakeGroqOne0000000000000001';

  const srv = createServer((req, res) => {
    const url = req.url || '/';
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', () => {
      if (url.startsWith('/gemini/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-3-flash-preview', inputTokenLimit: 1000000, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-flash-lite', inputTokenLimit: 1000000, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }
          ]
        }));
        return;
      }
      if (url.startsWith('/gemini/models/') && req.method === 'POST') {
        const apiKey = String(req.headers['x-goog-api-key'] || '');
        const modelMatch = url.match(/\/gemini\/models\/([^:]+):generateContent/);
        const modelId = decodeURIComponent(modelMatch?.[1] || '');
        if (apiKey === keyGem1 && modelId === 'gemini-3-flash-preview') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `PerDay quota exceeded for ${apiKey}`,
              details: [
                { violations: [{ quotaId: 'GenerateRequestsPerDay-Free', quotaMetric: 'requests_per_day', quotaValue: '20' }], retryDelay: '3h15m' }
              ]
            }
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '1' }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 }
        }));
        return;
      }
      if (url.startsWith('/groq/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }]
        }));
        return;
      }
      if (url.startsWith('/groq/chat/completions') && req.method === 'POST') {
        const parsed = JSON.parse(bodyStr || '{}');
        const m = String(parsed.model || '');
        if (m === 'llama-3.1-8b-instant') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-ratelimit-limit-requests': '45',
            'x-ratelimit-remaining-requests': '44',
            'x-ratelimit-limit-tokens': '6000',
            'x-ratelimit-remaining-tokens': '5980',
            'x-ratelimit-reset-requests': '1.2s',
            'x-ratelimit-reset-tokens': '800ms'
          });
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-ratelimit-limit-requests': '30',
            'x-ratelimit-remaining-requests': '28',
            'x-ratelimit-limit-tokens': '12000',
            'x-ratelimit-remaining-tokens': '11900',
            'x-ratelimit-reset-requests': '2s',
            'x-ratelimit-reset-tokens': '1s'
          });
        }
        res.end(JSON.stringify({
          choices: [{ message: { content: '1' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
        }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Header extraction test (OpenAI/Groq + Anthropic style)
    const anthHeaders = new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-tokens-remaining': '39500'
    });
    const parsedAnth = extractRateLimitHeaders(anthHeaders);
    assert.equal(parsedAnth.limitRequests, 50);
    assert.equal(parsedAnth.remainingRequests, 49);
    assert.equal(parsedAnth.limitTokens, 40000);
    assert.equal(parsedAnth.remainingTokens, 39500);

    // 2. Multi-provider, multi-key, per-model checkAllProfilesQuota
    const mockDb: ModelProfilesDb = {
      default: 'gem_pool',
      profiles: {
        gem_pool: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3-flash-preview',
          endpoint: `${baseUrl}/gemini`,
          keySlots: ['gem_pool', 'gem_pool__k2'],
          verifiedStatus: 'VERIFIED'
        },
        groq_main: {
          provider: 'groq',
          kind: 'openai-compatible',
          model: 'llama-3.3-70b-versatile',
          endpoint: `${baseUrl}/groq/chat/completions`,
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: ['groq_main']
    };
    const keyMap = new Map<string, string>([
      ['gem_pool', keyGem1],
      ['gem_pool__k2', keyGem2],
      ['groq_main', keyGroq1]
    ]);

    const rep = await checkAllProfilesQuota({
      db: mockDb,
      models: ['gemini-3-flash-preview', 'gemini-3.5-flash-lite'],
      resolveFn: async (spec) => {
        const pid = spec.profileId || 'gem_pool';
        const slot = spec.keySlot || pid;
        const prof = mockDb.profiles[pid];
        return {
          profileId: pid,
          keySlot: slot,
          provider: prof.provider,
          kind: prof.kind,
          model: prof.model,
          endpoint: prof.endpoint,
          apiKey: keyMap.get(slot) || ''
        };
      }
    });

    assert.equal(rep.profiles.length, 3, 'Each API key slot must get its own quota summary');
    assert.equal(rep.sharedProjectSuspected, false, 'Different key1 vs key2 responses prove independent keys');

    const gem1Sum = rep.profiles.find(p => p.profileId === 'gem_pool' && !p.keySlot)!;
    const gem2Sum = rep.profiles.find(p => p.profileId === 'gem_pool' && p.keySlot === 'gem_pool__k2')!;
    const groqSum = rep.profiles.find(p => p.profileId === 'groq_main')!;

    // Verify per-model measurements for Gemini Key 1
    const g1Flash = gem1Sum.results.find(r => r.model === 'gemini-3-flash-preview')!;
    const g1Lite = gem1Sum.results.find(r => r.model === 'gemini-3.5-flash-lite')!;
    assert.equal(g1Flash.state, 'DAILY_EXHAUSTED');
    assert.equal(g1Flash.rpdLimit, 20);
    assert.equal(g1Flash.rpdRemaining, 0);
    assert.equal(g1Flash.limitSource, 'API_ERROR');
    assert.equal(g1Lite.state, 'AVAILABLE');
    assert.equal(g1Lite.rpdLimit, 500);

    // Verify Gemini Key 2 has gemini-3-flash-preview AVAILABLE independently
    const g2Flash = gem2Sum.results.find(r => r.model === 'gemini-3-flash-preview')!;
    assert.equal(g2Flash.state, 'AVAILABLE');

    // Verify Groq key measured DISTINCT rate limits per model from live headers
    const groq70 = groqSum.results.find(r => r.model === 'llama-3.3-70b-versatile')!;
    const groq8 = groqSum.results.find(r => r.model === 'llama-3.1-8b-instant')!;
    assert.equal(groq70.limitSource, 'API_HEADER');
    assert.equal(groq70.rpmLimit, 30);
    assert.equal(groq70.rpmRemaining, 28);
    assert.equal(groq70.tpmLimit, 12000);
    assert.equal(groq8.limitSource, 'API_HEADER');
    assert.equal(groq8.rpmLimit, 45);
    assert.equal(groq8.rpmRemaining, 44);
    assert.equal(groq8.tpmLimit, 6000);

    // Verify telemetry snapshot learned header limits per key slot & model
    const snap = getKeySlotTelemetrySnapshot();
    const groq8Snap = snap.find(s => s.profileId === 'groq_main' && s.model === 'llama-3.1-8b-instant');
    assert.ok(groq8Snap && groq8Snap.limits.rpm === 45 && groq8Snap.limits.tpm === 6000);

    // Verify formatted output never exposes raw keys and works with NO_COLOR=1
    const oldNoColor = process.env.NO_COLOR;
    try {
      process.env.NO_COLOR = '1';
      const txt = formatQuotaReport(rep);
      assert.equal(txt.includes(keyGem1), false);
      assert.equal(txt.includes(keyGem2), false);
      assert.equal(txt.includes(keyGroq1), false);
      assert.equal(/\x1b\[/.test(txt), false);
      assert.match(txt, /\[API\] RPM .*\/45 \(còn 44\)/);
      assert.match(txt, /gem_pool__k2/);

      const singleSpec = await inspectSingleApiKeySpecs(keyGroq1, 'groq', `${baseUrl}/groq/chat/completions`);
      assert.equal(singleSpec.keyValid, true);
      assert.ok((singleSpec.probedSample || []).some(p => p.model === 'llama-3.1-8b-instant' && p.rpmLimit === 45));
      const singleTxt = formatSingleKeySpecReport(singleSpec);
      assert.equal(/\x1b\[/.test(singleTxt), false);
      assert.equal(singleTxt.includes(keyGroq1), false);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }
  } finally {
    srv.close();
    resetProfileCooldowns();
  }
});

test('KEYMGR-01: Key-manager CRUD & promptModelSelection "a" shortcut attaches key(s) to existing profile cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autotask-km-'));
  const dbPath = join(dir, 'profiles.json');
  const vault = new Map<string, string>();
  const ioOpts = {
    dbPath,
    setKeyFn: (s: string, k: string) => { vault.set(s, k); },
    getKeyFn: (s: string) => vault.get(s) || null,
    deleteKeyFn: (s: string) => { vault.delete(s); }
  };

  try {
    const initDb: ModelProfilesDb = {
      default: 'prf_main',
      profiles: {
        prf_main: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.5-flash-lite',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'FAILED'
        }
      },
      fallbacks: []
    };
    vault.set('prf_main', 'AIzaSyInitMainKey0000000000000001');
    await saveProfilesDb(initDb, dbPath);

    // 1. Adding key via UI shortcut ('a' -> pick profile '1' -> enter 2 keys -> then pick '1' Auto)
    const ctx = createAgentContext({ disablePlaybooks: true });
    const rlAnswers = ['a', '1', '1'];
    let secretPrompts = 0;
    const res = await promptModelSelection(ctx, {
      question: async () => rlAnswers.shift() ?? ''
    }, {
      ...ioOpts,
      promptSecretFn: async () => {
        secretPrompts++;
        return 'AIzaSyAddedSlotTwo00000000000002, AIzaSyAddedSlotThree000000000003';
      }
    });
    assert.equal(secretPrompts, 1);
    assert.equal(res.cancelled, false);
    assert.equal(res.mode, 'auto');

    const dbAfterAdd = await readProfilesDb(dbPath);
    assert.equal(dbAfterAdd.profiles.prf_main.verifiedStatus, 'UNTESTED', 'Adding valid key must lift FAILED status');
    assert.deepEqual(getProfileKeySlots('prf_main', dbAfterAdd.profiles.prf_main), [
      'prf_main',
      'prf_main__k2',
      'prf_main__k3'
    ]);

    const dupRes = await addApiKeysToProfile('prf_main', ['AIzaSyAddedSlotTwo00000000000002'], ioOpts);
    assert.equal(dupRes.addedSlots.length, 0);
    assert.equal(dupRes.skippedDuplicates, 1);

    // 2. Replace & remove key slot cleanly without leaking secrets to JSON
    await replaceApiKeyInSlot('prf_main__k2', 'AIzaSyReplacedSlotTwo000000000099', ioOpts);
    assert.equal(vault.get('prf_main__k2'), 'AIzaSyReplacedSlotTwo000000000099');

    const rmRes = await removeApiKeySlotFromProfile('prf_main__k3', ioOpts);
    assert.equal(rmRes.remainingSlots, 2);
    assert.equal(vault.has('prf_main__k3'), false);

    const rawJson = await readFile(dbPath, 'utf8');
    assert.equal(rawJson.includes('AIzaSy'), false, 'Secrets must never touch model-profiles JSON');

    // 3. Verify ModelRouter.execute emits onKeyRotate for both round-robin and failover rotations
    resetProfileCooldowns();
    const rotDb: ModelProfilesDb = {
      default: 'pool',
      profiles: {
        pool: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3-flash-preview',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          keySlots: ['pool', 'pool__k2', 'pool__k3'],
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: []
    };
    const rotEvents: KeyRotationEvent[] = [];
    const resolveRot = async (spec: any) => ({
      profileId: spec.profileId || 'pool',
      keySlot: spec.keySlot || spec.profileId || 'pool',
      provider: 'gemini',
      kind: 'gemini' as const,
      model: 'gemini-3-flash-preview',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSyMockKeyRotationTest000000001'
    });

    // Call with roundRobinIndex=1 while previousKeySlot='pool' -> proactive round-robin to pool__k2
    // Then simulate 429 on pool__k2 -> failover rotation to pool__k3
    await ModelRouter.execute(
      { system: 's', text: 'hi' },
      {
        db: rotDb,
        resolveFn: resolveRot,
        expandModelPool: false,
        enableTelemetryRotation: true,
        roundRobinIndex: 1,
        previousKeySlot: 'pool',
        waitOnRateLimit: false,
        onKeyRotate: async (ev) => { rotEvents.push(ev); }
      },
      async (prov) => {
        if ((prov.keySlot || prov.profileId) === 'pool__k2') {
          const err: any = new Error('HTTP 429 RPM exceeded');
          err.status = 429;
          err.rateLimitScope = 'PER_MINUTE';
          throw err;
        }
        return 'rotated-ok';
      }
    );

    assert.equal(rotEvents.length, 2);
    assert.equal(rotEvents[0].mode, 'round-robin');
    assert.equal(rotEvents[0].toSlot, 'pool__k2');
    assert.equal(rotEvents[0].slotIndex, 2);
    assert.equal(rotEvents[0].totalSlots, 3);
    assert.equal(rotEvents[1].mode, 'failover');
    assert.equal(rotEvents[1].toSlot, 'pool__k3');
    assert.equal(rotEvents[1].slotIndex, 3);
    assert.equal(rotEvents[1].totalSlots, 3);
  } finally {
    resetProfileCooldowns();
    await rm(dir, { recursive: true, force: true });
  }
});
