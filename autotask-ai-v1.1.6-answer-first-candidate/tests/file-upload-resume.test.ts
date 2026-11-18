/** File Upload Resume & Verification Regression Tests (AUDIT-01 Remediation)
 * Verifies strict file verification, fail-closed handling for unsupported controls, and atomic checkpoint durability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import {
  verifyResumeState,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  type TaskCheckpoint
} from '../src/task-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

test('U-01: File input with 0 files attached on DOM fails resume verification (no false positive)', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <label for="q_file">Tải lên bài tập:</label>
            <input type="file" id="q_file" name="q_file" data-atqa-id="q_file">
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-u01-empty-file',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_file: { fileName: 'assignment_report.docx' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false, 'Must NOT verify empty file input');
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /chưa có tệp nào được đính kèm/i);
  } finally {
    await browser?.close();
  }
});

test('U-02: File input with attached file matching checkpoint fileName verifies successfully', async () => {
  let browser: Browser | undefined;
  const tempDir = mkdtempSync(join(tmpdir(), 'autotask-u02-'));
  const tempFilePath = join(tempDir, 'u02_sample.docx');
  writeFileSync(tempFilePath, 'Sample Word document content for test');

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <label for="q_file">Tải lên bài tập:</label>
            <input type="file" id="q_file" name="q_file" data-atqa-id="q_file">
          </form>
        </body>
      </html>
    `);

    // Attach matching file
    await page.setInputFiles('input[type="file"]', tempFilePath);

    const cp: TaskCheckpoint = {
      taskId: 'test-u02-matching-file',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_file: { fileName: 'u02_sample.docx' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true, 'Must verify when attached file matches checkpoint');
    assert.equal(res.verifiedValuesCount, 1);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    await browser?.close();
  }
});

test('U-03: File input with attached file having different fileName fails verification', async () => {
  let browser: Browser | undefined;
  const tempDir = mkdtempSync(join(tmpdir(), 'autotask-u03-'));
  const tempFilePath = join(tempDir, 'wrong_file.pdf');
  writeFileSync(tempFilePath, 'Wrong document content');

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <label for="q_file">Tải lên bài tập:</label>
            <input type="file" id="q_file" name="q_file" data-atqa-id="q_file">
          </form>
        </body>
      </html>
    `);

    // Attach mismatched file
    await page.setInputFiles('input[type="file"]', tempFilePath);

    const cp: TaskCheckpoint = {
      taskId: 'test-u03-mismatched-file',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_file: { fileName: 'expected_report.docx' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false, 'Must fail verification when file names do not match');
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /không khớp với checkpoint/i);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    await browser?.close();
  }
});

test('U-04: Server-rendered upload chip / filename indicator matching checkpoint verifies successfully', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <div class="question" data-atqa-id="q_file">
              <label for="q_file">Tải lên bài tập:</label>
              <input type="file" id="q_file" name="q_file" data-atqa-id="q_file">
              <div class="upload-chip">
                <span class="filename">final_submission_2026.docx</span>
                <span class="file-uploaded">Đã tải lên máy chủ</span>
              </div>
            </div>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-u04-chip-confirmation',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_file: { fileName: 'final_submission_2026.docx' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, true, 'Server-rendered file chip confirmation must verify');
    assert.equal(res.verifiedValuesCount, 1);
  } finally {
    await browser?.close();
  }
});

test('U-04b: Upload chip belonging to a different question container is NOT mistakenly accepted', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <div class="question" id="q_other_container">
              <span>Câu hỏi 1 khác:</span>
              <div class="upload-chip"><span class="filename">other_file.docx</span></div>
            </div>
            <div class="question" id="q_file_container">
              <span>Câu hỏi 2 upload:</span>
              <input type="file" id="q_file" name="q_file" data-atqa-id="q_file">
            </div>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-u04b-scoped-chip',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_file: { fileName: 'other_file.docx' }
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false, 'Must NOT accept upload chip from a different question container');
    assert.equal(res.uncertainState, true);
  } finally {
    await browser?.close();
  }
});

test('U-05: Unrecognized / unsupported custom input widget fails closed (no fail-open bypass)', async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <form>
            <div id="q_custom" data-atqa-id="q_custom" class="custom-drawing-canvas">
              <canvas width="200" height="100"></canvas>
            </div>
          </form>
        </body>
      </html>
    `);

    const cp: TaskCheckpoint = {
      taskId: 'test-u05-unhandled-control',
      url: page.url(),
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      answersRecorded: {
        q_custom: 'custom_drawing_vector_data'
      },
      lastUpdated: new Date().toISOString()
    };

    const res = await verifyResumeState(page, cp);
    assert.equal(res.canResume, false, 'Must fail-closed for unhandled custom controls');
    assert.equal(res.uncertainState, true);
    assert.match(res.reason, /chưa được xác minh an toàn/i);
  } finally {
    await browser?.close();
  }
});

test('U-06: Atomic checkpoint durability with fsync flush creates valid checksum and persists reliably', async () => {
  const taskId = 'test-u06-fsync-durability';
  const cp: TaskCheckpoint = {
    taskId,
    url: 'https://lms.hust.edu.vn/mod/quiz/attempt.php?id=123',
    currentStepUrl: 'https://lms.hust.edu.vn/mod/quiz/attempt.php?id=123&page=2',
    status: 'RUNNING',
    stepsCompleted: 2,
    totalSteps: 3,
    questionsFound: 4,
    questionsFilled: 4,
    answersByStep: {
      1: { q1: { text: 'Answer 1' }, q2: { selected: ['opt_a'] } },
      2: { q3: { text: 'Answer 3' }, q4: { fileName: 'report.docx' } }
    },
    answersRecorded: {
      q1: { text: 'Answer 1' },
      q2: { selected: ['opt_a'] },
      q3: { text: 'Answer 3' },
      q4: { fileName: 'report.docx' }
    },
    lastUpdated: new Date().toISOString()
  };

  await saveCheckpoint(cp);
  const loaded = await loadCheckpoint(taskId);
  assert.ok(loaded, 'Saved checkpoint must load successfully');
  assert.equal(loaded.taskId, taskId);
  assert.equal(loaded.stepsCompleted, 2);
  assert.ok(loaded.checksum, 'Checkpoint must contain SHA-256 integrity checksum');
  assert.ok(loaded.answersByStep?.[1]?.q1, 'answersByStep must be preserved');
  assert.ok(loaded.answersByStep?.[2]?.q4, 'answersByStep step 2 must be preserved');

  await clearCheckpoint(taskId);
  const afterClear = await loadCheckpoint(taskId);
  assert.equal(afterClear, null, 'Checkpoint must be cleared cleanly');
});
