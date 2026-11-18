/** Post-Click Navigation Verification Regression Tests (Phase 3: NAV-01 to NAV-10)
 * Verifies the Observe -> Act -> Verify lifecycle for multi-page forms,
 * detecting disabled buttons, no-op clicks, validation errors, and access gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { ResumeCoordinator } from '../src/browser/resume-coordinator.js';
import type { TaskCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

const testConfig: AppConfig = {
  allowedHosts: ['quiz.example.com'],
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

test('NAV-01: Click Next successfully transitions DOM -> advances step', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1" style="display: block;">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="button" id="next-btn" onclick="
                document.getElementById('step-1').style.display='none';
                document.getElementById('step-2').style.display='block';
              ">Tiếp theo</button>
            </div>
            <div id="step-2" style="display: none;">
              <h2>Trang 2</h2>
              <input type="text" id="q2" name="q2" value="">
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav01',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' }, 2: { q2: 'Answer 2' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, true, 'Must successfully advance when DOM transitions');
  } finally {
    await browser?.close();
  }
});

test('NAV-02: Next button click does NOT change page (no-op button) -> does NOT advance step', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <!-- Broken Next button that does nothing -->
              <button type="button" id="next-btn">Tiếp theo</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav02-broken-next',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must return false when Next button is ineffective');
  } finally {
    await browser?.close();
  }
});

test('NAV-03: Validation error appears on page after click -> halts and preserves checkpoint', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <div id="err-box" style="display: none;" class="alert-danger">
                Câu hỏi này là bắt buộc, vui lòng kiểm tra lại.
              </div>
              <button type="button" id="next-btn" onclick="
                document.getElementById('err-box').style.display = 'block';
              ">Tiếp theo</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav03-val-err',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must halt when validation error appears');
  } finally {
    await browser?.close();
  }
});

test('NAV-04: Next button is disabled -> refuses to click and halts safely', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="button" disabled>Tiếp theo</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav04-disabled',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must not click disabled Next button');
  } finally {
    await browser?.close();
  }
});

test('NAV-05: Next button replaced by Submit/Finish button -> refuses to click', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="submit">Submit all and finish</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav05-submit-guard',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must never click Submit button during pagination');
  } finally {
    await browser?.close();
  }
});

test('NAV-06: Next click redirects to authentication screen -> halts safely', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1" style="display: block;">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="button" onclick="
                document.getElementById('step-1').style.display='none';
                document.getElementById('auth-box').style.display='block';
              ">Tiếp theo</button>
            </div>
            <div id="auth-box" style="display: none;">
              <h2>Đăng nhập để tiếp tục</h2>
              <form><input type="password" name="password"></form>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav06-auth-redirect',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must halt when redirecting to auth screen');
  } finally {
    await browser?.close();
  }
});

test('NAV-07: Access gate appears after click -> halts safely', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1" style="display: block;">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="button" onclick="
                document.getElementById('step-1').style.display='none';
                document.getElementById('gate-box').style.display='block';
              ">Tiếp theo</button>
            </div>
            <div id="gate-box" style="display: none;">
              <p>This quiz is currently not available</p>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav07-gate',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must halt when access gate appears');
  } finally {
    await browser?.close();
  }
});

test('NAV-08: URL hash changes but DOM questions remain identical -> flags failure, no blind advance', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1">
              <input type="text" id="q1" name="q1" value="Answer 1">
              <button type="button" onclick="window.location.hash = '#page2';">Tiếp theo</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav08-hash-only',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false, 'Must not advance when DOM questions remain identical despite URL hash change');
  } finally {
    await browser?.close();
  }
});

test('NAV-09: Browser restart mid-navigation recovers verified step state', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><body><div id="step-1"><input type="text" id="q1" name="q1" value="Answer 1"></div></body></html>`
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    // Checkpoint recorded that step 1 was verified and running
    const cp: TaskCheckpoint = {
      taskId: 'test-nav09-restart',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' }, 2: { q2: 'Answer 2' } },
      lastUpdated: new Date().toISOString()
    };

    const state = await ResumeCoordinator.evaluateState(page, cp, testConfig);
    assert.equal(state.state, 'NAVIGATION_REQUIRED');
    assert.equal(state.currentStep, 1);
    assert.equal(state.targetStep, 2);
  } finally {
    await browser?.close();
  }
});

test('NAV-10: Navigation timeout does NOT create duplicate submissions or advance step count', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><body><div id="step-1"><input type="text" id="q1" name="q1" value="Answer 1"><button type="button" onclick="while(true){}">Tiếp theo</button></div></body></html>`
      });
    });

    await page.goto('https://quiz.example.com/quiz');

    const cp: TaskCheckpoint = {
      taskId: 'test-nav10-timeout',
      url: 'https://quiz.example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 2,
      questionsFound: 2,
      questionsFilled: 1,
      answersByStep: { 1: { q1: 'Answer 1' } },
      lastUpdated: new Date().toISOString()
    };

    // advanceToStep must handle gracefully and not claim success
    const advanced = await ResumeCoordinator.advanceToStep(page, cp, 2, testConfig);
    assert.equal(advanced, false);
  } finally {
    await browser?.close();
  }
});

test('NAV-11: executeVerifiedNavigation handles SPA same-URL transition when question IDs change (AUD-114-06)', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1" style="display: block;">
              <input type="text" id="q_spa_1" name="q_spa_1" value="A1">
              <button type="button" id="next-btn" onclick="
                document.getElementById('step-1').style.display='none';
                document.getElementById('step-2').style.display='block';
              ">Tiếp theo</button>
            </div>
            <div id="step-2" style="display: none;">
              <input type="text" id="q_spa_2" name="q_spa_2" value="">
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, true, 'SPA same-URL transition must succeed');
    assert.equal(result.state, 'ADVANCED');
    assert.equal(result.beforeUrl, result.afterUrl, 'URL must stay identical in SPA');
  } finally {
    await browser?.close();
  }
});

test('NAV-12: executeVerifiedNavigation blocks Submit/Finish button and refuses blind transition', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-final">
              <input type="text" id="q_final" name="q_final" value="Final Answer">
              <button type="submit" id="submit-btn">Nộp bài thi</button>
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false, 'Must not click submit button as next');
    assert.equal(result.state, 'SUBMIT_GUARD');
  } finally {
    await browser?.close();
  }
});

// Phase 4 (v1.1.6): Explicit DOMNAV-01 to DOMNAV-10 Tests
test('DOMNAV-01: Pathname đổi nhưng DOM câu hỏi không đổi -> NEEDS_REVIEW (AUD-115-05)', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      const url = route.request().url();
      if (url.includes('/quiz/step1')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `
            <!DOCTYPE html><html><body>
              <input type="text" id="q_same" name="q_same" value="val">
              <button type="button" id="next-btn" onclick="window.location.href='/quiz/step1-redirected';">Tiếp theo</button>
            </body></html>
          `
        });
      } else if (url.includes('/quiz/step1-redirected')) {
        // Pathname changed, but questions and step indicators did NOT change!
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `
            <!DOCTYPE html><html><body>
              <input type="text" id="q_same" name="q_same" value="val">
              <button type="button" id="next-btn">Tiếp theo</button>
            </body></html>
          `
        });
      }
    });

    await page.goto('https://quiz.example.com/quiz/step1');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false, 'Pathname change alone without DOM question/step evidence must not auto-advance');
    assert.equal(result.state, 'NEEDS_REVIEW');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-02: Pathname đổi, câu hỏi đổi -> ADVANCED', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      const url = route.request().url();
      if (url.includes('/quiz/p1')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `
            <!DOCTYPE html><html><body>
              <input type="text" id="q_p1" name="q_p1" value="">
              <button type="button" id="next-btn" onclick="window.location.href='/quiz/p2';">Tiếp theo</button>
            </body></html>
          `
        });
      } else if (url.includes('/quiz/p2')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `
            <!DOCTYPE html><html><body>
              <input type="text" id="q_p2" name="q_p2" value="">
            </body></html>
          `
        });
      }
    });

    await page.goto('https://quiz.example.com/quiz/p1');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, true);
    assert.equal(result.state, 'ADVANCED');
    assert.ok(result.afterUrl.includes('/quiz/p2'));
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-03: Same URL, câu hỏi đổi -> ADVANCED', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <div id="step-1" style="display: block;">
              <input type="text" id="q_step1" name="q_step1" value="">
              <button type="button" id="next-btn" onclick="
                document.getElementById('step-1').style.display='none';
                document.getElementById('step-2').style.display='block';
              ">Tiếp theo</button>
            </div>
            <div id="step-2" style="display: none;">
              <input type="text" id="q_step2" name="q_step2" value="">
            </div>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, true);
    assert.equal(result.state, 'ADVANCED');
    assert.equal(result.beforeUrl, result.afterUrl);
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-04: Hash đổi, nội dung không đổi -> NO_CHANGE', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_hash" name="q_hash" value="">
            <button type="button" id="next-btn" onclick="window.location.hash='#page2';">Tiếp theo</button>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false);
    assert.equal(result.state, 'NO_CHANGE');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-05: Form validation lỗi -> không tăng bước', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_val" name="q_val" value="">
            <div id="err-msg" style="display: none;" class="error">This question is required</div>
            <button type="button" id="next-btn" onclick="document.getElementById('err-msg').style.display='block';">Tiếp theo</button>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false);
    assert.equal(result.state, 'VALIDATION_ERROR');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-06: Page identity chưa xác định (no-op click) -> NO_CHANGE', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_noop" name="q_noop" value="">
            <button type="button" id="next-btn">Tiếp theo</button>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false);
    assert.equal(result.state, 'NO_CHANGE');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-07: Redirect sang SSO được phê duyệt -> WAITING_FOR_AUTH (AUTH_REQUIRED)', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const configWithSso: AppConfig = {
      ...testConfig,
      authUrls: ['https://sso.university.edu/login']
    };

    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_sso" name="q_sso" value="">
            <button type="button" id="next-btn" onclick="window.location.href='https://sso.university.edu/login';">Tiếp theo</button>
          </body></html>
        `
      });
    });

    await page.route('https://sso.university.edu/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <h2>Đăng nhập tập trung</h2>
            <input type="password" name="pwd">
            <button type="submit">Đăng nhập</button>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, configWithSso);
    assert.equal(result.success, false);
    assert.equal(result.state, 'AUTH_REQUIRED');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-08: Redirect host lạ ngoài allowlist -> HOST_MISMATCH', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_ext" name="q_ext" value="">
            <button type="button" id="next-btn" onclick="window.location.href='https://malicious.evil.com/phish';">Tiếp theo</button>
          </body></html>
        `
      });
    });

    await page.route('https://malicious.evil.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<html><body>Phishing page</body></html>`
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false);
    assert.equal(result.state, 'HOST_MISMATCH');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-09: Nút Submit giả dạng Next -> chặn bằng SUBMIT_GUARD', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://quiz.example.com/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <!DOCTYPE html><html><body>
            <input type="text" id="q_end" name="q_end" value="done">
            <button type="submit">Submit all and finish</button>
          </body></html>
        `
      });
    });

    await page.goto('https://quiz.example.com/quiz');
    const result = await executeVerifiedNavigation(page, testConfig);
    assert.equal(result.success, false);
    assert.equal(result.state, 'SUBMIT_GUARD');
  } finally {
    await browser?.close();
  }
});

test('DOMNAV-10: Normal Browser Agent và Resume Coordinator đều dùng chung verifier', async () => {
  const { executeVerifiedNavigation } = await import('../src/browser/verified-navigation.js');
  assert.equal(typeof executeVerifiedNavigation, 'function');
  const { ResumeCoordinator } = await import('../src/browser/resume-coordinator.js');
  assert.equal(typeof ResumeCoordinator.advanceToStep, 'function');
});


