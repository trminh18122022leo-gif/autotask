/** Legitimate SSO Redirect & Identity Provider Verification Tests (Phase 4: SSO-01 to SSO-06)
 * Verifies that legitimate SSO redirects to approved identity providers are recognized as WAITING_FOR_AUTH,
 * while unauthorized domains, phishing spoofs, and session expiry are safely rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { ResumeCoordinator } from '../src/browser/resume-coordinator.js';
import type { TaskCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

const ssoAppConfig: AppConfig = {
  allowedHosts: ['moodle.hust.edu.vn', 'cas.hust.edu.vn'],
  authUrls: ['https://cas.hust.edu.vn/cas/login'],
  approvedForAIUse: true,
  parallelTabs: 1,
  deadlinePages: [],
  tasks: [],
  provider: {
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  }
};

test('SSO-01: LMS redirect to approved CAS identity provider -> recognizes WAITING_FOR_AUTH', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://cas.hust.edu.vn/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <h2>Hệ thống xác thực tập trung CAS HUST</h2>
            <form action="/cas/login" method="post">
              <input type="text" name="username">
              <input type="password" name="password">
              <button type="submit">Đăng nhập</button>
            </form>
          </body></html>
        `
      });
    });

    await page.goto('https://cas.hust.edu.vn/cas/login');

    const cp: TaskCheckpoint = {
      taskId: 'test-sso01',
      url: 'https://moodle.hust.edu.vn/mod/quiz/attempt.php',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.equal(res.state, 'WAITING_FOR_AUTH', 'Must recognize approved SSO provider as WAITING_FOR_AUTH');
    assert.match(res.reason, /xác thực SSO/);
  } finally {
    await browser?.close();
  }
});

test('SSO-02: Redirect to unknown hostname with password field -> rejects with NEEDS_REVIEW', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://untrusted-auth.external.org/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <form><input type="password" name="pwd"></form>
          </body></html>
        `
      });
    });

    await page.goto('https://untrusted-auth.external.org/login');

    const cp: TaskCheckpoint = {
      taskId: 'test-sso02',
      url: 'https://moodle.hust.edu.vn/mod/quiz/attempt.php',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.equal(res.state, 'NEEDS_REVIEW', 'Untrusted redirect must not be allowed as auth');
    assert.match(res.reason, /khác hostname/);
  } finally {
    await browser?.close();
  }
});

test('SSO-03: After valid authentication returns to LMS -> resumes state observation', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://moodle.hust.edu.vn/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://moodle.hust.edu.vn/mod/quiz/attempt.php');

    const cp: TaskCheckpoint = {
      taskId: 'test-sso03',
      url: 'https://moodle.hust.edu.vn/mod/quiz/attempt.php',
      status: 'RUNNING',
      stepsCompleted: 0,
      totalSteps: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.notEqual(res.state, 'WAITING_FOR_AUTH');
    assert.equal(res.state, 'RESUME_READY');
  } finally {
    await browser?.close();
  }
});

test('SSO-04: Session expired during form filling -> safely halts', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://moodle.hust.edu.vn/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <h2>Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.</h2>
            <form><input type="password" name="pass"></form>
          </body></html>
        `
      });
    });

    await page.goto('https://moodle.hust.edu.vn/login/index.php');

    const cp: TaskCheckpoint = {
      taskId: 'test-sso04-expired',
      url: 'https://moodle.hust.edu.vn/mod/quiz/attempt.php',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.equal(res.state, 'WAITING_FOR_AUTH', 'Expired session showing login form must yield WAITING_FOR_AUTH');
  } finally {
    await browser?.close();
  }
});

test('SSO-05: Redirect loop terminates safely with clear status', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Simulate invalid URL
    Object.defineProperty(page, 'url', { value: () => 'about:blank' });

    const cp: TaskCheckpoint = {
      taskId: 'test-sso05',
      url: 'https://moodle.hust.edu.vn/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.equal(res.state, 'NEEDS_REVIEW');
  } finally {
    await browser?.close();
  }
});

test('SSO-06: Phishing / spoof domain resembling legitimate login is rejected', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Attacker domain trying to impersonate cas.hust.edu.vn
    await page.route('https://cas.hust.edu.vn.phishing-site.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><body><form><input type="password" name="pwd"></form></body></html>`
      });
    });

    await page.goto('https://cas.hust.edu.vn.phishing-site.com/cas/login');

    const cp: TaskCheckpoint = {
      taskId: 'test-sso06-spoof',
      url: 'https://moodle.hust.edu.vn/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp, ssoAppConfig);
    assert.equal(res.state, 'NEEDS_REVIEW', 'Phishing spoof domain must be rejected with NEEDS_REVIEW');
  } finally {
    await browser?.close();
  }
});
