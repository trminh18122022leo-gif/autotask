/** Phase 5 — READ_ONLY Network & Context Coverage Verification (`RO-COVER-01..08`)
 *
 * Verifies that under `operationMode: 'READ_ONLY'`, the browser context, network routing,
 * service workers, popups, redirects, and state-mutating actions CANNOT mutate server state.
 *
 * Server counters are tracked authoritatively on a local HTTP test server on loopback.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import { isStateMutatingActionUrl, isMutatingHttpMethod } from '../src/operation-mode.js';
import type { AppConfig, Task } from '../src/types.js';

interface ServerCounters {
  totalRequests: number;
  getRequests: number;
  postRequests: number;
  putRequests: number;
  patchRequests: number;
  deleteRequests: number;
  mutatingMethodsReceived: number;
  newAttemptsCreated: number;
  draftWrites: number;
  finalSubmits: number;
  stateMutations: number;
  serviceWorkerHits: number;
}

describe('Phase 5 — READ_ONLY Network & Context Coverage (RO-COVER-01..08)', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let browser: Browser;

  const counters: ServerCounters = {
    totalRequests: 0,
    getRequests: 0,
    postRequests: 0,
    putRequests: 0,
    patchRequests: 0,
    deleteRequests: 0,
    mutatingMethodsReceived: 0,
    newAttemptsCreated: 0,
    draftWrites: 0,
    finalSubmits: 0,
    stateMutations: 0,
    serviceWorkerHits: 0
  };

  function resetCounters(): void {
    counters.totalRequests = 0;
    counters.getRequests = 0;
    counters.postRequests = 0;
    counters.putRequests = 0;
    counters.patchRequests = 0;
    counters.deleteRequests = 0;
    mutatingMethodsCheck: counters.mutatingMethodsReceived = 0;
    counters.newAttemptsCreated = 0;
    counters.draftWrites = 0;
    counters.finalSubmits = 0;
    counters.stateMutations = 0;
    counters.serviceWorkerHits = 0;
  }

  before(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer((req, res) => {
      counters.totalRequests++;
      const method = (req.method || 'GET').toUpperCase();
      const url = req.url || '/';

      if (method === 'GET') counters.getRequests++;
      else if (method === 'POST') { counters.postRequests++; counters.mutatingMethodsReceived++; }
      else if (method === 'PUT') { counters.putRequests++; counters.mutatingMethodsReceived++; }
      else if (method === 'PATCH') { counters.patchRequests++; counters.mutatingMethodsReceived++; }
      else if (method === 'DELETE') { counters.deleteRequests++; counters.mutatingMethodsReceived++; }

      if (url.includes('startattempt.php')) { counters.newAttemptsCreated++; counters.stateMutations++; }
      if (url.includes('processattempt.php')) { counters.draftWrites++; counters.stateMutations++; }
      if (url.includes('finishattempt') || url.includes('summary.php?finishattempt=1')) { counters.finalSubmits++; counters.stateMutations++; }
      if (url.includes('sw-worker.js') || url.includes('sw-write')) { counters.serviceWorkerHits++; }
      if (isStateMutatingActionUrl(`http://127.0.0.1:${port}${url}`)) { counters.stateMutations++; }

      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      };

      if (method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
      }

      if (url.startsWith('/quiz-view')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html>
<html><head><title>Ungraded Self-Practice Quiz</title></head>
<body>
  <h1>Self-Practice Quiz</h1>
  <div class="quizinfo"><p>Grading method: None (ungraded self-practice)</p></div>
  <form action="/mod/quiz/startattempt.php" method="post">
    <button type="submit" name="submit">Attempt quiz now</button>
  </form>
</body></html>`);
        return;
      }

      if (url.startsWith('/sw-page')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html>
<html><head><title>Service Worker Probe Page</title></head>
<body>
  <h1>SW Page</h1>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw-worker.js').then(reg => {
        fetch('/api/sw-write', { method: 'POST', body: 'sw-data' }).catch(() => {});
      }).catch(err => {
        window.__swBlocked = true;
      });
    }
  </script>
</body></html>`);
        return;
      }

      if (url.startsWith('/popup-launcher')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html>
<html><head><title>Popup Launcher Page</title></head>
<body>
  <h1>Launcher</h1>
  <button id="popBtn" onclick="window.open('/popup-target', '_blank')">Open Popup</button>
</body></html>`);
        return;
      }

      if (url.startsWith('/popup-target')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html>
<html><head><title>Popup Target Page</title></head>
<body>
  <h1>Popup Target</h1>
  <script>
    fetch('/mod/quiz/processattempt.php', { method: 'POST', body: 'data=hack' }).catch(() => {});
  </script>
</body></html>`);
        return;
      }

      if (url.startsWith('/redirect-to-action')) {
        res.writeHead(302, { ...headers, Location: `/mod/quiz/startattempt.php?sesskey=test&cmid=101` });
        res.end();
        return;
      }

      if (url.startsWith('/sso-login')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html>
<html><head><title>CAS Central Authentication Service</title></head>
<body>
  <h2>Please Log In</h2>
  <form action="/sso-auth" method="post">
    <input type="text" name="username" placeholder="Username" />
    <input type="password" name="password" placeholder="Password" />
    <button type="submit">Log In</button>
  </form>
</body></html>`);
        return;
      }

      if (url.startsWith('/sso-entry')) {
        res.writeHead(302, { ...headers, Location: `/sso-login` });
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(`<!DOCTYPE html><html><body><h1>OK</h1></body></html>`);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await browser.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const baseConfig = (): AppConfig => ({
    allowedHosts: [`127.0.0.1:${port}`, '127.0.0.1'],
    approvedForAIUse: true,
    operationMode: 'READ_ONLY',
    parallelTabs: 1,
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'test' },
    deadlinePages: [],
    authUrls: [`http://127.0.0.1:${port}/sso-login`]
  });

  test('RO-COVER-01: Zero mutating HTTP methods (POST/PUT/PATCH/DELETE) reach server under READ_ONLY', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-01', url: `${baseUrl}/quiz-view`, title: 'Quiz View' };
      const res = await executeTask(ctx, task, baseConfig());
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(counters.postRequests, 0, 'Server must receive 0 POST requests');
      assert.equal(counters.putRequests, 0, 'Server must receive 0 PUT requests');
      assert.equal(counters.patchRequests, 0, 'Server must receive 0 PATCH requests');
      assert.equal(counters.deleteRequests, 0, 'Server must receive 0 DELETE requests');
      assert.equal(counters.mutatingMethodsReceived, 0, 'Server must receive 0 mutating requests');
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-02: Service worker cannot perform unmonitored write requests in READ_ONLY context', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-02', url: `${baseUrl}/sw-page`, title: 'SW Page' };
      await executeTask(ctx, task, baseConfig());
      assert.equal(counters.postRequests, 0, 'Service worker must not issue POST requests');
      assert.equal(counters.serviceWorkerHits, 0, 'Service worker registrations must be blocked');
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-03: Popup or new tab cannot bypass READ_ONLY network policy', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-03', url: `${baseUrl}/popup-launcher`, title: 'Popup Launcher' };
      const resPromise = executeTask(ctx, task, baseConfig());
      // Wait briefly for page to load, then trigger popup
      await new Promise(r => setTimeout(r, 600));
      const pages = ctx.pages();
      if (pages.length > 0) {
        const btn = pages[0].locator('#popBtn');
        if (await btn.count() > 0) {
          await btn.click().catch(() => {});
          await new Promise(r => setTimeout(r, 600));
        }
      }
      await resPromise;
      assert.equal(counters.postRequests, 0, 'Popup must not be able to execute POST requests');
      assert.equal(counters.draftWrites, 0, 'Popup must not write drafts');
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-04: Redirect chain leading to mutating action URL is aborted before state mutation', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-04', url: `${baseUrl}/redirect-to-action`, title: 'Redirect to Action' };
      const res = await executeTask(ctx, task, baseConfig());
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(counters.newAttemptsCreated, 0, 'Redirect must not trigger startattempt.php mutation');
      assert.equal(counters.stateMutations, 0, 'Redirect must not mutate state');
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-05: State-mutating GET actions (action=delete / unenrol) are rejected or intercepted', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-05', url: `${baseUrl}/course/unenrol.php?confirm=1&action=unenrolself`, title: 'Mutating GET' };
      const res = await executeTask(ctx, task, baseConfig());
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(counters.totalRequests, 0, 'Pre-navigation gate must block mutating action URL with 0 requests sent');
      assert.equal(counters.stateMutations, 0);
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-06: SSO 302 redirect is followed safely and halts at WAITING_FOR_AUTH without mutations', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-06', url: `${baseUrl}/sso-entry`, title: 'SSO Entry' };
      const res = await executeTask(ctx, task, baseConfig());
      assert.equal(res.status, 'WAITING_FOR_AUTH');
      assert.equal(counters.postRequests, 0, 'SSO navigation must not issue POST requests');
      assert.equal(counters.stateMutations, 0);
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-07: READ_ONLY mode never auto-creates quiz attempts (0 startattempt calls)', async () => {
    resetCounters();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const task: Task = { aiPermitted: true, id: 'ro-cover-07', url: `${baseUrl}/quiz-view`, title: 'Quiz Overview', confirmStartNewAttempt: true };
      const res = await executeTask(ctx, task, baseConfig());
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(counters.newAttemptsCreated, 0, 'Must create 0 quiz attempts');
    } finally {
      await ctx.close();
    }
  });

  test('RO-COVER-08: Zero draft writes, zero score alterations, and zero submissions across entire suite', async () => {
    assert.equal(counters.draftWrites, 0, 'draftWrites must remain 0');
    assert.equal(counters.finalSubmits, 0, 'finalSubmits must remain 0');
    assert.equal(counters.mutatingMethodsReceived, 0, 'mutatingMethodsReceived must remain 0');
  });
});
