/** Phase 3 — Strict LMS Origin Trust Regression Suite (ORIGIN-01..07)
 * Verifies full origin validation (protocol + exact hostname + port + zero userinfo),
 * explicit local sandbox gating, approved HTTPS SSO redirects, and untrusted redirect rejection.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ensureAllowed, isApprovedSsoOrigin, validateConfig } from '../src/config.js';
import { clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

describe('Phase 3 — Strict LMS Origin Trust & Redirect Validation (ORIGIN-01..07)', () => {

  test('ORIGIN-01: Official HTTPS LMS URL on standard port 443 -> ALLOW', () => {
    const u1 = ensureAllowed('https://lms.hust.edu.vn/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']);
    assert.equal(u1.origin, 'https://lms.hust.edu.vn');
    const u2 = ensureAllowed('https://lms.hust.edu.vn:443/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']);
    assert.equal(u2.origin, 'https://lms.hust.edu.vn');
  });

  test('ORIGIN-02: Plaintext HTTP URL on official/non-local LMS host -> REJECT', () => {
    assert.throws(
      () => ensureAllowed('http://lms.hust.edu.vn/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /HTTPS/i
    );
    // Even attempting to configure plaintext HTTP in allowedOrigins for a non-local host must reject
    assert.throws(
      () =>
        ensureAllowed('http://lms.hust.edu.vn/mod/quiz/view.php?id=55', ['lms.hust.edu.vn'], {
          allowedOrigins: ['http://lms.hust.edu.vn']
        }),
      /HTTPS/i
    );
  });

  test('ORIGIN-03: Non-standard port (:8443) on official LMS host -> REJECT by default (ALLOW only if exact HTTPS origin is in allowedOrigins)', () => {
    assert.throws(
      () => ensureAllowed('https://lms.hust.edu.vn:8443/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /port|cổng/i
    );

    const explicitPort = ensureAllowed('https://lms.hust.edu.vn:8443/mod/quiz/view.php?id=55', ['lms.hust.edu.vn'], {
      allowedOrigins: ['https://lms.hust.edu.vn:8443']
    });
    assert.equal(explicitPort.origin, 'https://lms.hust.edu.vn:8443');
  });

  test('ORIGIN-04: Embedded username/password (userinfo) in LMS URL -> REJECT', () => {
    assert.throws(
      () => ensureAllowed('https://user:pass@lms.hust.edu.vn/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /username|password|không hợp lệ/i
    );
    assert.throws(
      () => ensureAllowed('https://student@lms.hust.edu.vn/course/view.php?id=1', ['lms.hust.edu.vn']),
      /username|password|không hợp lệ/i
    );
  });

  test('ORIGIN-05: Local HTTP sandbox (http://127.0.0.1:43210/...) -> ALLOW only when loopback is explicitly configured and sandbox is not disabled', () => {
    // Rejected when 127.0.0.1 is NOT in allowedHosts
    assert.throws(
      () => ensureAllowed('http://127.0.0.1:43210/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /không nằm trong allowedHosts/i
    );

    // Rejected when allowLocalHttpSandbox is explicitly false
    assert.throws(
      () =>
        ensureAllowed('http://127.0.0.1:43210/mod/quiz/view.php?id=55', ['127.0.0.1'], {
          allowLocalHttpSandbox: false
        }),
      /allowLocalHttpSandbox=false/i
    );

    // Allowed when 127.0.0.1 is explicitly listed in allowedHosts for local sandbox E2E
    const allowed = ensureAllowed('http://127.0.0.1:43210/mod/quiz/view.php?id=55', ['127.0.0.1']);
    assert.equal(allowed.origin, 'http://127.0.0.1:43210');
  });

  test('ORIGIN-06: Redirect to approved SSO origin -> WAITING_FOR_AUTH without expanding allowedHosts or autofilling', async () => {
    const { chromium } = await import('playwright');
    const { executeTask } = await import('../src/main.js');
    const taskId = 'origin-06-approved-sso';
    await clearCheckpoint(taskId);
    const browser = await chromium.launch({ headless: true });

    // Real wire-level HTTP 302 redirect across two distinct origins (lmsServer -> ssoServer)
    let ssoPort = 0;
    let lmsPort = 0;
    const ssoServer: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>HUST SSO Login</title></head><body>
        <h2>Đăng nhập xác thực tập trung HUST</h2>
        <form action="/cas/login" method="post">
          <input type="text" name="username" id="u">
          <input type="password" name="password" id="p">
          <button type="submit">Sign in</button>
        </form>
      </body></html>`);
    });
    const lmsServer: Server = createServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${ssoPort}/cas/login?service=${encodeURIComponent(`http://127.0.0.1:${lmsPort}`)}`
      });
      res.end();
    });

    await new Promise<void>(r => ssoServer.listen(0, '127.0.0.1', () => {
      ssoPort = (ssoServer.address() as any).port;
      r();
    }));
    await new Promise<void>(r => lmsServer.listen(0, '127.0.0.1', () => {
      lmsPort = (lmsServer.address() as any).port;
      r();
    }));

    const ctx = await browser.newContext();
    try {
      // Also validate production HTTPS SSO origin policy (HTTP downgrade & rogue port rejected)
      const httpsCfg: AppConfig = validateConfig({
        allowedHosts: ['lms.hust.edu.vn'],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: ['https://id.hust.edu.vn/cas/login'],
        deadlinePages: [],
        tasks: [{ id: taskId, url: 'https://lms.hust.edu.vn/course/view.php?id=10', aiPermitted: true }],
        provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
      });
      assert.equal(isApprovedSsoOrigin('https://id.hust.edu.vn/cas/login?service=1', httpsCfg), true);
      assert.equal(isApprovedSsoOrigin('http://id.hust.edu.vn/cas/login', httpsCfg), false, 'HTTP downgrade on SSO must fail');
      assert.equal(isApprovedSsoOrigin('https://id.hust.edu.vn:8443/cas/login', httpsCfg), false, 'Custom port on SSO must fail');
      assert.equal(isApprovedSsoOrigin('https://user:pw@id.hust.edu.vn/cas/login', httpsCfg), false, 'Userinfo on SSO must fail');

      // Execute real browser navigation where ONLY lmsPort origin is in allowedOrigins and ssoPort is in authUrls
      const liveCfg: AppConfig = validateConfig({
        allowedHosts: ['lms.hust.edu.vn'],
        allowedOrigins: [`http://127.0.0.1:${lmsPort}`],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: [`http://127.0.0.1:${ssoPort}/cas/login`],
        deadlinePages: [],
        tasks: [{ id: taskId, url: `http://127.0.0.1:${lmsPort}/course/view.php?id=10`, aiPermitted: true }],
        provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
      });

      const res = await executeTask(ctx, liveCfg.tasks[0], liveCfg);
      assert.equal(res.status, 'WAITING_FOR_AUTH');
      assert.equal(res.questionsFound, 0);
      assert.equal(res.questionsFilled, 0);
      assert.equal(await res.page!.locator('#u').inputValue(), '', 'Must never autofill SSO username');
      assert.equal(await res.page!.locator('#p').inputValue(), '', 'Must never autofill SSO password');
      assert.deepEqual(liveCfg.allowedHosts, ['lms.hust.edu.vn'], 'allowedHosts must NEVER auto-expand');
      assert.deepEqual(liveCfg.allowedOrigins, [`http://127.0.0.1:${lmsPort}`], 'allowedOrigins must NEVER auto-expand');
    } finally {
      await ctx.close();
      await browser.close();
      await clearCheckpoint(taskId);
      await new Promise<void>(r => lmsServer.close(() => r()));
      await new Promise<void>(r => ssoServer.close(() => r()));
    }
  });

  test('ORIGIN-07: Redirect to unapproved external origin -> NEEDS_REVIEW with 0 interactions', async () => {
    const { chromium } = await import('playwright');
    const { executeTask } = await import('../src/main.js');
    const taskId = 'origin-07-untrusted-redirect';
    await clearCheckpoint(taskId);
    const browser = await chromium.launch({ headless: true });

    let evilPort = 0;
    let lmsPort = 0;
    const evilServer: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
        <h2>Sign in to continue</h2>
        <form><input type="text" name="user"><input type="password" name="pw"><button type="submit">Sign in</button></form>
      </body></html>`);
    });
    const lmsServer: Server = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${evilPort}/phishing-sso` });
      res.end();
    });

    await new Promise<void>(r => evilServer.listen(0, '127.0.0.1', () => {
      evilPort = (evilServer.address() as any).port;
      r();
    }));
    await new Promise<void>(r => lmsServer.listen(0, '127.0.0.1', () => {
      lmsPort = (lmsServer.address() as any).port;
      r();
    }));

    const ctx = await browser.newContext();
    try {
      const cfg: AppConfig = validateConfig({
        allowedHosts: ['lms.hust.edu.vn'],
        allowedOrigins: [`http://127.0.0.1:${lmsPort}`],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: ['https://id.hust.edu.vn/cas/login'],
        deadlinePages: [],
        tasks: [{ id: taskId, url: `http://127.0.0.1:${lmsPort}/mod/quiz/view.php?id=88`, aiPermitted: true }],
        provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
      });

      const res = await executeTask(ctx, cfg.tasks[0], cfg);
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.questionsFound, 0);
      assert.equal(res.questionsFilled, 0);
    } finally {
      await ctx.close();
      await browser.close();
      await clearCheckpoint(taskId);
      await new Promise<void>(r => lmsServer.close(() => r()));
      await new Promise<void>(r => evilServer.close(() => r()));
    }
  });
});
