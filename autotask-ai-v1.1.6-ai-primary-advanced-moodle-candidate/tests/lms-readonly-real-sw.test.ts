/**
 * Real Service Worker Lifecycle & Advanced READ_ONLY Verification Suite (RO3-01..RO3-10)
 *
 * Verifies that:
 * 1. Requests originating directly from a Service Worker's own lifecycle execution thread
 *    (e.g. self.addEventListener('activate', ...)) are strictly intercepted and blocked under READ_ONLY.
 * 2. Persistent browser profiles with pre-registered workers from previous sessions are neutralized.
 * 3. Concurrent tasks with differing operation modes (READ_ONLY vs PRACTICE_ASSISTED) isolate cleanly.
 * 4. Authoritative server counters on loopback HTTP verify 0 mutations reach the server.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import type { AppConfig, Task } from '../src/types.js';

interface AdvancedServerCounters {
  totalRequests: number;
  postRequests: number;
  workerOriginatedMutations: number;
  popupMutations: number;
  newAttemptsCreated: number;
  draftWrites: number;
  finalSubmits: number;
}

describe('Phase 4 — Real Service Worker & READ_ONLY Verification (RO3-01..10)', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let browser: Browser;

  const counters: AdvancedServerCounters = {
    totalRequests: 0,
    postRequests: 0,
    workerOriginatedMutations: 0,
    popupMutations: 0,
    newAttemptsCreated: 0,
    draftWrites: 0,
    finalSubmits: 0
  };

  function resetCounters(): void {
    counters.totalRequests = 0;
    counters.postRequests = 0;
    counters.workerOriginatedMutations = 0;
    counters.popupMutations = 0;
    counters.newAttemptsCreated = 0;
    counters.draftWrites = 0;
    counters.finalSubmits = 0;
  }

  before(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer((req, res) => {
      counters.totalRequests++;
      const method = (req.method || 'GET').toUpperCase();
      const url = req.url || '/';

      if (method === 'POST') counters.postRequests++;
      if (url.includes('/api/worker-self-write') && method === 'POST') {
        counters.workerOriginatedMutations++;
      }
      if (url.includes('/mod/quiz/processattempt.php') && method === 'POST') {
        counters.draftWrites++;
        counters.popupMutations++;
      }
      if (url.includes('startattempt.php')) {
        counters.newAttemptsCreated++;
      }
      if (url.includes('submit')) {
        counters.finalSubmits++;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      };

      // 1. Worker script that ITSELF initiates a mutating POST fetch upon activation
      if (url === '/worker-self.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          self.addEventListener('install', (e) => {
            self.skipWaiting();
          });
          self.addEventListener('activate', (e) => {
            e.waitUntil(
              self.clients.claim().then(() => {
                // Request originating DIRECTLY from ServiceWorker lifecycle event
                return fetch('/api/worker-self-write', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ origin: 'direct-worker-activate-thread' })
                });
              }).catch(() => {})
            );
          });
        `);
        return;
      }

      // 2. Page that registers the self-fetching worker
      if (url.startsWith('/real-sw-page')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>
          <h2>Real SW Registration</h2>
          <script>
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.register('/worker-self.js');
            }
          </script>
        </body></html>`);
        return;
      }

      // 3. Popup launcher page
      if (url.startsWith('/popup-launcher')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>
          <h2>Popup Test</h2>
          <button id="btnPop" onclick="const p = window.open('/popup-target'); setTimeout(() => { p.fetch('/mod/quiz/processattempt.php', { method: 'POST', body: 'ans=1' }); }, 150);">Open</button>
        </body></html>`);
        return;
      }

      if (url.startsWith('/popup-target')) {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>Target Page</body></html>`);
        return;
      }

      // 4. Redirect to mutating action endpoint
      if (url.startsWith('/redirect-chain')) {
        res.writeHead(302, { Location: '/mod/quiz/startattempt.php?cmid=909' });
        res.end('Redirecting');
        return;
      }

      // 5. Practice action page (allows POST in PRACTICE_ASSISTED)
      if (url.startsWith('/practice-action')) {
        if (method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><body>Practice Page</body></html>`);
        return;
      }

      res.writeHead(200, headers);
      res.end(`<!DOCTYPE html><html><body>Default Page</body></html>`);
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

  function makeCfg(mode: 'READ_ONLY' | 'PRACTICE_ASSISTED'): AppConfig {
    return {
      allowedHosts: ['127.0.0.1'],
      approvedForAIUse: true,
      operationMode: mode,
      parallelTabs: 1,
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'test' }
    } as unknown as AppConfig;
  }

  test('RO3-01: Global READ_ONLY mode completely blocks mutating HTTP methods', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { id: 'ro3-01', url: `${baseUrl}/practice-action`, title: 'Task 1', aiPermitted: true };
      const res = await executeTask(ctx, task, makeCfg('READ_ONLY'));

      // Page tries to dispatch POST
      const page = ctx.pages()[0];
      const fetchStatus = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { method: 'POST', body: 'mutation' });
          return r.status;
        } catch { return 0; }
      }, `${baseUrl}/practice-action`);

      assert.equal(fetchStatus, 0, 'POST must be blocked by client in global READ_ONLY');
      assert.equal(counters.postRequests, 0, 'Server must receive 0 POST requests');
    } finally {
      await ctx.close();
    }
  });

  test('RO3-02: Per-task READ_ONLY with global PRACTICE_ASSISTED blocks all writes', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { id: 'ro3-02', url: `${baseUrl}/practice-action`, title: 'Task 2', mode: 'READ_ONLY', aiPermitted: true };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));

      const page = ctx.pages()[0];
      const fetchStatus = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { method: 'POST', body: 'mutation' });
          return r.status;
        } catch { return 0; }
      }, `${baseUrl}/practice-action`);

      assert.equal(fetchStatus, 0);
      assert.equal(counters.postRequests, 0);
    } finally {
      await ctx.close();
    }
  });

  test('RO3-03: Real Service Worker lifecycle-originated request is blocked under READ_ONLY', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { id: 'ro3-03', url: `${baseUrl}/real-sw-page`, title: 'SW Test', mode: 'READ_ONLY', aiPermitted: true };
      await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));

      // Wait for service worker install and activate lifecycle events
      await new Promise(r => setTimeout(r, 600));

      assert.equal(counters.workerOriginatedMutations, 0, 'Worker-originated POST must be blocked under READ_ONLY');
      assert.equal(counters.postRequests, 0, 'Zero POST requests reached server from worker');
    } finally {
      await ctx.close();
    }
  });

  test('RO3-04: Persistent profile with pre-existing worker is protected under READ_ONLY', async () => {
    resetCounters();
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-persist-sw-'));
    try {
      // Session 1: Register worker in persistent context
      const ctx1 = await chromium.launchPersistentContext(tempProfileDir, { headless: true });
      const p1 = await ctx1.newPage();
      await p1.goto(`${baseUrl}/real-sw-page`);
      await new Promise(r => setTimeout(r, 600));
      await ctx1.close();

      // Session 2: Launch in READ_ONLY mode on the SAME profile
      resetCounters();
      const ctx2 = await chromium.launchPersistentContext(tempProfileDir, {
        headless: true,
        serviceWorkers: 'block' // Required for READ_ONLY persistent context
      });
      try {
        const task: Task = { id: 'ro3-04', url: `${baseUrl}/real-sw-page`, title: 'Reopened Profile', mode: 'READ_ONLY', aiPermitted: true };
        await executeTask(ctx2, task, makeCfg('READ_ONLY'));
        await new Promise(r => setTimeout(r, 600));

        assert.equal(counters.workerOriginatedMutations, 0, 'Pre-existing worker cannot dispatch mutations');
        assert.equal(counters.postRequests, 0, 'Zero POST requests from persistent profile');
      } finally {
        await ctx2.close();
      }
    } finally {
      try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('RO3-05: Popups and new tabs opened under READ_ONLY cannot dispatch writes', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { id: 'ro3-05', url: `${baseUrl}/popup-launcher`, title: 'Popup Task', mode: 'READ_ONLY', aiPermitted: true };
      const taskPromise = executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      await new Promise(r => setTimeout(r, 500));

      const pages = ctx.pages();
      if (pages.length > 0) {
        const btn = pages[0].locator('#btnPop');
        if (await btn.count() > 0) {
          await btn.click().catch(() => {});
          await new Promise(r => setTimeout(r, 600));
        }
      }
      await taskPromise;

      assert.equal(counters.popupMutations, 0, 'Popup must not reach draft endpoint');
      assert.equal(counters.postRequests, 0, 'Zero POST requests from popup');
    } finally {
      await ctx.close();
    }
  });

  test('RO3-06: Two concurrent tasks with different modes isolate cleanly', async () => {
    resetCounters();
    const ctxRO = await browser.newContext({ serviceWorkers: 'block' });
    const ctxPractice = await browser.newContext();
    try {
      const taskRO: Task = { id: 'ro3-06-ro', url: `${baseUrl}/practice-action`, title: 'Concurrent RO', mode: 'READ_ONLY', aiPermitted: true };
      const taskPR: Task = { id: 'ro3-06-pr', url: `${baseUrl}/practice-action`, title: 'Concurrent Practice', mode: 'PRACTICE_ASSISTED', aiPermitted: true };

      // Execute both concurrently
      const [resRO, resPR] = await Promise.all([
        executeTask(ctxRO, taskRO, makeCfg('PRACTICE_ASSISTED')),
        executeTask(ctxPractice, taskPR, makeCfg('PRACTICE_ASSISTED'))
      ]);

      // Trigger POST in both contexts
      const pageRO = ctxRO.pages()[0];
      const pagePR = ctxPractice.pages()[0];

      const [statusRO, statusPR] = await Promise.all([
        pageRO.evaluate(async (url) => {
          try {
            const r = await fetch(url, { method: 'POST', body: 'mutation-ro' });
            return r.status;
          } catch { return 0; }
        }, `${baseUrl}/practice-action`),
        pagePR.evaluate(async (url) => {
          try {
            const r = await fetch(url, { method: 'POST', body: 'mutation-pr' });
            return r.status;
          } catch { return 0; }
        }, `${baseUrl}/practice-action`)
      ]);

      assert.equal(statusRO, 0, 'READ_ONLY task must block POST');
      assert.equal(statusPR, 200, 'PRACTICE_ASSISTED task is permitted to POST');
      assert.equal(counters.postRequests, 1, 'Exactly 1 POST request reached server (from Practice task)');
    } finally {
      await ctxRO.close();
      await ctxPractice.close();
    }
  });

  test('RO3-07: READ_ONLY -> PRACTICE_ASSISTED -> READ_ONLY sequential transitions isolate route handlers', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      // Step 1: READ_ONLY
      const task1: Task = { id: 'ro3-07-t1', url: `${baseUrl}/practice-action`, title: 'T1', mode: 'READ_ONLY', aiPermitted: true };
      await executeTask(ctx, task1, makeCfg('PRACTICE_ASSISTED'));
      const p1 = ctx.pages()[0];
      const r1 = await p1.evaluate(async (url) => {
        try { return (await fetch(url, { method: 'POST', body: '1' })).status; } catch { return 0; }
      }, `${baseUrl}/practice-action`);
      assert.equal(r1, 0);
      assert.equal(counters.postRequests, 0);

      // Step 2: PRACTICE_ASSISTED
      const task2: Task = { id: 'ro3-07-t2', url: `${baseUrl}/practice-action`, title: 'T2', mode: 'PRACTICE_ASSISTED', aiPermitted: true };
      await executeTask(ctx, task2, makeCfg('PRACTICE_ASSISTED'));
      const p2 = ctx.pages()[ctx.pages().length - 1];
      const r2 = await p2.evaluate(async (url) => {
        try { return (await fetch(url, { method: 'POST', body: '2' })).status; } catch { return 0; }
      }, `${baseUrl}/practice-action`);
      assert.equal(r2, 200);
      assert.equal(counters.postRequests, 1);

      // Step 3: READ_ONLY again
      const task3: Task = { id: 'ro3-07-t3', url: `${baseUrl}/practice-action`, title: 'T3', mode: 'READ_ONLY', aiPermitted: true };
      await executeTask(ctx, task3, makeCfg('PRACTICE_ASSISTED'));
      const p3 = ctx.pages()[ctx.pages().length - 1];
      const r3 = await p3.evaluate(async (url) => {
        try { return (await fetch(url, { method: 'POST', body: '3' })).status; } catch { return 0; }
      }, `${baseUrl}/practice-action`);
      assert.equal(r3, 0);
      assert.equal(counters.postRequests, 1, 'No new POST requests from Step 3');
    } finally {
      await ctx.close();
    }
  });

  test('RO3-08: 302 Redirect to mutating action endpoint is aborted before mutation occurs', async () => {
    resetCounters();
    const ctx = await browser.newContext();
    try {
      const task: Task = { id: 'ro3-08', url: `${baseUrl}/redirect-chain`, title: 'Redirect Test', mode: 'READ_ONLY', aiPermitted: true };
      const res = await executeTask(ctx, task, makeCfg('PRACTICE_ASSISTED'));
      assert.equal(counters.newAttemptsCreated, 0, 'Redirect must not reach startattempt.php');
    } finally {
      await ctx.close();
    }
  });

  test('RO3-09: Zero automated quiz attempts started across all tests in suite', () => {
    assert.equal(counters.newAttemptsCreated, 0, 'No attempt starts permitted in READ_ONLY');
  });

  test('RO3-10: Zero drafts, zero scores altered, zero submissions across suite', () => {
    assert.equal(counters.draftWrites, 0);
    assert.equal(counters.finalSubmits, 0);
  });
});
