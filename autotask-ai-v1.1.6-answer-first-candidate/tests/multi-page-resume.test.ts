/** Multi-Page Resume & ResumeCoordinator Integration Tests (AUDIT-02 Remediation)
 * Tests MP-01 to MP-10 covering multi-page forms, step advancement, tampering prevention, and gate recognition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { ResumeCoordinator } from '../src/browser/resume-coordinator.js';
import type { TaskCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

const dummyConfig: AppConfig = {
  allowedHosts: ['localhost', '127.0.0.1', 'quiz.example.com'],
  approvedForAIUse: true,
  parallelTabs: 1,
  authUrls: [],
  deadlinePages: [],
  tasks: [],
  provider: {
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  }
};

test('MP-01: Page 1 of 3, fresh task without recorded answers -> RESUME_READY at step 1', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html><body><form><input type="text" id="q1" name="q1"></form></body></html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp01',
      url: page.url(),
      status: 'PENDING',
      stepsCompleted: 0,
      totalSteps: 3,
      questionsFound: 0,
      questionsFilled: 0,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'RESUME_READY');
    assert.equal(res.currentStep, 1);
    assert.equal(res.targetStep, 1);
  } finally {
    await browser?.close();
  }
});

test('MP-02: Page 1 completed, answersByStep present, restart on Page 1 -> NAVIGATION_REQUIRED to step 2', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <input type="text" id="q1" name="q1" value="Answer 1">
            <button type="button" id="btn-next">Tiếp theo</button>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp02',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 3,
      questionsFound: 1,
      questionsFilled: 1,
      answersByStep: {
        1: { q1: 'Answer 1' }
      },
      answersRecorded: {
        q1: 'Answer 1'
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'NAVIGATION_REQUIRED');
    assert.equal(res.currentStep, 1);
    assert.equal(res.targetStep, 2);
    assert.equal(res.canAdvance, true);
    assert.equal(res.verifiedValuesCount, 1);
  } finally {
    await browser?.close();
  }
});

test('MP-03: advanceToStep clicks Next safely to navigate from Page 1 to Page 2', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Intercept allowed host URL and serve multi-page fixture
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html>
          <html>
            <body>
              <div id="step-1" style="display: block;">
                <h2>Trang 1</h2>
                <input type="text" id="q1" name="q1" value="Answer 1">
                <button type="button" id="next-btn" onclick="
                  document.getElementById('step-1').style.display = 'none';
                  document.getElementById('step-2').style.display = 'block';
                ">Tiếp theo</button>
              </div>
              <div id="step-2" style="display: none;">
                <h2>Trang 2</h2>
                <input type="text" id="q2" name="q2" value="">
              </div>
            </body>
          </html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-mp03',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: {
        1: { q1: 'Answer 1' },
        2: { q2: 'Answer 2' }
      },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, dummyConfig);
    assert.equal(advanced, true, 'Must successfully advance from Step 1 to Step 2');

    // Confirm that Step 2 is now visible on DOM
    const isStep2Visible = await page.evaluate(() => {
      const el = document.getElementById('step-2');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    assert.equal(isStep2Visible, true, 'Step 2 must now be displayed');
  } finally {
    await browser?.close();
  }
});

test('MP-04: Page 1 answers tampered/cleared on DOM -> STATE_MISMATCH, does NOT advance', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <input type="text" id="q1" name="q1" value="Tampered unexpected text">
            <button type="button">Tiếp theo</button>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp04',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: {
        1: { q1: 'Original Answer 1' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'STATE_MISMATCH');
    assert.match(res.reason, /khác với checkpoint/i);
  } finally {
    await browser?.close();
  }
});

test('MP-05: advanceToStep refuses to click Submit/Finish disguised as Next button', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <input type="text" id="q1" name="q1" value="Answer 1">
            <button type="submit">Submit all and finish</button>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp05',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: {
        1: { q1: 'Answer 1' }
      },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, dummyConfig);
    assert.equal(advanced, false, 'Must refuse to click Submit button during pagination');
  } finally {
    await browser?.close();
  }
});

test('MP-06: All pages completed -> evaluateState returns COMPLETED_VERIFIED or NEEDS_REVIEW', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <input type="text" id="q3" name="q3" value="Final Answer 3">
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp06',
      url: page.url(),
      status: 'COMPLETED',
      stepsCompleted: 3,
      totalSteps: 3,
      questionsFound: 3,
      questionsFilled: 3,
      answersByStep: {
        3: { q3: 'Final Answer 3' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'NEEDS_REVIEW', 'Completed task must not auto-replay');
    assert.match(res.reason, /COMPLETED/);
  } finally {
    await browser?.close();
  }
});

test('MP-07: Legacy flat answersRecorded on Page 1 -> recognizes NAVIGATION_REQUIRED for remaining pages', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Only Page 1 questions exist on current DOM
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <input type="text" id="q1" name="q1" value="Page 1 Text">
            <button type="button">Tiếp</button>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp07-legacy',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 2,
      totalSteps: 3,
      questionsFound: 3,
      questionsFilled: 2,
      // Flat structure containing answers from both page 1 and page 2
      answersRecorded: {
        q1: 'Page 1 Text',
        q2: 'Page 2 Text'
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'NAVIGATION_REQUIRED');
    assert.equal(res.canAdvance, true);
    assert.equal(res.matchedQuestions, 1);
  } finally {
    await browser?.close();
  }
});

test('MP-08: Auth screen detected (password field) -> returns WAITING_FOR_AUTH', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <h2>Hệ thống xác thực tập trung CAS</h2>
          <form>
            <input type="text" name="username">
            <input type="password" name="password">
            <button type="submit">Đăng nhập</button>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp08-auth',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'WAITING_FOR_AUTH');
    assert.match(res.reason, /đăng nhập/i);
  } finally {
    await browser?.close();
  }
});

test('MP-09: FAMI 15-minute wait gate detected -> returns WAITING_FOR_ACCESS', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body></body></html>');
    // FAMI URL pattern triggers FAMI_READING gate in classifyAccess
    Object.defineProperty(page, 'url', { value: () => 'https://fami.hust.edu.vn/exam/123' });
    await page.setContent(`
      <html>
        <body>
          <div>Thời gian đọc còn lại: 14:59</div>
          <p>Bạn đọc quá nhanh, hãy xem lại tài liệu trước khi có thể bắt đầu thi.</p>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-mp09-fami-gate',
      url: 'https://fami.hust.edu.vn/exam/123',
      status: 'RUNNING',
      stepsCompleted: 0,
      totalSteps: 1,
      questionsFound: 0,
      questionsFilled: 0,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'WAITING_FOR_ACCESS');
    assert.match(res.reason, /FAMI|truy cập/i);
  } finally {
    await browser?.close();
  }
});

test('MP-10: Host mismatch between checkpoint and live page -> returns NEEDS_REVIEW', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>Some page</h1></body></html>');

    const cp: TaskCheckpoint = {
      taskId: 'test-mp10-host-mismatch',
      url: 'https://moodle.university.edu.vn/quiz/view.php?id=999',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await ResumeCoordinator.evaluateState(page, cp);
    assert.equal(res.state, 'NEEDS_REVIEW');
    assert.match(res.reason, /hostname/i);
  } finally {
    await browser?.close();
  }
});
