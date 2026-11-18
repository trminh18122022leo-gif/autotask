/** Independent Pilot-Gate Policy Audit Regressions (PILOT-01..04)
 * Reproduces the four confirmed policy vulnerabilities on unmodified v1.1.6-lms-security-remediated source:
 *   - PILOT-01 (P1): Graded Practice Quiz ("Practice Quiz" + "Grading method: Highest grade" + "Grade to pass: 7/10" + "Attempts allowed: 1") misclassified as PRACTICE_VERIFIED.
 *   - PILOT-02 (P1): Global config.operationMode = 'READ_ONLY' overridden by task.mode = 'PRACTICE_ASSISTED'.
 *   - PILOT-03 (P1): Unknown-scope open attempt ("Continue the last attempt") continued when scope is UNKNOWN_SCOPE and mode is unset.
 *   - PILOT-04 (P2): Live interactive denial (config.confirmAttemptStart() -> false) bypassed by stale task.confirmStartNewAttempt = true.
 */
import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  classifyActivityScope,
  inspectQuizLaunchSurface,
  evaluateQuizStartPolicy
} from '../src/quiz-start-policy.js';
import type { AppConfig, Task } from '../src/types.js';
import { validateConfig } from '../src/config.js';
import { resolveEffectiveOperationMode, isModeEscalation } from '../src/operation-mode.js';
import { ResumeCoordinator } from '../src/browser/resume-coordinator.js';
import { resetStartGrantLedger, setDurableLedgerPath } from '../src/quiz-start-policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import type { TaskCheckpoint } from '../src/task-manager.js';

async function openMockMoodlePage(browser: Browser, url: string, html: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.route(url, route =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html
    })
  );
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('Phase 0 — Independent Pilot-Gate Policy Regressions (PILOT-01..04)', () => {
  let browser: Browser;

  let tempLedgerDir: string;
  let tempLedgerFile: string;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
  });

  beforeEach(() => {
    tempLedgerDir = mkdtempSync(join(tmpdir(), 'autotask-pilot-gate-'));
    tempLedgerFile = join(tempLedgerDir, 'ledger.json');
    setDurableLedgerPath(tempLedgerFile);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      rmSync(tempLedgerDir, { recursive: true, force: true });
    } catch {}
  });

  function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      allowedHosts: ['lms.hust.edu.vn'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' },
      ...overrides
    };
  }

  test('PILOT-01: Graded Practice Quiz ("Practice Quiz" + Highest grade + Grade to pass: 7/10 + Attempts allowed: 1) must NOT be classified as PRACTICE_VERIFIED', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=101';
    const html = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Practice Quiz</title></head>
      <body class="path-mod-quiz moodle">
        <h2>Practice Quiz</h2>
        <div class="quizinfo">
          <p>Attempts allowed: 1</p>
          <p>Grading method: Highest grade</p>
          <p>Grade to pass: 7/10</p>
        </div>
        <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
          <input type="hidden" name="cmid" value="101">
          <button type="submit" class="btn btn-primary">Attempt quiz now</button>
        </form>
      </body></html>`;

    const scopeRes = classifyActivityScope(
      'Practice Quiz\nGrading method: Highest grade\nGrade to pass: 7/10\nAttempts allowed: 1'
    );
    assert.notEqual(
      scopeRes.scope,
      'PRACTICE_VERIFIED',
      `Graded quiz named "Practice Quiz" must never be PRACTICE_VERIFIED (got ${scopeRes.scope}: ${scopeRes.evidence})`
    );
    assert.equal(scopeRes.scope, 'ASSESSMENT_RESTRICTED');

    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Practice Quiz');
      const task: Task = {
        id: 'pilot-01-graded-practice',
        url,
        title: 'Practice Quiz',
        aiPermitted: true,
        mode: 'PRACTICE_ASSISTED',
        confirmStartNewAttempt: true
      };
      const decision = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig(),
        platform: 'moodle',
        inspection
      });
      assert.equal(decision.action, 'HALT_NEEDS_REVIEW');
      assert.equal(decision.code, 'ASSESSMENT_RESTRICTED_SCOPE');
    } finally {
      await page.context().close();
    }
  });

  test('PILOT-02: Global config.operationMode = READ_ONLY must NOT be overridden by task.mode = PRACTICE_ASSISTED', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=102';
    const html = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Self-Practice Quiz: Trees</title></head>
      <body class="path-mod-quiz moodle">
        <h2>Self-Practice Quiz: Trees</h2>
        <div class="quizinfo">
          <p>Ungraded self-practice — Unlimited attempts — 0 points</p>
        </div>
        <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
          <input type="hidden" name="cmid" value="102">
          <button type="submit" class="btn btn-primary">Attempt quiz now</button>
        </form>
      </body></html>`;

    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Self-Practice Quiz: Trees');
      const task: Task = {
        id: 'pilot-02-readonly-override',
        url,
        title: 'Self-Practice Quiz: Trees',
        aiPermitted: true,
        mode: 'PRACTICE_ASSISTED',
        confirmStartNewAttempt: true
      };
      const decision = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig({ operationMode: 'READ_ONLY' }),
        platform: 'moodle',
        inspection
      });
      assert.equal(
        decision.action,
        'HALT_NEEDS_REVIEW',
        `Global READ_ONLY must block task-level PRACTICE_ASSISTED escalation (got ${decision.action})`
      );
      assert.equal(decision.code, 'READ_ONLY_MODE');
    } finally {
      await page.context().close();
    }
  });

  test('PILOT-03: Unknown-scope existing attempt ("Continue the last attempt") must fail-closed when scope is unverified and mode is unset', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=103';
    const html = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Quiz 3: Chapter 4</title></head>
      <body class="path-mod-quiz moodle">
        <h2>Quiz 3: Chapter 4</h2>
        <p>State: In progress</p>
        <form method="get" action="https://lms.hust.edu.vn/mod/quiz/attempt.php">
          <input type="hidden" name="attempt" value="881">
          <button type="submit" class="btn btn-primary">Continue the last attempt</button>
        </form>
      </body></html>`;

    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Quiz 3: Chapter 4');
      assert.equal(inspection.hasContinueAttemptControl, true);
      assert.equal(inspection.scope, 'UNKNOWN_SCOPE');

      const task: Task = {
        id: 'pilot-03-unknown-continue',
        url,
        title: 'Quiz 3: Chapter 4',
        aiPermitted: true
      };
      const decision = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig(),
        platform: 'moodle',
        inspection
      });
      assert.equal(
        decision.action,
        'HALT_NEEDS_REVIEW',
        `Unknown-scope open attempt without confirmed PRACTICE_ASSISTED mode must NOT continue automatically (got ${decision.action})`
      );
    } finally {
      await page.context().close();
    }
  });

  test('PILOT-04: Interactive denial callback (confirmAttemptStart -> false) must NOT be bypassed by stored task.confirmStartNewAttempt = true', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=104';
    const html = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Self-Practice Quiz: Hashing</title></head>
      <body class="path-mod-quiz moodle">
        <h2>Self-Practice Quiz: Hashing</h2>
        <div class="quizinfo">
          <p>Ungraded self-practice — Unlimited attempts — 0 points</p>
        </div>
        <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
          <input type="hidden" name="cmid" value="104">
          <button type="submit" class="btn btn-primary">Attempt quiz now</button>
        </form>
      </body></html>`;

    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Self-Practice Quiz: Hashing');
      let callbackInvoked = false;
      const task: Task = {
        id: 'pilot-04-callback-denial',
        url,
        title: 'Self-Practice Quiz: Hashing',
        aiPermitted: true,
        mode: 'PRACTICE_ASSISTED',
        confirmStartNewAttempt: true
      };
      const decision = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig({
          confirmAttemptStart: async () => {
            callbackInvoked = true;
            return false;
          }
        }),
        platform: 'moodle',
        inspection
      });
      assert.equal(callbackInvoked, true, 'Interactive confirmAttemptStart callback must always be consulted');
      assert.equal(
        decision.action,
        'HALT_NEEDS_REVIEW',
        `Live interactive denial must block new attempt even if task.confirmStartNewAttempt=true (got ${decision.action})`
      );
      assert.equal(decision.code, 'AWAITING_START_CONFIRMATION');
    } finally {
      await page.context().close();
    }
  });


  // ==================== PHASE 1: PRACTICE-SAFE-01..05 ====================
  test('PRACTICE-SAFE-01: Practice title + Highest grade -> BLOCK (ASSESSMENT_RESTRICTED)', () => {
    const text = 'Practice Quiz: Graph Theory\nGrading method: Highest grade\nAttempts allowed: 3';
    const res = classifyActivityScope(text);
    assert.equal(res.scope, 'ASSESSMENT_RESTRICTED');
    assert.ok(res.evidence.includes('Grading method'));
  });

  test('PRACTICE-SAFE-02: Practice title + Grade to pass -> BLOCK/REVIEW (ASSESSMENT_RESTRICTED)', () => {
    const text = 'Practice Quiz: Calculus\nGrade to pass: 5.00 / 10.00\nUnlimited attempts';
    const res = classifyActivityScope(text);
    assert.equal(res.scope, 'ASSESSMENT_RESTRICTED');
    assert.ok(res.evidence.includes('Grade to pass'));
  });

  test('PRACTICE-SAFE-03: Midterm exam with "Practice" in description -> BLOCK (ASSESSMENT_RESTRICTED)', () => {
    const text = 'Midterm Exam 1 (Kiểm tra giữa kỳ)\nDescription: Use this to practice your skills before final.';
    const res = classifyActivityScope(text);
    assert.equal(res.scope, 'ASSESSMENT_RESTRICTED');
    assert.ok(/giữa kỳ|midterm/i.test(res.evidence));
  });

  test('PRACTICE-SAFE-04: Ungraded self-practice with no conflicting signals -> PRACTICE_VERIFIED', () => {
    const text = 'Self-Practice Quiz: Recursion\nGrading: Ungraded self-practice\n0 points\nNo grade recorded in gradebook';
    const res = classifyActivityScope(text);
    assert.equal(res.scope, 'PRACTICE_VERIFIED');
    assert.ok(res.evidence.includes('Ungraded'));
  });

  test('PRACTICE-SAFE-05: Missing or unloaded grading metadata -> UNKNOWN_SCOPE (NEEDS_REVIEW)', () => {
    const text = 'Practice Quiz 1'; // Only title, no metadata loaded yet!
    const res = classifyActivityScope(text);
    assert.equal(res.scope, 'UNKNOWN_SCOPE');
    assert.ok(res.evidence.includes('tên hoạt động không đủ'));
  });

  // ==================== PHASE 2: IMMUTABLE GLOBAL MODES ====================
  test('PHASE2-MODE-01: Shared effective mode resolver enforces restriction lattice (READ_ONLY > ASSESSMENT_RESTRICTED > PRACTICE_ASSISTED)', () => {
    // Global READ_ONLY cannot be downgraded by task
    assert.equal(resolveEffectiveOperationMode({ operationMode: 'READ_ONLY' }, { mode: 'PRACTICE_ASSISTED' }), 'READ_ONLY');
    assert.equal(resolveEffectiveOperationMode({ operationMode: 'READ_ONLY' }, { mode: 'ASSESSMENT_RESTRICTED' }), 'READ_ONLY');
    // Global ASSESSMENT_RESTRICTED cannot be downgraded by task
    assert.equal(resolveEffectiveOperationMode({ operationMode: 'ASSESSMENT_RESTRICTED' }, { mode: 'PRACTICE_ASSISTED' }), 'ASSESSMENT_RESTRICTED');
    // Task CAN restrict further (e.g. global PRACTICE_ASSISTED + task READ_ONLY)
    assert.equal(resolveEffectiveOperationMode({ operationMode: 'PRACTICE_ASSISTED' }, { mode: 'READ_ONLY' }), 'READ_ONLY');
    assert.equal(resolveEffectiveOperationMode({ operationMode: 'PRACTICE_ASSISTED' }, { mode: 'ASSESSMENT_RESTRICTED' }), 'ASSESSMENT_RESTRICTED');
    // Task escalations detected
    assert.equal(isModeEscalation('READ_ONLY', 'PRACTICE_ASSISTED'), true);
    assert.equal(isModeEscalation('READ_ONLY', 'ASSESSMENT_RESTRICTED'), true);
    assert.equal(isModeEscalation('ASSESSMENT_RESTRICTED', 'PRACTICE_ASSISTED'), true);
    assert.equal(isModeEscalation('PRACTICE_ASSISTED', 'READ_ONLY'), false);
  });

  test('PHASE2-MODE-02: validateConfig() rejects conflicting mode escalations', () => {
    assert.throws(
      () =>
        validateConfig({
          allowedHosts: ['lms.hust.edu.vn'],
          approvedForAIUse: true,
          operationMode: 'READ_ONLY',
          parallelTabs: 1,
          authUrls: [],
          deadlinePages: [],
          tasks: [{ id: 't1', url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=1', aiPermitted: true, mode: 'PRACTICE_ASSISTED' }],
          provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
        }),
      /nới rộng quyền/i
    );
  });

  test('PHASE2-MODE-03: ResumeCoordinator.evaluateState rejects resuming from checkpoint under global READ_ONLY / ASSESSMENT_RESTRICTED', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=99&page=1';
    const html = `<!DOCTYPE html><html><body><div class="que"><input type="radio" name="q1" value="1"></div></body></html>`;
    const page = await openMockMoodlePage(browser, url, html);
    try {
      const cp: TaskCheckpoint = {
        taskId: 'cp-ro-test',
        url: 'https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=99&page=0',
        status: 'RUNNING',
        stepsCompleted: 1,
        questionsFound: 1,
        questionsFilled: 1,
        lastUpdated: new Date().toISOString()
      };
      const resRO = await ResumeCoordinator.evaluateState(page, cp, baseConfig({ operationMode: 'READ_ONLY' }));
      assert.equal(resRO.state, 'NEEDS_REVIEW');
      assert.ok(resRO.reason.includes('[READ_ONLY]'));

      const resAR = await ResumeCoordinator.evaluateState(page, cp, baseConfig({ operationMode: 'ASSESSMENT_RESTRICTED' }));
      assert.equal(resAR.state, 'NEEDS_REVIEW');
      assert.ok(resAR.reason.includes('[ASSESSMENT_RESTRICTED]'));
    } finally {
      await page.context().close();
    }
  });

  // ==================== PHASE 4: FRESH CONSENT FOR EACH NEW ATTEMPT ====================
  test('PHASE4-CONSENT-01: Live interactive callback returning false blocks even if task.confirmStartNewAttempt=true', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=201';
    const html = `<!DOCTYPE html><html><body>
      <h2>Self-Practice Quiz</h2>
      <p>Ungraded self-practice</p>
      <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
        <input type="hidden" name="cmid" value="201">
        <button type="submit">Attempt quiz now</button>
      </form></body></html>`;
    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Self-Practice Quiz');
      const task: Task = { id: 't-consent-denied', url, title: 'Self-Practice Quiz', aiPermitted: true, mode: 'PRACTICE_ASSISTED', confirmStartNewAttempt: true };
      const res = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig({ confirmAttemptStart: async () => false }),
        platform: 'moodle',
        inspection
      });
      assert.equal(res.action, 'HALT_NEEDS_REVIEW');
      assert.equal(res.code, 'AWAITING_START_CONFIRMATION');
    } finally {
      await page.context().close();
    }
  });

  test('PHASE4-CONSENT-02: Live interactive callback returning true permits attempt start', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=202';
    const html = `<!DOCTYPE html><html><body>
      <h2>Self-Practice Quiz</h2>
      <p>Ungraded self-practice</p>
      <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
        <input type="hidden" name="cmid" value="202">
        <button type="submit">Attempt quiz now</button>
      </form></body></html>`;
    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Self-Practice Quiz');
      const task: Task = { id: 't-consent-allowed', url, title: 'Self-Practice Quiz', aiPermitted: true, mode: 'PRACTICE_ASSISTED' };
      const res = await evaluateQuizStartPolicy({
        page,
        task,
        config: baseConfig({ confirmAttemptStart: async () => true }),
        platform: 'moodle',
        inspection
      });
      assert.equal(res.action, 'START_NEW_ATTEMPT');
      assert.equal(res.code, 'ALLOWED_NEW_PRACTICE_ATTEMPT');
    } finally {
      await page.context().close();
    }
  });

  test('PHASE4-CONSENT-03: Stored confirmStartNewAttempt=true grant is single-use and does not permit opening second attempt without fresh consent', async () => {
    const tempLedger = join(tmpdir(), 'autotask-pilot-gate-ledger-' + Date.now() + '.json');
    setDurableLedgerPath(tempLedger);
    resetStartGrantLedger();
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=203';
    const html = `<!DOCTYPE html><html><body>
      <h2>Self-Practice Quiz</h2>
      <p>Ungraded self-practice</p>
      <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
        <input type="hidden" name="cmid" value="203">
        <button type="submit">Attempt quiz now</button>
      </form></body></html>`;
    const page = await openMockMoodlePage(browser, url, html);
    try {
      const inspection = await inspectQuizLaunchSurface(page, ['lms.hust.edu.vn'], 'Self-Practice Quiz');
      const task: Task = { id: 't-single-use', url, title: 'Self-Practice Quiz', aiPermitted: true, mode: 'PRACTICE_ASSISTED', confirmStartNewAttempt: true };
      
      // Attempt 1: consumes grant
      const first = await evaluateQuizStartPolicy({ page, task, config: baseConfig(), platform: 'moodle', inspection });
      assert.equal(first.action, 'START_NEW_ATTEMPT');

      // Attempt 2: stored grant already consumed -> blocks!
      const second = await evaluateQuizStartPolicy({ page, task, config: baseConfig(), platform: 'moodle', inspection });
      assert.equal(second.action, 'HALT_NEEDS_REVIEW');
      assert.equal(second.code, 'AWAITING_START_CONFIRMATION');

      // When taskId changes -> new task has its own initial grant
      const taskOther: Task = { id: 't-other-id', url, title: 'Self-Practice Quiz', aiPermitted: true, mode: 'PRACTICE_ASSISTED', confirmStartNewAttempt: true };
      const otherRes = await evaluateQuizStartPolicy({ page, task: taskOther, config: baseConfig(), platform: 'moodle', inspection });
      assert.equal(otherRes.action, 'START_NEW_ATTEMPT');

      // After simulated restart (ledger reset) -> consumed grant is NOT refreshed and must halt
      resetStartGrantLedger();
      const afterRestart = await evaluateQuizStartPolicy({ page, task, config: baseConfig(), platform: 'moodle', inspection });
      assert.equal(afterRestart.action, 'HALT_NEEDS_REVIEW');
      assert.equal(afterRestart.code, 'AWAITING_START_CONFIRMATION');
    } finally {
      setDurableLedgerPath(null);
      resetStartGrantLedger();
      try { unlinkSync(tempLedger); } catch {}
      await page.context().close();
    }
  });
});
