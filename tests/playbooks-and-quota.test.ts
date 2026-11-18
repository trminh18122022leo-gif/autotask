import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createAgentContext, runAgentLoop } from '../src/agent/loop.js';
import { buildHistoryPrompt } from '../src/agent/planner.js';
import { ModelRouter } from '../src/model-center/model-router.js';
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
  type QuotaCheckReport
} from '../src/model-center/quota-checker.js';
import { parseProviderHttpError } from '../src/providers.js';
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
