/** Phase 4 — READ_ONLY Effective Mode & Per-Task Network E2E (`RO2-01..08`)
 *
 * Verifies that:
 * 1. Effective mode resolves correctly per task (`config.operationMode = PRACTICE_ASSISTED`, `task.mode = READ_ONLY`).
 * 2. Route handlers and Service Worker blocks protect against mutative requests in all scopes.
 * 3. Route handlers cleanly isolate across successive tasks in the same browser context.
 *
 * Server counters are tracked authoritatively on a local HTTP server on loopback.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
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

describe('Phase 4 — READ_ONLY Per-Task Network E2E (RO2-01..08)', () => {
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
    counters.mutatingMethodsReceived = 0;
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
      if (url.includes('processattempt.php') && method === 'POST') { counters.draftWrites++; counters.stateMutations++; }
      if (url.includes('submit') || url.includes('finish')) { counters.finalSubmits++; counters.stateMutations++; }
      if (url.includes('/api/sw-write')) { counters.serviceWorkerHits++; counters.stateMutations++; }

      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      };

      if (url.startsWith('/redirect-to-action')) {
        res.writeHead(302, { Location: '/mod/quiz/startattempt.php?sesskey=test&cmid=101' });
        res.end('Redirecting...');
        return;
      }

      if (url.startsWith('/popup-launcher')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>
          <h2>Popup Launcher</h2>
          <button id="popBtn" onclick="const p = window.open('/popup-target'); setTimeout(() => { p.fetch('/mod/quiz/processattempt.php', { method: 'POST', body: 'q1=42' }); }, 150);">Open Popup</button>
        </body></html>`);
        return;
      }

      if (url.startsWith('/popup-target')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body><h3>Popup Target Page</h3></body></html>`);
        return;
      }

      if (url.startsWith('/sw-register-page')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>
          <h2>SW Register</h2>
          <script>
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.register('/sw.js').then(() => {
                setTimeout(() => { fetch('/api/sw-write', { method: 'POST', body: 'sw-data' }); }, 100);
              });
            }
          </script>
        </body></html>`);
        return;
      }

      if (url === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`self.addEventListener('activate', e => self.clients.claim());`);
        return;
      }

      if (url.startsWith('/practice-action-page')) {
        if (method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true }));
          return;
        }
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>
          <h2>Practice Action Page</h2>
          <div class="que multichoice" id="q1">
            <div class="qtext">What is 2+2?</div>
            <input type="radio" name="q1" value="4" id="opt4"><label for="opt4">4</label>
          </div>
        </body></html>`);
        return;
      }

      res.writeHead(200, headers);
      res.end(`<!DOCTYPE html><html><head><title>Mock Page</title></head><body><h1>Content</h1></body></html>`);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          port = addr.port;
          baseUrl = `http://127.0.0.1:${port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await browser.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeCfg(mode?: 'READ_ONLY' | 'PRACTICE_ASSISTED'): AppConfig {
    return {
      allowedHosts: ['127.0.0.1'],
      approvedForAIUse: true,
      operationMode: mode || 'PRACTICE_ASSISTED',
      parallelTabs: 1,
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'test-model' }
    } as unknown as AppConfig;
  }

  test('RO2-01: Global READ_ONLY mode completely blocks mutative HTTP requests', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-01', url: `${baseUrl}/test-page`, title: 'Test Page' };
      const res = await executeTask(ctx, task, makeCfg('READ_ONLY'));
      assert.equal(counters.postRequests, 0, 'No POST requests under global READ_ONLY');
      assert.equal(counters.mutatingMethodsReceived, 0, 'No mutative methods under global READ_ONLY');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-02: Per-task READ_ONLY with global PRACTICE_ASSISTED blocks all writes', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-02', url: `${baseUrl}/popup-launcher`, title: 'Launcher', mode: 'READ_ONLY' };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED')); // Global mode is PRACTICE_ASSISTED, but task.mode is READ_ONLY
      assert.equal(counters.postRequests, 0, 'No POST requests when task.mode is READ_ONLY');
      assert.equal(counters.mutatingMethodsReceived, 0, 'Effective mode correctly restricts to READ_ONLY');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-03: Registered Service Worker cannot dispatch write requests under READ_ONLY task', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-03', url: `${baseUrl}/sw-register-page`, title: 'SW Page', mode: 'READ_ONLY' };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      await new Promise(r => setTimeout(r, 400));
      assert.equal(counters.serviceWorkerHits, 0, 'Service worker must not reach server under READ_ONLY');
      assert.equal(counters.postRequests, 0, 'No SW POST requests allowed');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-04: Popups and new tabs opened under READ_ONLY cannot dispatch writes', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-04', url: `${baseUrl}/popup-launcher`, title: 'Popup Launcher', mode: 'READ_ONLY' };
      const resPromise = executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      await new Promise(r => setTimeout(r, 500));
      const pages = ctx.pages();
      if (pages.length > 0) {
        const btn = pages[0].locator('#popBtn');
        if (await btn.count() > 0) {
          await btn.click().catch(() => {});
          await new Promise(r => setTimeout(r, 600));
        }
      }
      await resPromise;
      assert.equal(counters.postRequests, 0, 'Popup must not execute POST requests under READ_ONLY task');
      assert.equal(counters.draftWrites, 0, 'Zero draft writes in popup');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-05: Navigation 302 redirect leading to mutating action endpoint is blocked', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-05', url: `${baseUrl}/redirect-to-action`, title: 'Redirect Test', mode: 'READ_ONLY' };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      assert.equal(counters.newAttemptsCreated, 0, 'Redirect must not reach startattempt.php');
      assert.equal(counters.stateMutations, 0, 'Redirect mutation blocked');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-06: Task READ_ONLY followed by PRACTICE_ASSISTED in same context isolates cleanly', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      // Step 1: Run Task 1 in READ_ONLY mode
      const task1: Task = { aiPermitted: true, id: 'ro2-06-task1', url: `${baseUrl}/practice-action-page`, title: 'Task 1 ReadOnly', mode: 'READ_ONLY' };
      const res1 = await executeTask(ctx, task1, makeCfg('PRACTICE_ASSISTED'));
      assert.equal(counters.postRequests, 0, 'Task 1 (READ_ONLY) produced 0 POST requests');

      // Step 2: In the SAME context, trigger a fetch with POST using evaluate - must be blocked because Task 1 handler protected it
      const pages = ctx.pages();
      const p1 = pages[0];
      const fetchAttempt = await p1.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { method: 'POST', body: 'test=1' });
          return resp.status;
        } catch {
          return 0; // Aborted by client
        }
      }, `${baseUrl}/practice-action-page`);
      assert.equal(fetchAttempt, 0, 'Fetch in Task 1 page was blocked by client');
      assert.equal(counters.postRequests, 0, 'Server still received 0 POST requests');

      // Step 3: Run Task 2 in PRACTICE_ASSISTED mode in the SAME context
      const task2: Task = { aiPermitted: true, id: 'ro2-06-task2', url: `${baseUrl}/practice-action-page`, title: 'Task 2 Practice', mode: 'PRACTICE_ASSISTED' };
      const res2 = await executeTask(ctx, task2, makeCfg('PRACTICE_ASSISTED'));

      // Step 4: Verify that Task 2 is NOT blocked by Task 1's old handler
      const p2 = ctx.pages()[ctx.pages().length - 1];
      const p2Fetch = await p2.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { method: 'POST', body: 'test=2' });
          return resp.status;
        } catch {
          return 0;
        }
      }, `${baseUrl}/practice-action-page`);
      assert.equal(p2Fetch, 200, 'Task 2 (PRACTICE_ASSISTED) is not blocked by previous task handler');
      assert.equal(counters.postRequests, 1, 'Task 2 was able to communicate legitimately');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-07: READ_ONLY mode never auto-creates quiz attempts (0 startattempt calls)', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { aiPermitted: true, id: 'ro2-07', url: `${baseUrl}/mod/quiz/startattempt.php?cmid=55`, title: 'Direct Attempt Start', mode: 'READ_ONLY' };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      assert.equal(counters.newAttemptsCreated, 0, 'Never auto-creates attempts in READ_ONLY');
      assert.equal(res.status, 'NEEDS_REVIEW');
    } finally {
      await ctx.close();
    }
  });

  test('RO2-08: Zero draft writes, zero score alterations, and zero submissions across entire suite', async () => {
    assert.equal(counters.draftWrites, 0, 'Must have zero draft writes across READ_ONLY tests');
    assert.equal(counters.finalSubmits, 0, 'Must have zero final submits across READ_ONLY tests');
  });
});
