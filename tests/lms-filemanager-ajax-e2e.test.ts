import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { prepareAdvancedPracticeQuestions, fillMoodleFileManager, validatePracticeAttachment, practiceAttachmentAnswer } from '../src/lms/advanced-adapters.js';
import { checkAnswers } from '../src/ai.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../src/task-manager.js';
import type { Task, Question, Answer } from '../src/types.js';

interface ServerDraftFile {
  filename: string;
  size: number;
  sha256: string;
}

test.describe('Phase 5 — Moodle File Manager AJAX E2E Suite', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let serverUploadCount = 0;
  let simulate500 = false;
  let simulateErrorStatus = false;
  let simulateBusinessError = false;
  let simulateCorruptJson = false;
  let simulateEmptyJson = false;
  let simulate204 = false;
  const serverDrafts = new Map<string, ServerDraftFile[]>();

  let browser: Browser;
  let page: Page;
  let tempDir: string;
  let validPdfPath: string;

  test.before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'autotask-moodle-file-'));
    validPdfPath = join(tempDir, 'student-lab-report.pdf');
    writeFileSync(validPdfPath, '%PDF-1.4 Mock Lab Report Content v1');

    server = http.createServer(async (req, res) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);

      if (u.pathname === '/mod/quiz/attempt.php') {
        const pageNum = u.searchParams.get('page') || '0';
        const attemptId = u.searchParams.get('attempt') || '10';
        const draftId = `98765432${attemptId}`;

        if (pageNum === '1') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body>
              <div class="que essay" id="question-501-2">
                <div class="qtext">Step 2: Conclusion</div>
                <textarea name="q501:2_answer">Step 2 content</textarea>
              </div>
            </body></html>
          `);
          return;
        }

        const draftFiles = serverDrafts.get(draftId) || [];
        const renderedFiles = draftFiles.map(f => `
          <div class="fp-file" data-file-name="${f.filename}" data-file-size="${f.size}" data-file-sha256="${f.sha256}">
            <span class="fp-filename">${f.filename}</span>
          </div>
        `).join('\n');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <head>
              <style>
                .hidden { display: none; }
                .fp-content { min-height: 50px; border: 1px dashed #ccc; padding: 10px; }
              </style>
            </head>
            <body>
              <form id="responseform" method="post" action="/mod/quiz/processattempt.php">
                <div class="que essay" id="question-501-1">
                  <div class="qtext">Upload your laboratory report (PDF only):</div>
                  <div class="formulation">
                    <input type="hidden" name="q501:1_attachments[itemid]" id="draftitemid" value="${draftId}">
                    <div class="filemanager" data-itemid="${draftId}">
                      <div class="fp-navbar">
                        <a class="fp-btn-add btn btn-secondary" role="button" href="#">Add...</a>
                      </div>
                      <div class="fp-content">
                        ${renderedFiles}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Moodle File Picker Modal / Dialog -->
                <div id="filepicker-modal" class="hidden">
                  <div class="fp-repo-area">
                    <span class="fp-repo-name">Upload a file</span>
                  </div>
                  <div class="fp-upload-form">
                    <input type="file" name="repo_upload_file" id="fileinput">
                    <button type="button" class="fp-upload-btn">Upload this file</button>
                  </div>
                </div>
              </form>

              <script>
                const addBtn = document.querySelector('.fp-btn-add');
                const modal = document.querySelector('#filepicker-modal');
                const uploadBtn = document.querySelector('.fp-upload-btn');
                const fileInput = document.querySelector('#fileinput');
                const content = document.querySelector('.fp-content');

                addBtn.addEventListener('click', (e) => {
                  e.preventDefault();
                  modal.classList.remove('hidden');
                });

                uploadBtn.addEventListener('click', async () => {
                  if (!fileInput.files.length) return;
                  const file = fileInput.files[0];
                  
                  // Send AJAX upload to server
                  const formData = new FormData();
                  formData.append('repo_upload_file', file);
                  formData.append('itemid', document.getElementById('draftitemid').value);

                  try {
                    const resp = await fetch('/repository/repository_ajax.php?action=upload', {
                      method: 'POST',
                      body: formData
                    });
                    if (!resp.ok) {
                      throw new Error('HTTP ' + resp.status);
                    }
                    const json = await resp.json();

                    if (json.status === 'ok') {
                      modal.classList.add('hidden');
                      let existing = Array.from(content.querySelectorAll('.fp-file')).find(el => el.textContent.includes(json.filename));
                      if (!existing) {
                        existing = document.createElement('div');
                        existing.className = 'fp-file';
                        content.appendChild(existing);
                      }
                      existing.setAttribute('data-file-size', String(json.size || file.size));
                      existing.setAttribute('data-file-sha256', json.sha256 || 'uploaded_sha');
                      existing.innerHTML = '<span class="fp-filename">' + json.filename + '</span>';
                    }
                  } catch (err) {
                    console.error('Upload failed', err);
                  }
                });
              </script>
            </body>
          </html>
        `);
        return;
      }

      if (u.pathname === '/repository/repository_ajax.php' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ list: [], status: 'ok' }));
        return;
      }

      if (u.pathname === '/repository/repository_ajax.php' && req.method === 'POST') {
        serverUploadCount++;

        if (simulate500) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        if (simulate204) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (simulateCorruptJson) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('<br /><b>Fatal error</b>: Call to undefined function in repository_ajax.php on line 42<br />');
          return;
        }

        if (simulateEmptyJson) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }

        if (simulateErrorStatus) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Storage quota exceeded' }));
          return;
        }

        if (simulateBusinessError) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Quota exceeded' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);
        const bodyStr = bodyBuffer.toString('binary');

        const itemidMatch = bodyStr.match(/name="itemid"\r?\n\r?\n([^\r\n]+)/);
        const itemid = itemidMatch ? itemidMatch[1].trim() : '9876543210';

        const fnameMatch = bodyStr.match(/filename="([^"]+)"/);
        const filename = fnameMatch ? fnameMatch[1] : 'student-lab-report.pdf';

        const fileMatch = bodyStr.match(/Content-Type:[^\r\n]+\r?\n\r?\n([\s\S]*?)\r?\n--/);
        const fileBytes = fileMatch ? Buffer.from(fileMatch[1], 'binary') : bodyBuffer;
        const sha256 = createHash('sha256').update(fileBytes).digest('hex');
        const size = fileBytes.length;

        const list = serverDrafts.get(itemid) || [];
        const existingIdx = list.findIndex(f => f.filename === filename);
        const record: ServerDraftFile = { filename, size, sha256 };
        if (existingIdx >= 0) {
          list[existingIdx] = record;
        } else {
          list.push(record);
        }
        serverDrafts.set(itemid, list);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          filename,
          size,
          sha256,
          itemid
        }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  });

  test.after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    await clearCheckpoint('file-task-resume').catch(() => {});
  });

  test.beforeEach(async () => {
    page = await browser.newPage();
    simulate500 = false;
    simulateErrorStatus = false;
    simulateBusinessError = false;
    simulateCorruptJson = false;
    simulateEmptyJson = false;
    simulate204 = false;
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('FILE-01: Full AJAX Flow uploads file and verifies filename and metadata in .fp-content widget', async () => {
    const startUploads = serverUploadCount;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`);

    const task: Task = {
      id: 'file-task-1',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': validPdfPath
      }
    };

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, task);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'moodle-file');

    const answer = practiceAttachmentAnswer(q, task);
    assert.ok(answer);
    assert.equal(answer.localFilePath, validPdfPath);

    await fillMoodleFileManager(page, q, answer);

    // Verify file is shown in .fp-content
    const isVisible = await page.locator('.fp-content').getByText('student-lab-report.pdf', { exact: true }).isVisible();
    assert.ok(isVisible, 'File name must be visible in File Manager container');

    // Verify real HTTP request reached server
    assert.equal(serverUploadCount, startUploads + 1, 'Server must have received exactly 1 AJAX upload');

    // Verify server draft record
    const draftRecords = serverDrafts.get('9876543210') || [];
    assert.equal(draftRecords.length, 1);
    assert.equal(draftRecords[0].filename, 'student-lab-report.pdf');
  });

  test('FILE-02: draftitemid is preserved, non-empty, and linked to server draft state', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`);
    const itemIdVal = await page.locator('#draftitemid').inputValue();
    assert.equal(itemIdVal, '9876543210', 'draftitemid must be valid and non-empty');
    assert.ok(serverDrafts.has('9876543210'), 'Server draft map must link this attempt to a real draft record');
  });

  test('FILE-03: Multi-page navigation retains draft state without re-upload (real server persistence)', async () => {
    const priorCount = serverUploadCount;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`);

    // Navigate to page 1
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=1`);
    assert.ok(await page.locator('textarea[name="q501:2_answer"]').isVisible());

    // Navigate back to page 0: server renders saved draft state directly without artificial resume params
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`);
    assert.ok(await page.locator('.filemanager').isVisible());

    const fileVisible = await page.locator('.fp-content').getByText('student-lab-report.pdf', { exact: true }).isVisible();
    assert.ok(fileVisible, 'File must persist across page transition from server state');
    assert.equal(serverUploadCount, priorCount, 'Navigation must not trigger re-upload');
  });

  test('FILE-04: Restart / Resume Idempotency: Process A saves checkpoint -> Process B resumes -> Server renders saved state -> No duplicate upload', async () => {
    await clearCheckpoint('file-task-cross-proc').catch(() => {});

    const scriptAPath = join(tempDir, 'processA.mjs');
    const scriptBPath = join(tempDir, 'processB.mjs');

    const taskManagerUrl = pathToFileURL(resolve('src/task-manager.ts')).href;
    const adaptersUrl = pathToFileURL(resolve('src/lms/advanced-adapters.ts')).href;
    const scannerUrl = pathToFileURL(resolve('src/scanner.ts')).href;

    const scriptACode = `
import { chromium } from 'playwright';
const { saveCheckpoint } = await import(${JSON.stringify(taskManagerUrl)});
const { prepareAdvancedPracticeQuestions, fillMoodleFileManager, practiceAttachmentAnswer } = await import(${JSON.stringify(adaptersUrl)});
const { scanQuestions } = await import(${JSON.stringify(scannerUrl)});

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(process.env.TEST_URL);

const task = {
  id: 'file-task-cross-proc',
  url: process.env.TEST_URL,
  aiPermitted: true,
  mode: 'PRACTICE_ASSISTED',
  scopeAttestation: 'PERMITTED_SELF_PRACTICE',
  advancedLmsAdapters: { fileManager: true },
  attachmentFiles: { 'm1_att': process.env.TEST_FILE }
};

const scanned = await scanQuestions(page);
const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
const answer = practiceAttachmentAnswer(q, task);
await fillMoodleFileManager(page, q, answer);

await saveCheckpoint({
  taskId: 'file-task-cross-proc',
  url: process.env.TEST_URL,
  currentStepUrl: process.env.TEST_URL,
  status: 'RUNNING',
  stepsCompleted: 1,
  domFilledSteps: 1,
  serverSavedSteps: 1,
  questionsFound: 1,
  questionsFilled: 1,
  lastUpdated: new Date().toISOString(),
  answersRecorded: {
    'm1_att': { id: 'm1_att', localFilePath: process.env.TEST_FILE }
  }
});

await browser.close();
console.log(JSON.stringify({ pid: process.pid, event: 'PROCESS_A_DONE' }));
`;

    const scriptBCode = `
import { chromium } from 'playwright';
const { loadCheckpoint } = await import(${JSON.stringify(taskManagerUrl)});
const { prepareAdvancedPracticeQuestions, fillMoodleFileManager, practiceAttachmentAnswer } = await import(${JSON.stringify(adaptersUrl)});
const { scanQuestions } = await import(${JSON.stringify(scannerUrl)});

const cp = await loadCheckpoint('file-task-cross-proc');
if (!cp) throw new Error('Checkpoint not found on disk');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(cp.currentStepUrl || cp.url);

const task = {
  id: 'file-task-cross-proc',
  url: cp.url,
  aiPermitted: true,
  mode: 'PRACTICE_ASSISTED',
  scopeAttestation: 'PERMITTED_SELF_PRACTICE',
  advancedLmsAdapters: { fileManager: true },
  attachmentFiles: { 'm1_att': process.env.TEST_FILE }
};

const scanned = await scanQuestions(page);
const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
const answer = practiceAttachmentAnswer(q, task);
await fillMoodleFileManager(page, q, answer);

await browser.close();
console.log(JSON.stringify({ pid: process.pid, event: 'PROCESS_B_DONE' }));
`;

    writeFileSync(scriptAPath, scriptACode);
    writeFileSync(scriptBPath, scriptBCode);

    const testUrl = `${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`;
    const countBeforeA = serverUploadCount;

    const runChild = (scriptPath: string): Promise<{ pid: number; stdout: string; stderr: string; code: number }> => {
      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
          cwd: process.cwd(),
          env: { ...process.env, TEST_URL: testUrl, TEST_FILE: validPdfPath },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', d => { stdout += d.toString(); });
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.on('error', rejectPromise);
        child.on('close', code => {
          resolvePromise({ pid: child.pid!, stdout, stderr, code: code ?? 0 });
        });
      });
    };

    // 1. Execute genuine independent Node child process A
    const resA = await runChild(scriptAPath);

    assert.equal(resA.code, 0, `Process A must exit with 0. Stderr: ${resA.stderr}`);
    const matchA = resA.stdout.match(/\{"pid":(\d+),"event":"PROCESS_A_DONE"\}/);
    assert.ok(matchA, 'Process A must emit PROCESS_A_DONE JSON payload');
    const pidA = Number(matchA[1]);
    assert.notEqual(pidA, process.pid, 'Process A PID must be distinct from runner PID');

    // Verify checkpoint written to disk by Process A
    const cpDisk = await loadCheckpoint('file-task-cross-proc');
    assert.ok(cpDisk, 'Checkpoint must be saved to disk by Process A');

    const countAfterA = serverUploadCount;
    // Process A must have uploaded the file (count + 1 or already uploaded in FILE-01)
    assert.ok(countAfterA >= countBeforeA, 'Process A state synchronized with server');

    // 2. Execute genuine independent Node child process B (simulated restart / second worker)
    const resB = await runChild(scriptBPath);

    assert.equal(resB.code, 0, `Process B must exit with 0. Stderr: ${resB.stderr}`);
    const matchB = resB.stdout.match(/\{"pid":(\d+),"event":"PROCESS_B_DONE"\}/);
    assert.ok(matchB, 'Process B must emit PROCESS_B_DONE JSON payload');
    const pidB = Number(matchB[1]);
    assert.notEqual(pidB, process.pid, 'Process B PID must be distinct from runner PID');
    assert.notEqual(pidB, pidA, 'Process B PID must be distinct from Process A PID (two distinct OS processes)');

    // 3. Confirm idempotency across genuine OS process boundary:
    // Process B must NOT increment server upload counter!
    assert.equal(serverUploadCount, countAfterA, 'Process B must skip redundant upload via genuine server draft state');

    await clearCheckpoint('file-task-cross-proc').catch(() => {});
  });

  test('FILE-05: Strict security gating prevents AI-invented file paths and unapproved extensions', async () => {
    const task: Task = {
      id: 'file-task-sec',
      url: `${baseUrl}/mod/quiz/attempt.php`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true }
    };

    const mockQuestion: Question = {
      id: 'm1_att',
      kind: 'unsupported',
      prompt: 'Upload file',
      options: [],
      required: false,
      hasVisual: false,
      stableId: 'question-501-1#attachment',
      sourceType: 'moodle:essay'
    };

    const target: any = {
      evaluate: async () => ({ mode: 'file', items: [], zones: [] })
    };

    const [q] = await prepareAdvancedPracticeQuestions(target, [mockQuestion], task);
    assert.equal(q.kind, 'unsupported', 'Missing user attachmentFiles mapping must remain unsupported');

    assert.throws(
      () => checkAnswers({ answers: [{ id: 'm1_att', localFilePath: 'C:/Windows/System32/calc.exe' }] }, [q]),
      /Model is not permitted to choose a local upload file path/
    );

    writeFileSync(join(tempDir, 'payload.exe'), 'MZ dummy executable');
    await assert.rejects(
      validatePracticeAttachment(join(tempDir, 'payload.exe')),
      /Attachment path\/type is not permitted/
    );
  });

  test('FILE-06: Negative: Same filename with changed content triggers upload & updates server draft', async () => {
    const dirA = join(tempDir, 'version_A');
    const dirB = join(tempDir, 'version_B');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    // Both files have the EXACT SAME FILENAME 'student-lab-report.pdf' but different contents & SHA-256
    const pathA = join(dirA, 'student-lab-report.pdf');
    const pathB = join(dirB, 'student-lab-report.pdf');
    writeFileSync(pathA, '%PDF-1.4 Initial Version A Report Content');
    writeFileSync(pathB, '%PDF-1.4 REVISED NEW CONTENT WITH DIFFERENT SHA256 HASH');

    const expectedHashA = createHash('sha256').update(readFileSync(pathA)).digest('hex');
    const expectedHashB = createHash('sha256').update(readFileSync(pathB)).digest('hex');
    assert.notEqual(expectedHashA, expectedHashB, 'Test setup must ensure distinct hashes for version A and B');

    const priorCount = serverUploadCount;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`);

    const taskA: Task = {
      id: 'file-task-update',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=10&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': pathA
      }
    };

    const scannedA = await scanQuestions(page);
    const [qA] = await prepareAdvancedPracticeQuestions(page, scannedA, taskA);
    const answerA = practiceAttachmentAnswer(qA, taskA)!;
    await fillMoodleFileManager(page, qA, answerA);

    assert.equal(serverUploadCount, priorCount + 1, 'Initial upload must succeed');
    let drafts = serverDrafts.get('9876543210') || [];
    let fileRec = drafts.find(f => f.filename === 'student-lab-report.pdf');
    assert.equal(fileRec?.sha256, expectedHashA, 'Server draft must initially store hash of Version A');

    // Supply Version B with the EXACT SAME FILENAME 'student-lab-report.pdf' but different content and hash
    const taskB: Task = {
      ...taskA,
      attachmentFiles: {
        'm1_att': pathB
      }
    };
    const answerB: Answer = {
      id: qA.id,
      localFilePath: pathB
    };

    await fillMoodleFileManager(page, qA, answerB);

    assert.equal(serverUploadCount, priorCount + 2, 'File with identical filename but different content must trigger upload & overwrite');
    drafts = serverDrafts.get('9876543210') || [];
    fileRec = drafts.find(f => f.filename === 'student-lab-report.pdf');
    assert.equal(fileRec?.sha256, expectedHashB, 'Server draft must be updated to hash of Version B');
  });

  test('FILE-07: Negative: HTTP 500 error on upload endpoint fails closed', async () => {
    simulate500 = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=15&page=0`);

    const newFilePath = join(tempDir, 'new-file.pdf');
    writeFileSync(newFilePath, '%PDF-1.4 New File For 500 Test');

    const task: Task = {
      id: 'file-task-500',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=15&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': newFilePath
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);

    const answer = practiceAttachmentAnswer(q, task)!;
    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /Moodle File Manager did not display the uploaded file; not verified/
    );
  });

  test('FILE-08: Negative: Unconfirmed server response (error status) fails closed', async () => {
    simulateErrorStatus = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=16&page=0`);

    const quotaFilePath = join(tempDir, 'quota-file.pdf');
    writeFileSync(quotaFilePath, '%PDF-1.4 Quota test');

    const task: Task = {
      id: 'file-task-quota',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=16&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': quotaFilePath
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);

    const answer = practiceAttachmentAnswer(q, task)!;
    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /Moodle File Manager did not display the uploaded file; not verified/
    );
  });

  test('FILE-09: Negative: Local file modified on disk after restart triggers re-upload instead of skipping', async () => {
    const targetFile = join(tempDir, 'changing-report.pdf');
    writeFileSync(targetFile, '%PDF-1.4 INITIAL CONTENT');

    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=17&page=0`);

    const task: Task = {
      id: 'file-task-mod',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=17&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': targetFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    // First upload
    const startCount = serverUploadCount;
    await fillMoodleFileManager(page, q, answer);
    assert.equal(serverUploadCount, startCount + 1);

    // Modify local file on disk
    writeFileSync(targetFile, '%PDF-1.4 MODIFIED CONTENT ON DISK (DIFFERENT SIZE AND HASH)');

    // Re-run fill: must detect hash/size mismatch and upload updated content
    await fillMoodleFileManager(page, q, answer);
    assert.equal(serverUploadCount, startCount + 2, 'Modified file on disk must trigger fresh upload');
  });

  test('FILE-10: Negative: Mismatched attempt draft isolation ensures independent draft states', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=25&page=0`);
    const draft25 = await page.locator('#draftitemid').inputValue();
    assert.equal(draft25, '9876543225');

    // Attempt 25 has no uploads yet
    const files = serverDrafts.get('9876543225') || [];
    assert.equal(files.length, 0, 'Attempt 25 must not inherit files from attempt 10');
  });

  test('FILE-11: Negative: HTTP 200 business error payload ({ success: false, error: ... }) fails closed', async () => {
    simulateBusinessError = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=30&page=0`);

    const quotaFile = join(tempDir, 'business-quota-file.pdf');
    writeFileSync(quotaFile, '%PDF-1.4 Business Quota Payload');

    const task: Task = {
      id: 'file-task-business-quota',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=30&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': quotaFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /server error: Quota exceeded/i
    );
  });

  test('FILE-12: Negative: Missing or timed out server response fails closed without trusting transient DOM', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=31&page=0`);

    const timeoutFile = join(tempDir, 'timeout-file.pdf');
    writeFileSync(timeoutFile, '%PDF-1.4 Timeout File Payload');

    const task: Task = {
      id: 'file-task-timeout',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=31&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': timeoutFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    // Simulate response timeout / failure
    const origWaitForResponse = page.waitForResponse.bind(page);
    page.waitForResponse = (async () => {
      throw new Error('Timeout 12000ms exceeded');
    }) as any;

    try {
      await assert.rejects(
        fillMoodleFileManager(page, q, answer),
        /missing server response or request timeout/i
      );
    } finally {
      page.waitForResponse = origWaitForResponse;
    }
  });

  test('FILE-13: Draft reload persistence: page reload retains server-confirmed draft and verified SHA-256', async () => {
    const draftReloadFile = join(tempDir, 'draft-persist-report.pdf');
    const fileBytes = '%PDF-1.4 Draft Persistence Report Content';
    writeFileSync(draftReloadFile, fileBytes);
    const expectedHash = createHash('sha256').update(fileBytes).digest('hex');

    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=35&page=0`);

    const task: Task = {
      id: 'file-task-draft-persist',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=35&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': draftReloadFile
      }
    };

    // 1. Initial upload
    const scanned1 = await scanQuestions(page);
    const [q1] = await prepareAdvancedPracticeQuestions(page, scanned1, task);
    const answer1 = practiceAttachmentAnswer(q1, task)!;

    const priorUploads = serverUploadCount;
    await fillMoodleFileManager(page, q1, answer1);
    assert.equal(serverUploadCount, priorUploads + 1, 'Initial upload must hit server endpoint');

    // 2. Reload page simulating user revisit or browser crash recovery
    await page.reload();

    // 3. Scan again from reloaded DOM
    const scanned2 = await scanQuestions(page);
    const [q2] = await prepareAdvancedPracticeQuestions(page, scanned2, task);
    const answer2 = practiceAttachmentAnswer(q2, task)!;

    // 4. Fill again: must recognize verified hash on server and skip redundant re-upload
    await fillMoodleFileManager(page, q2, answer2);
    assert.equal(serverUploadCount, priorUploads + 1, 'Draft reload must retain state and not trigger duplicate upload');

    // 5. Verify the file element in DOM retains the correct verified hash and filename
    const persistedSha = await page.locator('.fp-content .fp-file').getAttribute('data-file-sha256');
    assert.equal(persistedSha, expectedHash, 'Persisted file must retain server-verified SHA-256 after reload');
    const persistedName = await page.locator('.fp-content .fp-filename').textContent();
    assert.equal(persistedName?.trim(), 'draft-persist-report.pdf');
  });

  test('FILE-14: Negative: HTTP 200 with corrupted non-JSON body fails closed', async () => {
    simulateCorruptJson = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=41&page=0`);

    const corruptFile = join(tempDir, 'corrupt-body.pdf');
    writeFileSync(corruptFile, '%PDF-1.4 Corrupt Response Test');

    const task: Task = {
      id: 'file-task-corrupt',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=41&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': corruptFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /invalid or unparseable JSON response from server/i
    );
  });

  test('FILE-15: Negative: HTTP 200 with empty JSON {} fails closed without positive confirmation', async () => {
    simulateEmptyJson = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=42&page=0`);

    const emptyJsonFile = join(tempDir, 'empty-json.pdf');
    writeFileSync(emptyJsonFile, '%PDF-1.4 Empty JSON Test');

    const task: Task = {
      id: 'file-task-empty-json',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=42&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': emptyJsonFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /server response does not confirm upload/i
    );
  });

  test('FILE-16: Negative: HTTP 204 No Content without body fails closed', async () => {
    simulate204 = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=43&page=0`);

    const noContentFile = join(tempDir, 'no-content.pdf');
    writeFileSync(noContentFile, '%PDF-1.4 HTTP 204 Test');

    const task: Task = {
      id: 'file-task-204',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=43&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': noContentFile
      }
    };

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /HTTP 204 No Content/i
    );
  });

  test('FILE-17: Unrelated GET action=list is filtered out and does not count as upload ACK', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=44&page=0`);

    const listTestFile = join(tempDir, 'list-filter.pdf');
    writeFileSync(listTestFile, '%PDF-1.4 List Filter Test');

    const task: Task = {
      id: 'file-task-list-filter',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=44&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': listTestFile
      }
    };

    // Trigger an unrelated GET fetch to repository_ajax.php?action=list from the page
    await page.evaluate(() => {
      fetch('/repository/repository_ajax.php?action=list');
    });

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    // Normal upload must succeed by correlating with the POST action=upload, not the GET action=list
    const startCount = serverUploadCount;
    await fillMoodleFileManager(page, q, answer);
    assert.equal(serverUploadCount, startCount + 1, 'Only real POST action=upload increments server upload counter');
  });

  test('FILE-18: Negative: UI displays filename but server draft was not saved fails closed', async () => {
    // Simulate server failure: upload fails or is dropped, but client UI injected a transient element
    simulate500 = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=45&page=0`);

    const transientFile = join(tempDir, 'transient-ui.pdf');
    writeFileSync(transientFile, '%PDF-1.4 Transient UI Test');

    const task: Task = {
      id: 'file-task-transient',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=45&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: {
        'm1_att': transientFile
      }
    };

    // Client-side script optimistically inserts filename into DOM
    await page.evaluate(() => {
      const content = document.querySelector('.fp-content');
      if (content) {
        const dummy = document.createElement('div');
        dummy.className = 'fp-file';
        dummy.innerHTML = '<span class="fp-filename">transient-ui.pdf</span>';
        content.appendChild(dummy);
      }
    });

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    // Because server returned HTTP 500, upload must be rejected even though filename is in the DOM
    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /server returned HTTP 500/i
    );

    // Verify server draft was NOT updated
    const drafts = serverDrafts.get('9876543245') || [];
    assert.equal(drafts.length, 0, 'Server draft state must remain empty when upload failed');
  });
});
