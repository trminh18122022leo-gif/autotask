/** Phase 5 — Network-Level & Action-URL Audit for READ_ONLY Mode (RO-NET-01..06)
 *
 * Verifies that READ_ONLY is strictly read-only at the HTTP/network, action-URL,
 * DOM-interaction, and script-execution levels against a local HTTP server with
 * granular server-side request and mutation counters.
 */
import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import { discoverActivities, safeLink } from '../src/discovery.js';
import { isStateMutatingActionUrl } from '../src/operation-mode.js';
import { clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

interface ServerAuditCounters {
  getRequests: number;
  postRequests: number;
  putPatchDeleteRequests: number;
  newAttemptsCreated: number;
  draftWrites: number;
  finalSubmits: number;
  stateMutations: number;
  requestsLog: { method: string; pathname: string; query: string }[];
}

describe('Phase 5 — READ_ONLY Network & Action URL Audit (RO-NET-01..06)', () => {
  let browser: Browser;
  let server: Server;
  let port = 0;

  const counters: ServerAuditCounters = {
    getRequests: 0,
    postRequests: 0,
    putPatchDeleteRequests: 0,
    newAttemptsCreated: 0,
    draftWrites: 0,
    finalSubmits: 0,
    stateMutations: 0,
    requestsLog: []
  };

  before(async () => {
    browser = await chromium.launch({ headless: true });

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const method = (req.method || 'GET').toUpperCase();
      counters.requestsLog.push({ method, pathname: u.pathname, query: u.search });

      if (method === 'GET') counters.getRequests++;
      else if (method === 'POST') counters.postRequests++;
      else counters.putPatchDeleteRequests++;

      const headers = { 'Content-Type': 'text/html; charset=utf-8' };

      // 1. Mutating endpoints (must NEVER be hit by READ_ONLY!)
      if (u.pathname === '/mod/quiz/startattempt.php') {
        counters.newAttemptsCreated++;
        counters.stateMutations++;
        res.writeHead(303, { Location: `/mod/quiz/attempt.php?attempt=101&page=0` });
        res.end();
        return;
      }
      if (u.pathname === '/mod/quiz/processattempt.php') {
        counters.draftWrites++;
        counters.stateMutations++;
        res.writeHead(200, headers);
        res.end('Draft saved');
        return;
      }
      if (u.pathname === '/api/background-write') {
        counters.stateMutations++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mutated: true }));
        return;
      }

      // 2. Overview / read-only pages
      if (u.pathname === '/mod/quiz/view.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Quiz Overview</title></head>
          <body class="path-mod-quiz moodle">
            <h2>Practice Quiz: Sorting</h2>
            <div class="activity-dates">Closed: Saturday, 14 November 2026, 11:59 PM</div>
            <p>Ungraded permitted self-practice</p>
            <form method="post" action="/mod/quiz/startattempt.php">
              <input type="hidden" name="cmid" value="55">
              <button type="submit" class="btn btn-primary">Attempt quiz now</button>
            </form>
          </body></html>`);
        return;
      }

      // 3. Impure page containing a background auto-save script that attempts POST
      if (u.pathname === '/mod/quiz/impure-page.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><title>Impure Page</title></head><body>
          <h2>Impure Activity</h2>
          <p>This page contains an automated background telemetry script that attempts POST.</p>
          <script>
            // Attempts write via fetch after DOM load
            setTimeout(() => {
              fetch('/api/background-write', { method: 'POST', body: JSON.stringify({ tick: Date.now() }) })
                .catch(() => {});
            }, 50);
          </script>
        </body></html>`);
        return;
      }

      // 4. Discovery course page containing both safe activity links and mutating action links
      if (u.pathname === '/course/view.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><title>Course 101</title></head><body>
          <h2>Data Structures</h2>
          <div class="due-date">Hạn nộp: 15/11/2026 23:59</div>
          <ul>
            <li><a href="/mod/quiz/view.php?id=55">Practice Quiz: Sorting</a></li>
            <li><a href="/mod/assign/view.php?id=56">Homework 1</a></li>
            <!-- Dangerous action links that must be rejected by safeLink() -->
            <li><a href="/mod/quiz/startattempt.php?cmid=55">Start attempt</a></li>
            <li><a href="/mod/quiz/processattempt.php?attempt=1&action=delete">Delete attempt</a></li>
            <li><a href="/course/unenrol.php?id=101">Unenrol me</a></li>
            <li><a href="/login/logout.php?sesskey=abc">Log out</a></li>
          </ul>
        </body></html>`);
        return;
      }

      // 5. SSO entrypoint that issues safe 302 redirect
      if (u.pathname === '/sso/login') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body><h2>SSO CAS Login</h2><form action="/sso/login" method="post"><input type="text" name="u"><input type="password" name="p"></form></body></html>`);
        return;
      }
      if (u.pathname === '/sso-protected') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/sso/login` });
        res.end();
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
    await new Promise<void>(r => server.close(() => r()));
    await browser?.close();
  });

  beforeEach(() => {
    counters.getRequests = 0;
    counters.postRequests = 0;
    counters.putPatchDeleteRequests = 0;
    counters.newAttemptsCreated = 0;
    counters.draftWrites = 0;
    counters.finalSubmits = 0;
    counters.stateMutations = 0;
    counters.requestsLog = [];
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
      operationMode: 'READ_ONLY',
      ...overrides
    };
  }

  test('RO-NET-01: READ_ONLY mode observes quiz overview with strictly 0 POSTs, 0 attempts, 0 draft writes, 0 mutations', async () => {
    const taskId = 'ro-net-01-overview';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=55`,
          title: 'Practice Quiz: Sorting',
          aiPermitted: true,
          mode: 'READ_ONLY'
        },
        makeConfig()
      );

      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFilled, 0);
      assert.ok(res.deadline?.startsWith('2026-11-14'), 'Must still extract deadlines');

      // Server-side audit verification
      assert.equal(counters.postRequests, 0, 'Must send ZERO POST requests in READ_ONLY');
      assert.equal(counters.putPatchDeleteRequests, 0, 'Must send ZERO PUT/PATCH/DELETE');
      assert.equal(counters.newAttemptsCreated, 0, 'Must create ZERO quiz attempts');
      assert.equal(counters.draftWrites, 0, 'Must perform ZERO draft writes');
      assert.equal(counters.finalSubmits, 0, 'Must perform ZERO final submits');
      assert.equal(counters.stateMutations, 0, 'Must cause ZERO server state mutations');
      assert.ok(counters.getRequests > 0, 'GET requests for reading page are allowed');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('RO-NET-02: Task URL pointing directly to state-mutating endpoint (/startattempt.php) is blocked BEFORE resilientGoto (0 requests sent)', async () => {
    const taskId = 'ro-net-02-direct-action-url';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      const dangerousUrl = `http://127.0.0.1:${port}/mod/quiz/startattempt.php?cmid=55`;
      assert.equal(isStateMutatingActionUrl(dangerousUrl), true, 'Detector must recognise startattempt.php as mutating action URL');

      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: dangerousUrl,
          title: 'Direct Start Attempt',
          aiPermitted: true,
          mode: 'READ_ONLY'
        },
        makeConfig()
      );

      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.ok(res.warnings.some(w => w.includes('Chặn điều hướng tới URL có thể thay đổi trạng thái')));
      // Verification: server NEVER received any request at all for startattempt.php
      assert.equal(
        counters.requestsLog.filter(r => r.pathname.includes('startattempt.php')).length,
        0,
        'Navigation to startattempt.php must be aborted before reaching the network'
      );
      assert.equal(counters.newAttemptsCreated, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('RO-NET-03: Impure page with background fetch POST script is intercepted by network route guard; server receives 0 POSTs and task flagged', async () => {
    const taskId = 'ro-net-03-impure-script';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/impure-page.php`,
          title: 'Impure Page',
          aiPermitted: true,
          mode: 'READ_ONLY'
        },
        makeConfig()
      );

      // Route guard must have caught and aborted the background POST
      assert.equal(counters.postRequests, 0, 'Server must have received 0 POST requests from background script');
      assert.equal(counters.stateMutations, 0, '0 mutations occurred on server');
      assert.ok(res.readOnlyBlockedRequests && res.readOnlyBlockedRequests.length > 0, 'Blocked requests must be logged');
      assert.ok(res.readOnlyBlockedRequests[0].includes('POST'), 'Must record the attempted POST method');
      assert.ok(res.warnings.some(w => w.includes('[READ_ONLY_WRITE_BLOCKED]')));
      assert.equal(res.status, 'NEEDS_REVIEW', 'Impure page must halt at NEEDS_REVIEW, never reported as purely read');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('RO-NET-04: discoverActivities() filters mutating links via safeLink() and issues 0 POSTs', async () => {
    const ctx = await browser.newContext();
    try {
      // Direct safeLink verification on mutating URLs
      assert.equal(safeLink(`http://127.0.0.1:${port}/mod/quiz/startattempt.php?cmid=55`, `http://127.0.0.1:${port}`, ['127.0.0.1']), null);
      assert.equal(safeLink(`http://127.0.0.1:${port}/mod/quiz/processattempt.php?action=delete`, `http://127.0.0.1:${port}`, ['127.0.0.1']), null);
      assert.equal(safeLink(`http://127.0.0.1:${port}/course/unenrol.php?id=101`, `http://127.0.0.1:${port}`, ['127.0.0.1']), null);
      assert.equal(safeLink(`http://127.0.0.1:${port}/login/logout.php?sesskey=abc`, `http://127.0.0.1:${port}`, ['127.0.0.1']), null);

      // Safe activity links survive
      const safeActivity = safeLink(`http://127.0.0.1:${port}/mod/quiz/view.php?id=55`, `http://127.0.0.1:${port}`, ['127.0.0.1']);
      assert.ok(safeActivity && safeActivity.includes('/mod/quiz/view.php'));

      // Run discoverActivities
      const report = await discoverActivities(ctx, [`http://127.0.0.1:${port}/course/view.php`], ['127.0.0.1'], 5);
      assert.equal(counters.postRequests, 0, 'Discovery must never issue POST requests');
      assert.equal(counters.stateMutations, 0);
      assert.equal(counters.newAttemptsCreated, 0);

      // Discovered activities should include the safe quiz view and assignment, but zero start/delete/unenrol links
      assert.ok(report.activities.some(a => a.url.includes('/mod/quiz/view.php?id=55')));
      assert.ok(report.activities.every(a => !a.url.includes('startattempt') && !a.url.includes('unenrol') && !a.url.includes('logout')));
    } finally {
      await ctx.close();
    }
  });

  test('RO-NET-05: Valid SSO 302 redirect follows safe GET navigation and halts at WAITING_FOR_AUTH with 0 POSTs', async () => {
    const taskId = 'ro-net-05-sso';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/sso-protected`,
          title: 'SSO Protected Activity',
          aiPermitted: true,
          mode: 'READ_ONLY'
        },
        makeConfig({ authUrls: [`http://127.0.0.1:${port}/sso/login`] })
      );

      assert.equal(res.status, 'WAITING_FOR_AUTH');
      assert.equal(counters.postRequests, 0, 'SSO navigation must NOT submit login credentials automatically');
      assert.equal(counters.stateMutations, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('RO-NET-06: Global READ_ONLY cannot be overridden by task mode=PRACTICE_ASSISTED or confirmStartNewAttempt=true on network level', async () => {
    const taskId = 'ro-net-06-escalation-attempt';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();
    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=55`,
          title: 'Practice Quiz: Sorting',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED', // Task attempts escalation...
          confirmStartNewAttempt: true
        },
        makeConfig({ operationMode: 'READ_ONLY' }) // ...but global is READ_ONLY!
      );

      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(counters.postRequests, 0);
      assert.equal(counters.newAttemptsCreated, 0);
      assert.equal(counters.stateMutations, 0);
      assert.ok(res.warnings.some(w => w.includes('[READ_ONLY]')));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });
});
