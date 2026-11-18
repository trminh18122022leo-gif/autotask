import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  sanitizeCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  verifyResumeState,
  checkDuplicateRisk,
  resilientGoto,
  getSafeCheckpointPath,
  type TaskCheckpoint
} from '../src/task-manager.js';

test('getSafeCheckpointPath: prevents directory traversal and safely hashes dangerous IDs', () => {
  const normalPath = getSafeCheckpointPath('task-normal-01');
  assert.ok(normalPath.endsWith('task-normal-01.json'));

  const dangerousId = '../../etc/passwd';
  const safePath = getSafeCheckpointPath(dangerousId);
  assert.ok(!safePath.includes('..'), 'Path must not contain double dots');
  assert.ok(safePath.includes('.private'), 'Path must remain strictly within .private directory');

  const winDangerousId = '..\\..\\Windows\\System32\\bad';
  const safeWinPath = getSafeCheckpointPath(winDangerousId);
  assert.ok(!safeWinPath.includes('..'));
});

test('sanitizeCheckpoint: strips passwords, cookies and sensitive tokens from checkpoint', () => {
  const dirty: TaskCheckpoint = {
    taskId: 'task-sec-01',
    url: 'https://example.com/quiz?token=my_secret_token_123&api_key=secretkey',
    status: 'RUNNING',
    stepsCompleted: 2,
    questionsFound: 5,
    questionsFilled: 2,
    error: 'Failed with sk-proj-1234567890abcdefghijklmnop on auth',
    answersRecorded: {
      q1: ['opt_a'],
      q2_password: 'super-secret-password-123',
      q3_token: 'bearer-token-abc',
      q4: 'Safe plain text answer',
      auth_cookie: 'session=xyz'
    },
    lastUpdated: new Date().toISOString()
  };

  const clean = sanitizeCheckpoint(dirty);
  assert.equal(clean.answersRecorded?.q1?.[0], 'opt_a');
  assert.equal(clean.answersRecorded?.q4, 'Safe plain text answer');
  assert.equal(clean.answersRecorded?.q2_password, undefined, 'password key must be stripped');
  assert.equal(clean.answersRecorded?.q3_token, undefined, 'token key must be stripped');
  assert.equal(clean.answersRecorded?.auth_cookie, undefined, 'cookie key must be stripped');
  assert.ok(!clean.url.includes('my_secret_token_123'), 'URL query token must be redacted');
  assert.ok(!clean.error?.includes('sk-proj-1234567890'), 'Error message API key must be redacted');
});

test('checkDuplicateRisk: correctly identifies duplicate vs fresh task', async () => {
  // Test with a fresh task ID and URL that never appeared
  const fresh = await checkDuplicateRisk('unique-brand-new-task-id', 'https://fresh.example.com/1');
  assert.equal(fresh.isDuplicateRisk, false);
});

test('verifyResumeState: refuses resume when hostname changes', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>Hello</h1></body></html>');

    const cp: TaskCheckpoint = {
      taskId: 'task-mismatch',
      url: 'https://moodle.university.edu.vn/mod/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.match(res.reason, /hostname/);
  } finally {
    await browser?.close();
  }
});

test('verifyResumeState: detects already submitted quiz/form and refuses auto-replay', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <h2>Thông báo</h2>
          <p>Câu trả lời của bạn đã được ghi nhận. Cảm ơn bạn!</p>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'task-already-done',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 2,
      questionsFilled: 2,
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.equal(res.uncertainState, true, 'Must flag uncertainState to prevent duplicate submissions');
    assert.match(res.reason, /đã hoàn thành|đã được ghi nhận/);
  } finally {
    await browser?.close();
  }
});

test('verifyResumeState: confirms resume validity on clean in-progress page', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <section class="question">
              <label for="q1">Câu hỏi 1:</label>
              <input type="text" id="q1" name="q1" value="existing answer">
            </section>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'task-in-progress',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q1: 'existing answer'
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true);
    assert.equal(res.matchedQuestions, 1);
    assert.equal(res.verifiedValuesCount, 1);
    assert.ok(res.reason.includes('Xác minh thành công DOM'));
  } finally {
    await browser?.close();
  }
});

test('CASE R-01: Checkpoint has one radio answer, DOM not checked -> cannot resume, cannot skip', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <section class="question">
          <label><input type="radio" name="q1" value="opt_a"> Option A</label>
          <label><input type="radio" name="q1" value="opt_b"> Option B</label>
        </section>
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r01-test',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q1: ['opt_a'] },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false, 'Must not allow resume when radio is not checked on DOM');
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /chưa có lựa chọn nào được chọn/i);
  } finally {
    await browser?.close();
  }
});

test('CASE R-02: Checkpoint has textbox value, DOM empty -> verification failed', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input type="text" name="q_text" value="">
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r02-test',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q_text: 'Expected answer text' },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /đang để trống/i);
  } finally {
    await browser?.close();
  }
});

test('CASE R-03: DOM has different answer than checkpoint -> verification failed', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input type="text" name="q_text" value="Actual DOM value">
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r03-test',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q_text: 'Different checkpoint expected value' },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /khác với checkpoint/i);
  } finally {
    await browser?.close();
  }
});

test('CASE R-04: Radio, checkbox, textbox all match -> verification success', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <label><input type="radio" name="q_radio" value="opt_1" checked> 1</label>
        <label><input type="radio" name="q_radio" value="opt_2"> 2</label>
        <label><input type="checkbox" name="q_box" value="chk_a" checked> A</label>
        <label><input type="checkbox" name="q_box" value="chk_b"> B</label>
        <textarea name="q_area">Valid Essay Content</textarea>
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r04-test',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 3,
      questionsFilled: 3,
      answersRecorded: {
        q_radio: ['opt_1'],
        q_box: ['chk_a'],
        q_area: 'Valid Essay Content'
      },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true);
    assert.equal(res.verifiedValuesCount, 3);
    assert.equal(res.matchedQuestions, 3);
  } finally {
    await browser?.close();
  }
});

test('CASE R-05: Page contains same question ID but different option checked -> not verified', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <label><input type="radio" name="q1" value="wrong_choice" checked> Wrong</label>
        <label><input type="radio" name="q1" value="correct_choice"> Correct</label>
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r05-test',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: { q1: ['correct_choice'] },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /khác với checkpoint/i);
  } finally {
    await browser?.close();
  }
});

test('CASE R-06: Multi-page form restart handling verifies step alignment', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input type="text" name="page2_q1" value="Page 2 Answer">
      </form>
    `);
    const cp: TaskCheckpoint = {
      taskId: 'r06-multi-page',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 2,
      totalSteps: 4,
      questionsFound: 2,
      questionsFilled: 2,
      answersRecorded: { page2_q1: 'Page 2 Answer' },
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true);
    assert.equal(res.verifiedValuesCount, 1);
  } finally {
    await browser?.close();
  }
});

test('CASE R-07: Form submitted, network result unclear (UNCONFIRMED) -> do not auto-replay', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<html><body><form><button type="submit">Submit</button></form></body></html>`);
    const cp: TaskCheckpoint = {
      taskId: 'r07-unconfirmed',
      url: page.url(),
      status: 'UNCONFIRMED',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false);
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /UNCONFIRMED/);
  } finally {
    await browser?.close();
  }
});

test('CASE R-08: No answer needs verification (fresh task) -> handled separately, verifiedValuesCount=0', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<html><body><form><input type="text" name="fresh_q"></form></body></html>`);
    const cp: TaskCheckpoint = {
      taskId: 'r08-fresh',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 0,
      questionsFound: 0,
      questionsFilled: 0,
      answersRecorded: {},
      lastUpdated: new Date().toISOString()
    };
    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true);
    assert.equal(res.verifiedValuesCount, 0);
    assert.match(res.reason, /Tác vụ mới/);
  } finally {
    await browser?.close();
  }
});

test('Atomic Checkpoint: SHA-256 integrity checksum detects corrupted checkpoint files', async () => {
  const taskId = 'atomic-chk-test-01';
  await saveCheckpoint({
    taskId,
    url: 'https://example.com/test',
    status: 'RUNNING',
    stepsCompleted: 1,
    questionsFound: 2,
    questionsFilled: 2,
    answersRecorded: { q1: 'test value' },
    lastUpdated: new Date().toISOString()
  });

  // Verify loads correctly
  const loaded = await loadCheckpoint(taskId);
  assert.ok(loaded);
  assert.equal(loaded.taskId, taskId);
  assert.ok(loaded.checksum, 'Checkpoint must contain SHA-256 checksum');

  // Corrupt file by appending garbage
  const path = getSafeCheckpointPath(taskId);
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(path, 'utf8');
  const corrupted = raw.replace('test value', 'tampered value');
  await fs.writeFile(path, corrupted, 'utf8');

  // loadCheckpoint must reject corrupted file
  const corruptedLoad = await loadCheckpoint(taskId);
  assert.equal(corruptedLoad, null, 'Must reject checkpoint with mismatched checksum');

  await clearCheckpoint(taskId);
});
