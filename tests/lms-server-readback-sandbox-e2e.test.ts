import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { prepareAdvancedPracticeQuestions, fillMoodleFileManager, practiceAttachmentAnswer } from '../src/lms/advanced-adapters.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../src/task-manager.js';
import type { Task, Question, Answer } from '../src/types.js';

interface ServerDraftFile {
  filename: string;
  size: number;
  sha256: string;
}

test.describe('Phase 3 — Real Moodle Server Readback Sandbox E2E Suite', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let serverUploadCount = 0;
  let simulate500 = false;
  let simulateErrorStatus = false;
  let simulateTimeout = false;
  let simulateServerDropDraft = false; // Returns ACK ok, but does NOT persist into serverDrafts

  const serverDrafts = new Map<string, ServerDraftFile[]>();

  let browser: Browser;
  let page: Page;
  let tempDir: string;
  let validPdfPath: string;

  test.before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'atqa-moodle-sandbox-'));
    validPdfPath = join(tempDir, 'sandbox-report.pdf');
    writeFileSync(validPdfPath, '%PDF-1.4 Real Sandbox Report Sample v1');

    server = http.createServer(async (req, res) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);

      // Attempt page endpoint (renders HTML directly from serverDrafts)
      if (u.pathname === '/mod/quiz/attempt.php') {
        const attemptId = u.searchParams.get('attempt') || '10';
        const draftId = `98765432${attemptId}`;

        // Support rendering 2 widgets on dual attempt test
        const isDual = u.searchParams.get('dual') === '1';

        const draftFiles1 = serverDrafts.get(draftId) || [];
        const renderedFiles1 = draftFiles1.map(f => `
          <div class="fp-file" data-file-name="${f.filename}" data-file-size="${f.size}" data-file-sha256="${f.sha256}">
            <span class="fp-filename">${f.filename}</span>
          </div>
        `).join('\n');

        let extraWidgetHtml = '';
        if (isDual) {
          const draftId2 = `88776655${attemptId}`;
          const draftFiles2 = serverDrafts.get(draftId2) || [];
          const renderedFiles2 = draftFiles2.map(f => `
            <div class="fp-file" data-file-name="${f.filename}" data-file-size="${f.size}" data-file-sha256="${f.sha256}">
              <span class="fp-filename">${f.filename}</span>
            </div>
          `).join('\n');

          extraWidgetHtml = `
            <div class="que essay" id="question-701-2">
              <div class="qtext">Upload secondary appendix:</div>
              <div class="formulation">
                <input type="hidden" name="q701:2_attachments[itemid]" id="draftitemid2" value="${draftId2}">
                <div class="filemanager" data-atqa-id="m2_att" data-itemid="${draftId2}">
                  <div class="fp-navbar">
                    <a class="fp-btn-add btn btn-secondary" role="button" href="#">Add...</a>
                  </div>
                  <div class="fp-content">
                    ${renderedFiles2}
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <head>
              <style>.hidden { display: none; } .fp-content { min-height: 50px; border: 1px dashed #ccc; padding: 10px; }</style>
            </head>
            <body>
              <form id="responseform" method="post" action="/mod/quiz/processattempt.php">
                <div class="que essay" id="question-701-1">
                  <div class="qtext">Upload main report:</div>
                  <div class="formulation">
                    <input type="hidden" name="q701:1_attachments[itemid]" id="draftitemid" value="${draftId}">
                    <div class="filemanager" data-atqa-id="m1_att" data-itemid="${draftId}">
                      <div class="fp-navbar">
                        <a class="fp-btn-add btn btn-secondary" role="button" href="#">Add...</a>
                      </div>
                      <div class="fp-content">
                        ${renderedFiles1}
                      </div>
                    </div>
                  </div>
                </div>

                ${extraWidgetHtml}

                <div id="filepicker-modal" class="hidden">
                  <div class="fp-repo-area"><span class="fp-repo-name">Upload a file</span></div>
                  <div class="fp-upload-form">
                    <input type="file" name="repo_upload_file" id="fileinput">
                    <button type="button" class="fp-upload-btn">Upload this file</button>
                  </div>
                </div>
              </form>

              <script>
                let activeDraftInput = document.getElementById('draftitemid');
                let activeContent = document.querySelector('.filemanager[data-atqa-id="m1_att"] .fp-content');

                document.querySelectorAll('.fp-btn-add').forEach(btn => {
                  btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const mgr = btn.closest('.filemanager');
                    activeContent = mgr.querySelector('.fp-content');
                    activeDraftInput = mgr.parentElement.querySelector('input[name*="attachments"][name*="itemid"]');
                    document.getElementById('filepicker-modal').classList.remove('hidden');
                  });
                });

                document.querySelector('.fp-upload-btn').addEventListener('click', async () => {
                  const fileInput = document.getElementById('fileinput');
                  if (!fileInput.files.length) return;
                  const file = fileInput.files[0];

                  const formData = new FormData();
                  formData.append('repo_upload_file', file);
                  formData.append('itemid', activeDraftInput ? activeDraftInput.value : '');

                  try {
                    const resp = await fetch('/repository/repository_ajax.php?action=upload', {
                      method: 'POST',
                      body: formData
                    });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const json = await resp.json();

                    if (json.status === 'ok') {
                      document.getElementById('filepicker-modal').classList.add('hidden');
                      let existing = Array.from(activeContent.querySelectorAll('.fp-file')).find(el => el.textContent.includes(json.filename));
                      if (!existing) {
                        existing = document.createElement('div');
                        existing.className = 'fp-file';
                        activeContent.appendChild(existing);
                      }
                      existing.setAttribute('data-file-size', String(json.size || file.size));
                      existing.setAttribute('data-file-sha256', json.sha256 || 'client_echo_hash');
                      existing.innerHTML = '<span class="fp-filename">' + json.filename + '</span>';
                    }
                  } catch (err) {
                    console.error('Upload error', err);
                  }
                });
              </script>
            </body>
          </html>
        `);
        return;
      }

      // Repository upload endpoint
      if (u.pathname === '/repository/repository_ajax.php' && req.method === 'POST') {
        serverUploadCount++;

        if (simulateTimeout) {
          // Delay longer than client timeout
          await new Promise(r => setTimeout(r, 14000));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (simulate500) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error 500');
          return;
        }

        if (simulateErrorStatus) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Storage quota exceeded' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuffer = Buffer.concat(chunks);
        const bodyStr = bodyBuffer.toString('binary');

        const itemidMatch = bodyStr.match(/name="itemid"\r?\n\r?\n([^\r\n]+)/);
        const itemid = itemidMatch ? itemidMatch[1].trim() : '9876543210';

        const fnameMatch = bodyStr.match(/filename="([^"]+)"/);
        const filename = fnameMatch ? fnameMatch[1] : 'sandbox-report.pdf';

        const fileMatch = bodyStr.match(/Content-Type:[^\r\n]+\r?\n\r?\n([\s\S]*?)\r?\n--/);
        const fileBytes = fileMatch ? Buffer.from(fileMatch[1], 'binary') : bodyBuffer;
        const sha256 = createHash('sha256').update(fileBytes).digest('hex');
        const size = fileBytes.length;

        // If simulateServerDropDraft is true: return positive ACK with sha256, but do NOT store in serverDrafts
        if (!simulateServerDropDraft) {
          const list = serverDrafts.get(itemid) || [];
          const existingIdx = list.findIndex(f => f.filename === filename);
          const record: ServerDraftFile = { filename, size, sha256 };
          if (existingIdx >= 0) list[existingIdx] = record;
          else list.push(record);
          serverDrafts.set(itemid, list);
        }

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

    await new Promise<void>(resolve => {
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
    server?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    page = await browser.newPage();
    simulate500 = false;
    simulateErrorStatus = false;
    simulateTimeout = false;
    simulateServerDropDraft = false;
  });

  test.afterEach(async () => {
    await page?.close();
  });

  // Scenario 1: ACK thành công + server lưu đúng file → VERIFIED
  test('SANDBOX-01: ACK success + server stores file -> VERIFIED', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=11&page=0`);
    const task: Task = {
      id: 'task-sb-1',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=11&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: { 'm1_att': validPdfPath }
    };
    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await fillMoodleFileManager(page, q, answer);

    // Verify verified state recorded and server storage contains record
    const draft = serverDrafts.get('9876543211') || [];
    assert.equal(draft.length, 1);
    assert.equal(draft[0].filename, 'sandbox-report.pdf');
  });

  // Scenario 2: ACK thành công + server không lưu → UNCONFIRMED / FAILED
  test('SANDBOX-02: ACK success + server drops file (not persisted) -> UNCONFIRMED', async () => {
    simulateServerDropDraft = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=12&page=0`);
    const task: Task = {
      id: 'task-sb-2',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=12&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: { 'm1_att': validPdfPath }
    };
    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /draft|persist|unconfirmed|verify|server/i
    );

    // Verify serverDrafts was indeed empty
    const draft = serverDrafts.get('9876543212') || [];
    assert.equal(draft.length, 0, 'Server did not persist the file');
  });

  // Scenario 3: ACK thành công + DOM hiển thị SHA-256 nhưng server rỗng → không VERIFIED
  test('SANDBOX-03: Optimistic DOM with SHA-256 but empty server store -> rejects unconfirmed', async () => {
    simulateServerDropDraft = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=13&page=0`);
    const task: Task = {
      id: 'task-sb-3',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=13&page=0`,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED',
      scopeAttestation: 'PERMITTED_SELF_PRACTICE',
      advancedLmsAdapters: { fileManager: true },
      attachmentFiles: { 'm1_att': validPdfPath }
    };
    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, task);
    const answer = practiceAttachmentAnswer(q, task)!;

    await assert.rejects(
      fillMoodleFileManager(page, q, answer),
      /draft|persist|unconfirmed|verify|server/i
    );
  });

  const makeFileQuestion = (id: string, prompt = 'Report'): Question => ({
    id,
    kind: 'moodle-file',
    prompt,
    options: [],
    required: false,
    hasVisual: false
  });

  // Scenario 4: Hai widget có cùng filename nhưng khác draft item ID
  test('SANDBOX-04: Two widgets with same filename isolated by draft item ID', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=14&page=0&dual=1`);

    const q1 = makeFileQuestion('m1_att', 'Main report');
    const q2 = makeFileQuestion('m2_att', 'Secondary appendix');

    // Fill widget 1
    await fillMoodleFileManager(page, q1, { id: 'm1_att', localFilePath: validPdfPath });

    // Verify draft 1 contains the file
    const draft1 = serverDrafts.get('9876543214') || [];
    assert.equal(draft1.length, 1);

    // Verify draft 2 remains empty
    const draft2 = serverDrafts.get('8877665514') || [];
    assert.equal(draft2.length, 0, 'Draft 2 must not be affected by upload to Draft 1');

    // Fill widget 2
    await fillMoodleFileManager(page, q2, { id: 'm2_att', localFilePath: validPdfPath });

    // Verify draft 2 now contains the file independently
    const draft2Updated = serverDrafts.get('8877665514') || [];
    assert.equal(draft2Updated.length, 1);
  });

  // Scenario 5: Upload thành công rồi reload
  test('SANDBOX-05: Upload success followed by page reload maintains server state', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=15&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });

    // Reload page directly from server
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=15&page=0`);

    // Verify the server-rendered file is present in the reloaded DOM
    const visible = await page.locator('.filemanager[data-atqa-id="m1_att"] .fp-filename').textContent();
    assert.equal(visible?.trim(), 'sandbox-report.pdf');

    // Idempotent fill: must recognize matching server hash and not trigger another upload
    const startCount = serverUploadCount;
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });
    assert.equal(serverUploadCount, startCount, 'Reloaded confirmed state must skip redundant re-upload');
  });

  // Scenario 6: Process A upload, Process B khôi phục
  test('SANDBOX-06: Process A uploads -> saves checkpoint -> Process B resumes from server state', async () => {
    clearCheckpoint('task-sandbox-cross');
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=16&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });

    await saveCheckpoint({
      taskId: 'task-sandbox-cross',
      url: `${baseUrl}/mod/quiz/attempt.php?attempt=16&page=0`,
      status: 'RUNNING',
      stepsCompleted: 1,
      domFilledSteps: 1,
      serverSavedSteps: 1,
      questionsFound: 1,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString(),
      answersRecorded: {
        'm1_att': { id: 'm1_att', localFilePath: validPdfPath }
      }
    });

    const cp = await loadCheckpoint('task-sandbox-cross');
    assert.ok(cp);

    // Simulate Process B fresh page
    const pageB = await browser.newPage();
    try {
      await pageB.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=16&page=0`);
      const startUploads = serverUploadCount;
      const recordedAnswer = (cp as any).answersRecorded?.['m1_att'] || { id: 'm1_att', localFilePath: validPdfPath };
      await fillMoodleFileManager(pageB, q, recordedAnswer);
      assert.equal(serverUploadCount, startUploads, 'Process B must not re-upload file confirmed by server');
    } finally {
      await pageB.close();
      clearCheckpoint('task-sandbox-cross');
    }
  });

  // Scenario 7: Server trả HTTP 500
  test('SANDBOX-07: Server HTTP 500 fails closed', async () => {
    simulate500 = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=17&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /HTTP 500/i
    );
  });

  // Scenario 8: Server phản hồi lỗi nghiệp vụ
  test('SANDBOX-08: Server business error payload fails closed', async () => {
    simulateErrorStatus = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=18&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /Quota exceeded/i
    );
  });

  // Scenario 9: Server timeout
  test('SANDBOX-09: Server response timeout fails closed', async () => {
    simulateTimeout = true;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=19&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /missing server response or request timeout/i
    );
  });

  // Scenario 10: Đổi nội dung tệp cùng tên
  test('SANDBOX-10: Modifying content on disk triggers upload and updates server draft', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=20&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });

    const draftBefore = serverDrafts.get('9876543220') || [];
    const shaBefore = draftBefore[0].sha256;

    // Mutate file on disk with different content
    writeFileSync(validPdfPath, '%PDF-1.4 UPDATED CONTENT ON DISK V2');
    const newBytes = readFileSync(validPdfPath);
    const expectedNewSha = createHash('sha256').update(newBytes).digest('hex');

    // Fill again: must detect hash change and update server draft
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });

    const draftAfter = serverDrafts.get('9876543220') || [];
    assert.equal(draftAfter.length, 1);
    assert.notEqual(draftAfter[0].sha256, shaBefore);
    assert.equal(draftAfter[0].sha256, expectedNewSha);
  });

  // Scenario 11: Không tạo bản upload trùng khi khôi phục
  test('SANDBOX-11: Resume never generates duplicate upload on server', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=21&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });

    const beforeUploadCount = serverUploadCount;
    // Re-call fill on same page
    await fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath });
    assert.equal(serverUploadCount, beforeUploadCount, 'Upload count must not increase on verified resume');
  });

  // Scenario 12: Client DOM echoes matching sha256 but server draft is empty -> fails closed
  test('SANDBOX-12: Client DOM echoes matching sha256 but server draft is empty -> fails closed', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=22&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    const bytes = readFileSync(validPdfPath);
    const sha = createHash('sha256').update(bytes).digest('hex');

    // Inject fake DOM element in browser
    await page.evaluate(({ sha, size }) => {
      const container = document.querySelector('.filemanager[data-atqa-id="m1_att"] .fp-content');
      if (container) {
        const fake = document.createElement('div');
        fake.className = 'fp-file';
        fake.setAttribute('data-file-name', 'sandbox-report.pdf');
        fake.setAttribute('data-file-sha256', sha);
        fake.setAttribute('data-file-size', String(size));
        fake.innerHTML = '<span class="fp-filename">sandbox-report.pdf</span>';
        container.appendChild(fake);
      }
    }, { sha, size: bytes.length });

    // Server has no files in draft 9876543222
    assert.equal((serverDrafts.get('9876543222') || []).length, 0);

    // Call fillMoodleFileManager: must fail closed because server readback finds no file on server
    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /draft persistence unconfirmed: existing DOM checksum was not verified by independent server readback/i
    );
  });

  // Scenario 13: Client DOM echoes matching sha256 but contradictory size metadata -> fails closed
  test('SANDBOX-13: Client DOM echoes matching sha256 but contradictory size metadata -> fails closed', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=23&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');
    const bytes = readFileSync(validPdfPath);
    const sha = createHash('sha256').update(bytes).digest('hex');

    // Inject fake DOM element with matching sha but contradictory size
    await page.evaluate(({ sha }) => {
      const container = document.querySelector('.filemanager[data-atqa-id="m1_att"] .fp-content');
      if (container) {
        const fake = document.createElement('div');
        fake.className = 'fp-file';
        fake.setAttribute('data-file-name', 'sandbox-report.pdf');
        fake.setAttribute('data-file-sha256', sha);
        fake.setAttribute('data-file-size', '9999999'); // contradictory size
        fake.innerHTML = '<span class="fp-filename">sandbox-report.pdf</span>';
        container.appendChild(fake);
      }
    }, { sha });

    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /size contradicted|metadata mismatch|contradict/i
    );
  });

  // Scenario 14: Server only has file in draft B, draft A does not falsely confirm from draft B
  test('SANDBOX-14: Server only has file in draft B, draft A does not falsely confirm from draft B', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=24&page=0&dual=1`);
    const q1 = makeFileQuestion('m1_att', 'Main report');
    const q2 = makeFileQuestion('m2_att', 'Secondary appendix');

    // Upload to widget 2 (draft 8877665524)
    await fillMoodleFileManager(page, q2, { id: 'm2_att', localFilePath: validPdfPath });

    // Draft 2 has file, Draft 1 is empty on server
    assert.equal((serverDrafts.get('8877665524') || []).length, 1);
    assert.equal((serverDrafts.get('9876543224') || []).length, 0);

    // In client DOM, inject rogue element into widget 1 pointing to same filename and hash
    const bytes = readFileSync(validPdfPath);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await page.evaluate(({ sha, size }) => {
      const container = document.querySelector('.filemanager[data-atqa-id="m1_att"] .fp-content');
      if (container) {
        const fake = document.createElement('div');
        fake.className = 'fp-file';
        fake.setAttribute('data-file-name', 'sandbox-report.pdf');
        fake.setAttribute('data-file-sha256', sha);
        fake.setAttribute('data-file-size', String(size));
        fake.innerHTML = '<span class="fp-filename">sandbox-report.pdf</span>';
        container.appendChild(fake);
      }
    }, { sha, size: bytes.length });

    // Check widget 1: server readback must scope strictly to draft 9876543224 and reject
    await assert.rejects(
      fillMoodleFileManager(page, q1, { id: 'm1_att', localFilePath: validPdfPath }),
      /draft persistence unconfirmed: existing DOM checksum was not verified by independent server readback/i
    );
  });

  // Scenario 15: Nonexistent or missing draft container during readback fails closed
  test('SANDBOX-15: Corrupt or missing draft item ID in DOM fails closed safely', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=25&page=0`);
    const q = makeFileQuestion('m1_att', 'Main report');

    // Remove itemid attribute from DOM
    await page.evaluate(() => {
      const input = document.getElementById('draftitemid');
      if (input) input.removeAttribute('value');
      const mgr = document.querySelector('.filemanager[data-atqa-id="m1_att"]');
      if (mgr) mgr.removeAttribute('data-itemid');
    });

    await assert.rejects(
      fillMoodleFileManager(page, q, { id: 'm1_att', localFilePath: validPdfPath }),
      /missing required draft item id|itemid|draft/i
    );
  });

  // Scenario 16: Two widgets with same filename and checksum isolated across independent server drafts
  test('SANDBOX-16: Dual widgets with same filename and checksum verify independently', async () => {
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?attempt=26&page=0&dual=1`);
    const q1 = makeFileQuestion('m1_att', 'Main report');
    const q2 = makeFileQuestion('m2_att', 'Secondary appendix');

    // Fill widget 1
    await fillMoodleFileManager(page, q1, { id: 'm1_att', localFilePath: validPdfPath });

    // Fill widget 2
    await fillMoodleFileManager(page, q2, { id: 'm2_att', localFilePath: validPdfPath });

    // Both drafts on server now have the file
    const d1 = serverDrafts.get('9876543226') || [];
    const d2 = serverDrafts.get('8877665526') || [];
    assert.equal(d1.length, 1);
    assert.equal(d2.length, 1);
    assert.equal(d1[0].filename, d2[0].filename);

    // Re-verifying widget 1 with server readback passes
    const beforeCount = serverUploadCount;
    await fillMoodleFileManager(page, q1, { id: 'm1_att', localFilePath: validPdfPath });
    // Re-verifying widget 2 passes without extra uploads
    await fillMoodleFileManager(page, q2, { id: 'm2_att', localFilePath: validPdfPath });
    assert.equal(serverUploadCount, beforeCount, 'Both widgets verified independently without duplicate uploads');
  });
});
