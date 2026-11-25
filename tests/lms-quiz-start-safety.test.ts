/** Phase 2 — Safe Quiz Attempt Start Policy Regression Suite (START-01..10)
 * Exercises all 10 mandatory quiz attempt start, resume, mode-gating, and anti-duplicate scenarios
 * against a real stateful local Moodle HTTP server and headless Chromium browser.
 */
import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import { revealStart } from '../src/interaction.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { clearCheckpoint, saveCheckpoint } from '../src/task-manager.js';
import type { AppConfig, Question } from '../src/types.js';

interface QuizScenarioConfig {
  heading: string;
  subtitle: string;
  openAttemptInProgress: boolean;
  exhausted: boolean;
  requireLogin: boolean;
  attemptsCreated: number;
  continueClicks: number;
  finalSubmits: number;
  savedAnswer: string;
}

describe('Phase 2 — Safe Quiz Attempt Start Policy (START-01..10)', () => {
  let browser: Browser;
  let server: Server;
  let port = 0;
  const origExecute = ModelRouter.execute;

  let scenario: QuizScenarioConfig = {
    heading: 'Quiz 1: Chapter 3',
    subtitle: 'Attempts allowed: 1',
    openAttemptInProgress: false,
    exhausted: false,
    requireLogin: false,
    attemptsCreated: 0,
    continueClicks: 0,
    finalSubmits: 0,
    savedAnswer: ''
  };

  before(async () => {
    browser = await chromium.launch({ headless: true });

    ModelRouter.execute = (async (req: any) => {
      const parsed = JSON.parse(req.text) as { questions: Question[] };
      const answers = parsed.questions.map(q => {
        if (['radio', 'checkbox', 'select'].includes(q.kind)) {
          return { id: q.id, selected: [q.options[0].id], confidence: 0.94 };
        }
        return { id: q.id, text: 'O(log n)', confidence: 0.94 };
      });
      return {
        output: JSON.stringify({ answers }),
        initialProfile: 'start-policy-test',
        finalProfile: 'start-policy-test',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }) as typeof ModelRouter.execute;

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };

      if (scenario.requireLogin && u.pathname !== '/login/index.php') {
        res.writeHead(302, { Location: '/login/index.php' });
        res.end();
        return;
      }

      if (u.pathname === '/login/index.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><title>Moodle Login</title></head><body>
          <h2>Đăng nhập HUSTLMS</h2>
          <form action="/login/index.php" method="post">
            <input type="text" name="username"><input type="password" name="password">
            <button type="submit">Log in</button>
          </form></body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/view.php') {
        res.writeHead(200, headers);
        if (scenario.exhausted) {
          res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>${scenario.heading}</title></head>
            <body class="path-mod-quiz moodle">
              <h2>${scenario.heading}</h2>
              <p>Attempts allowed: 1</p>
              <table class="generaltable quizattemptsummary"><tbody><tr><td>State</td><td>Finished</td></tr></tbody></table>
              <p>Final grade: 8.50 / 10.00</p>
              <p>No more attempts are allowed</p>
            </body></html>`);
          return;
        }
        const isCont = scenario.openAttemptInProgress;
        const action = isCont ? '/mod/quiz/attempt.php?attempt=501&cmid=12&page=0&via=continue' : '/mod/quiz/startattempt.php';
        const method = isCont ? 'get' : 'post';
        const label = isCont ? 'Continue the last attempt' : 'Attempt quiz now';
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>${scenario.heading}</title></head>
          <body class="path-mod-quiz moodle">
            <h2>${scenario.heading}</h2>
            <div class="activity-dates">Closed: Saturday, 14 November 2026, 11:59 PM</div>
            <p>${scenario.subtitle}</p>
            <form method="${method}" action="${action}">
              <input type="hidden" name="cmid" value="12">
              ${isCont ? '<input type="hidden" name="via" value="continue">' : ''}
              <button type="submit" class="btn btn-primary">${label}</button>
            </form>
          </body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/startattempt.php' && req.method === 'POST') {
        scenario.attemptsCreated++;
        scenario.openAttemptInProgress = true;
        res.writeHead(303, { Location: '/mod/quiz/attempt.php?attempt=501&cmid=12&page=0' });
        res.end();
        return;
      }

      if (u.pathname === '/mod/quiz/attempt.php') {
        if (!scenario.openAttemptInProgress) {
          res.writeHead(303, { Location: '/mod/quiz/view.php?id=12' });
          res.end();
          return;
        }
        if (u.searchParams.get('via') === 'continue') {
          scenario.continueClicks++;
        }
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>${scenario.heading}</title></head>
          <body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz moodle">
            <h2>${scenario.heading}</h2>
            <form id="responseform" method="post" action="/mod/quiz/processattempt.php">
              <input type="hidden" name="finishattempt" value="1">
              <div id="question-501-1" class="que shortanswer"><div class="formulation">
                <div class="qtext"><p>What is the worst-case time complexity of binary search?</p></div>
                <div class="ablock"><input type="text" id="q501:1_answer" name="q501:1_answer" value="${scenario.savedAnswer}"></div>
              </div></div>
              <div class="submitbtns">
                <input type="submit" name="next" value="Finish attempt ..." class="mod_quiz-next-nav btn btn-primary">
              </div>
            </form>
          </body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/processattempt.php' && req.method === 'POST') {
        scenario.finalSubmits++;
        res.writeHead(200, headers);
        res.end('Submitted');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>(r => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port;
        r();
      });
    });
  });

  after(async () => {
    ModelRouter.execute = origExecute;
    await new Promise<void>(r => server.close(() => r()));
    await browser?.close();
  });

  beforeEach(() => {
    scenario = {
      heading: 'Quiz 1: Chapter 3',
      subtitle: 'Attempts allowed: 1',
      openAttemptInProgress: false,
      exhausted: false,
      requireLogin: false,
      attemptsCreated: 0,
      continueClicks: 0,
      finalSubmits: 0,
      savedAnswer: ''
    };
  });

  function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      allowedHosts: ['127.0.0.1'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' },
      ...overrides
    };
  }

  test('START-01: Unknown/unlabeled quiz scope with "Attempt quiz now" -> halts NEEDS_REVIEW with 0 attempts started', async () => {
    const taskId = 'start-01-unknown-scope';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      // Even with PRACTICE_ASSISTED + confirmStartNewAttempt, unlabeled non-practice quiz must NOT start!
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-02: Graded / Midterm / Final exam or ASSESSMENT_RESTRICTED mode -> halts NEEDS_REVIEW with 0 attempts started', async () => {
    const taskId = 'start-02-graded-exam';
    await clearCheckpoint(taskId);
    scenario.heading = 'Midterm Exam — Data Structures (Kiểm tra giữa kỳ)';
    scenario.subtitle = 'Attempts allowed: 1';
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.ok(res.warnings.some(w => /ASSESSMENT_RESTRICTED/i.test(w)));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-03: READ_ONLY mode observes metadata and deadlines without starting attempts or filling fields', async () => {
    const taskId = 'start-03-readonly';
    await clearCheckpoint(taskId);
    scenario.heading = 'Practice Quiz: Trees';
    scenario.subtitle = 'Permitted self-practice';
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          aiPermitted: true,
          mode: 'READ_ONLY',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0);
      assert.equal(res.questionsFilled, 0);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.ok(res.deadline?.startsWith('2026-11-14'), 'READ_ONLY mode must still observe deadlines');
      assert.ok(res.warnings.some(w => w.includes('[READ_ONLY]')));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-04: Verified PRACTICE_ASSISTED quiz WITHOUT explicit confirmStartNewAttempt -> halts NEEDS_REVIEW (AWAITING_START_CONFIRMATION)', async () => {
    const taskId = 'start-04-unconfirmed-practice';
    await clearCheckpoint(taskId);
    scenario.heading = 'Practice Quiz: Graph Traversal';
    scenario.subtitle = 'Ungraded self-practice';
    const ctx = await browser.newContext();
    try {
      let promptCalled = false;
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Practice Quiz: Graph Traversal',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED'
        },
        makeConfig({
          confirmAttemptStart: async () => {
            promptCalled = true;
            return false;
          }
        })
      );
      assert.equal(promptCalled, true, 'Runtime confirmation callback must be consulted');
      assert.equal(scenario.attemptsCreated, 0);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.ok(res.warnings.some(w => w.includes('AWAITING_START_CONFIRMATION')));

      // Also verify low-level revealStart() refuses to click "Attempt quiz now" by default
      await assert.doesNotReject(async () => {
        const clicked = await revealStart(res.page!, ['127.0.0.1']);
        assert.equal(clicked, false, 'Default revealStart() without allowNewAttempt:true must return false');
      });
      assert.equal(scenario.attemptsCreated, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-05 & START-10: Verified PRACTICE_ASSISTED quiz WITH explicit confirmation starts 1 attempt, fills draft, and stops before final submit', async () => {
    const taskId = 'start-05-confirmed-practice';
    await clearCheckpoint(taskId);
    scenario.heading = 'Self-Practice Quiz: Binary Search';
    scenario.subtitle = 'Grading: Ungraded practice';
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Self-Practice Quiz: Binary Search',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED'
        },
        makeConfig({
          confirmAttemptStart: async info => info.buttonLabel === 'Attempt quiz now'
        })
      );
      assert.equal(scenario.attemptsCreated, 1, 'Exactly 1 new practice attempt started');
      assert.equal(res.questionsFound, 1);
      assert.equal(res.questionsFilled, 1);
      assert.equal(res.status, 'READY_FOR_REVIEW');
      assert.equal(scenario.finalSubmits, 0, 'START-10: Must NEVER auto-submit final quiz attempt');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-06: Already-open self-practice attempt ("Continue the last attempt") resumes without creating a new attempt', async () => {
    const taskId = 'start-06-continue-open';
    await clearCheckpoint(taskId);
    scenario.heading = 'Self-Practice Quiz: Binary Search';
    scenario.subtitle = 'Ungraded practice';
    scenario.openAttemptInProgress = true;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Self-Practice Quiz: Binary Search',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: false
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0, 'Must NOT call startattempt.php when continuing open attempt');
      assert.equal(scenario.continueClicks, 1, 'Must follow "Continue the last attempt"');
      assert.equal(res.questionsFilled, 1);
      assert.equal(res.status, 'READY_FOR_REVIEW');
      assert.equal(scenario.finalSubmits, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-07: Resume when session expired (login screen) -> returns WAITING_FOR_AUTH with 0 new attempts', async () => {
    const taskId = 'start-07-expired-session';
    scenario.heading = 'Self-Practice Quiz: Binary Search';
    scenario.openAttemptInProgress = true;
    scenario.requireLogin = true;
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
      currentStepUrl: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=501&cmid=12&page=0`,
      status: 'RUNNING',
      stepsCompleted: 0,
      domFilledSteps: 1,
      serverSavedSteps: 0,
      totalSteps: 2,
      questionsFound: 1,
      questionsFilled: 1,
      answersByStep: { 1: { m1: { text: 'O(log n)' } } },
      lastUpdated: new Date().toISOString()
    });

    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Self-Practice Quiz: Binary Search',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(res.status, 'WAITING_FOR_AUTH');
      assert.equal(scenario.attemptsCreated, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-08: Resume when previous open attempt is missing/closed on server and page shows "Attempt quiz now" -> halts NEEDS_REVIEW (0 duplicate attempts)', async () => {
    const taskId = 'start-08-missing-open-attempt';
    scenario.heading = 'Self-Practice Quiz: Binary Search';
    scenario.subtitle = 'Ungraded practice';
    scenario.openAttemptInProgress = false; // Server attempt 501 disappeared/closed!

    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
      currentStepUrl: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=501&cmid=12&page=0`,
      status: 'RUNNING',
      stepsCompleted: 1,
      domFilledSteps: 1,
      serverSavedSteps: 1,
      totalSteps: 2,
      questionsFound: 1,
      questionsFilled: 1,
      answersByStep: { 1: { m1: { text: 'O(log n)' } } },
      lastUpdated: new Date().toISOString()
    });

    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Self-Practice Quiz: Binary Search',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0, 'Must NEVER create a duplicate attempt during checkpoint resume');
      assert.equal(res.status, 'NEEDS_REVIEW');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('START-09: Exhausted quiz attempts ("No more attempts are allowed" / Finished) -> halts NEEDS_REVIEW with 0 starts', async () => {
    const taskId = 'start-09-exhausted';
    await clearCheckpoint(taskId);
    scenario.heading = 'Self-Practice Quiz: Binary Search';
    scenario.exhausted = true;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=12`,
          title: 'Self-Practice Quiz: Binary Search',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true
        },
        makeConfig()
      );
      assert.equal(scenario.attemptsCreated, 0);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.match(res.scoreObserved || '', /8\.50\s*\/\s*10\.00/);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });
});
