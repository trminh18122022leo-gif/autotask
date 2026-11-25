/** Phase 3 — Direct Attempt URL Protection & Resume Policy Gate (DIRECT-01..09)
 * Verifies that opening direct `/mod/quiz/attempt.php` URLs or resuming checkpoints
 * NEVER bypasses the unified policy gate to reach solving/filling.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import { saveCheckpoint, clearCheckpoint } from '../src/task-manager.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import type { AppConfig, Question } from '../src/types.js';

describe('Phase 3 — Direct Attempt URL Protection (DIRECT-01..09)', () => {
  let browser: Browser;
  let server: Server;
  let port = 0;
  const origExecute = ModelRouter.execute;

  let modelCalls = 0;
  let serverDraftPosts = 0;

  before(async () => {
    browser = await chromium.launch({ headless: true });

    ModelRouter.execute = (async (req: any) => {
      modelCalls++;
      const parsed = JSON.parse(req.text) as { questions: Question[] };
      const answers = parsed.questions.map(q => ({ id: q.id, text: 'Answer42', confidence: 0.95 }));
      return {
        output: JSON.stringify({ answers }),
        initialProfile: 'direct-gate-test',
        finalProfile: 'direct-gate-test',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }) as typeof ModelRouter.execute;

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };

      if (u.pathname === '/login/index.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body><h2>Login</h2><form action="/login"><input type="text" name="username"><input type="password" name="password"></form></body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/processattempt.php' && req.method === 'POST') {
        serverDraftPosts++;
        res.writeHead(303, { Location: `/mod/quiz/attempt.php?attempt=11&page=1` });
        res.end();
        return;
      }

      if (u.pathname === '/mod/quiz/review.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body><h2>Review attempt</h2><p>State: Finished</p><p>Final grade: 9/10</p></body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/attempt.php') {
        const scenario = u.searchParams.get('scenario') || 'normal';

        if (scenario === 'expired') {
          res.writeHead(302, { Location: '/login/index.php' });
          res.end();
          return;
        }

        res.writeHead(200, headers);

        if (scenario === 'graded') {
          res.end(`<!DOCTYPE html><html><head><title>Midterm Exam 1</title></head>
            <body class="path-mod-quiz moodle">
              <h2>Midterm Exam 1</h2>
              <div class="quizinfo"><p>Grading method: Highest grade</p><p>Grade to pass: 8.00 / 10.00</p><p>Attempts allowed: 1</p></div>
              <form action="/mod/quiz/processattempt.php" method="post">
                <div class="que shortanswer" id="q1"><div class="qtext">Question 1</div><input type="text" name="q1_answer"></div>
              </form>
            </body></html>`);
          return;
        }

        if (scenario === 'finished') {
          res.end(`<!DOCTYPE html><html><head><title>Quiz Attempt Review</title></head>
            <body class="path-mod-quiz moodle">
              <h2>Quiz Attempt</h2>
              <table class="generaltable"><tr><th>State</th><td>Finished</td></tr></table>
              <div class="que shortanswer" id="q1"><div class="qtext">Question 1</div><input type="text" name="q1_answer" disabled></div>
            </body></html>`);
          return;
        }

        if (scenario === 'practice') {
          res.end(`<!DOCTYPE html><html><head><title>Self-Practice Quiz: Sorting</title></head>
            <body class="path-mod-quiz moodle">
              <h2>Self-Practice Quiz: Sorting</h2>
              <div class="quizinfo"><p>Ungraded permitted self-practice — 0 points</p></div>
              <form action="/mod/quiz/processattempt.php" method="post">
                <div class="que shortanswer" id="q1"><div class="qtext">What is quicksort average complexity?</div><input type="text" name="q1_answer"></div>
              </form>
            </body></html>`);
          return;
        }

        // Default direct attempt with questions on DOM but without practice scope on page
        res.end(`<!DOCTYPE html><html><head><title>Quiz: Chapter 5 Attempt</title></head>
          <body class="path-mod-quiz moodle">
            <h2>Quiz: Chapter 5 Attempt</h2>
            <form action="/mod/quiz/processattempt.php" method="post">
              <div class="que shortanswer" id="q1"><div class="qtext">Generic Question 1</div><input type="text" name="q1_answer"></div>
            </form>
          </body></html>`);
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

  function makeCfg(overrides: Partial<AppConfig> = {}): AppConfig {
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

  test('DIRECT-01: Direct attempt URL with mode UNSET -> halts NEEDS_REVIEW with 0 model calls and 0 fills', async () => {
    const taskId = 'direct-01-mode-unset';
    await clearCheckpoint(taskId);
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        { id: taskId, url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=11&page=0`, aiPermitted: true },
        makeCfg() // operationMode unset
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0, 'Must NOT invoke AI solver when mode is unset on direct attempt URL');
      assert.ok(res.warnings.some(w => w.includes('ATTEMPT_GATE:MODE_NOT_PRACTICE_ASSISTED')));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-02: Direct attempt URL of a graded quiz -> halts NEEDS_REVIEW (ASSESSMENT_RESTRICTED) even with mode=PRACTICE_ASSISTED', async () => {
    const taskId = 'direct-02-graded-direct';
    await clearCheckpoint(taskId);
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=graded&attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0, 'Must NOT invoke AI solver on graded direct quiz attempt');
      assert.ok(res.warnings.some(w => /ASSESSMENT_RESTRICTED/i.test(w)));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-03: Direct attempt URL with wrong-origin or unverified checkpoint -> halts NEEDS_REVIEW', async () => {
    const taskId = 'direct-03-bad-cp';
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=11&page=0`,
      status: 'RUNNING',
      stepsCompleted: 0,
      questionsFound: 1,
      questionsFilled: 0,
      // Checkpoint from a different origin or missing scopeVerified!
      scopeVerified: { scope: 'PRACTICE_VERIFIED', mode: 'PRACTICE_ASSISTED', origin: 'http://other-host.example.com', verifiedAt: new Date().toISOString() },
      lastUpdated: new Date().toISOString()
    });
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-04: Authorized practice attempt with valid checkpoint and scopeAttestation -> solves and fills safely', async () => {
    const taskId = 'direct-04-authorized';
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=practice&attempt=11&page=0`,
      status: 'RUNNING',
      stepsCompleted: 0,
      questionsFound: 1,
      questionsFilled: 0,
      scopeVerified: { scope: 'PRACTICE_VERIFIED', mode: 'PRACTICE_ASSISTED', origin: `http://127.0.0.1:${port}`, verifiedAt: new Date().toISOString() },
      lastUpdated: new Date().toISOString()
    });
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=practice&attempt=11&page=0`,
          title: 'Self-Practice Quiz: Sorting',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          scopeAttestation: 'PERMITTED_SELF_PRACTICE'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.questionsFound, 1);
      assert.equal(res.questionsFilled, 1);
      assert.equal(modelCalls, 1, 'Authorized practice attempt invokes AI solver');
      assert.equal(res.status, 'READY_FOR_REVIEW');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-05: Direct attempt URL when session expired -> returns WAITING_FOR_AUTH with 0 fills', async () => {
    const taskId = 'direct-05-session-expired';
    await clearCheckpoint(taskId);
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=expired&attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          scopeAttestation: 'PERMITTED_SELF_PRACTICE'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.status, 'WAITING_FOR_AUTH');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-06: Direct attempt URL when attempt is already finished -> halts NEEDS_REVIEW (ATTEMPT_FINISHED)', async () => {
    const taskId = 'direct-06-finished';
    await clearCheckpoint(taskId);
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=finished&attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          scopeAttestation: 'PERMITTED_SELF_PRACTICE'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0);
      assert.ok(res.warnings.some(w => w.includes('ATTEMPT_GATE:ATTEMPT_FINISHED')));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-07: Direct attempt scope changed to graded midterm after restart -> halts NEEDS_REVIEW', async () => {
    const taskId = 'direct-07-scope-tampered';
    // Old checkpoint claimed practice scope
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=graded&attempt=11&page=0`,
      status: 'RUNNING',
      stepsCompleted: 0,
      questionsFound: 1,
      questionsFilled: 0,
      scopeVerified: { scope: 'PRACTICE_VERIFIED', mode: 'PRACTICE_ASSISTED', origin: `http://127.0.0.1:${port}`, verifiedAt: new Date().toISOString() },
      lastUpdated: new Date().toISOString()
    });
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      // Live DOM now shows graded midterm!
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=graded&attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED'
        },
        makeCfg({ operationMode: 'PRACTICE_ASSISTED' })
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0, 'Tampered scope must NOT solve');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-08: Crash/restart under global READ_ONLY refuses to resume or fill', async () => {
    const taskId = 'direct-08-restart-ro';
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=practice&attempt=11&page=0`,
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q1: { text: 'Quicksort' } },
      lastUpdated: new Date().toISOString()
    });
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?scenario=practice&attempt=11&page=0`,
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED' // Task tries to request PRACTICE_ASSISTED...
        },
        makeCfg({ operationMode: 'READ_ONLY' }) // ...but global is READ_ONLY!
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.equal(modelCalls, 0);
      assert.ok(res.warnings.some(w => w.includes('[READ_ONLY]')));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('DIRECT-09: Crash/restart under unknown scope halts with NEEDS_REVIEW and 0 duplicate attempts', async () => {
    const taskId = 'direct-09-restart-unknown';
    await saveCheckpoint({
      taskId,
      url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=11&page=0`,
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q1: { text: 'Some answer' } },
      lastUpdated: new Date().toISOString()
    });
    modelCalls = 0;
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/attempt.php?attempt=11&page=0`,
          aiPermitted: true
          // mode unset
        },
        makeCfg() // global unset
      );
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(modelCalls, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });
});
