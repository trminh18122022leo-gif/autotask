/** Isolated E2E Test Suite: Writing Assignments, File Uploads (Moodle FileManager & direct), AI Document Generation & High-Precision Quiz Verification */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { executeAgentTool } from '../src/agent/tools.js';
import { extractCredentialsAndUrlFromPrompt } from '../src/agent/loop.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import type { AgentContext } from '../src/agent/types.js';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { WordAutomation, validateWordOutputPath } from '../src/agent/word-desktop.js';
import { executeAssignmentSubmit } from '../src/agent/assignment-solver.js';
import { AgentRunLogger } from '../src/agent/run-logger.js';
import { promptModelSelection } from '../src/agent/cli.js';
import { createDocument } from '../src/documents.js';

let srv: Server;
let baseUrl: string;
let browser: Browser;
let tempWorkDir: string;
const realExecute = ModelRouter.execute;
const realWordCompose = WordAutomation.compose;

const serverState = {
  assign501Text: '',
  assign501DraftSaved: false,
  assign501Submitted: false,
  assign502UploadedFiles: new Map<string, { name: string; sha256: string; size: number }>(),
  assign502Submitted: false,
  assign503Text: '',
  assign503DocHeaderHex: '',
  assign503DocSize: 0,
  assign503Submitted: false,
  assign504UploadedHeaderHex: '',
  assign504UploadedSize: 0,
  assign504UploadedSha256: '',
  assign504Text: '',
  assign504DraftSaved: false,
  assign504Submitted: false,
  assign505Text: '',
  assign505Submitted: false,
  assign506Text: '',
  assign506Submitted: false,
  quiz601SubmittedBody: ''
};

function makeIsolatedCtx(overrides?: Partial<AgentContext['config']>): AgentContext {
  return {
    collectedFindings: {},
    history: [],
    goalHistory: [],
    isLoggedIn: true,
    config: {
      allowedHosts: ['127.0.0.1', 'localhost'],
      headless: true,
      autoRead: false,
      requireStateChangeApproval: false,
      userIntent: 'SOLVE_QUIZ',
      verbose: false,
      disableLogs: true,
      disablePlaybooks: true,
      ...overrides
    }
  };
}

function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test.describe('Isolated Environment — Assignment Writing, File Upload & Quiz Accuracy Suite', () => {
  test.before(async () => {
    tempWorkDir = await mkdtemp(join(tmpdir(), 'at-isolated-env-'));

    srv = createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const path = reqUrl.pathname;

      if (path === '/tiny-blank') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body id="tinymce" contenteditable="true"><p><br></p></body></html>');
        return;
      }

      // --- ASSIGN 501: Online Text with TinyMCE iframe + 2-step Draft -> Statement -> Submit ---
      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '501') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          const bodyStr = (await readRawBody(req)).toString('utf8');
          const params = new URLSearchParams(bodyStr);
          serverState.assign501Text = params.get('onlinetext_editor') || '';
          serverState.assign501DraftSaved = true;
          res.writeHead(302, { Location: '/mod/assign/view.php?id=501' });
          res.end();
          return;
        }
        if (req.method === 'POST' && action === 'confirm') {
          const bodyStr = (await readRawBody(req)).toString('utf8');
          const params = new URLSearchParams(bodyStr);
          if (params.get('submissionstatement') === 'on') {
            serverState.assign501Submitted = true;
          }
          res.writeHead(302, { Location: '/mod/assign/view.php?id=501' });
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          res.end(`<!doctype html><html><head><title>Edit Submission 501</title></head><body>
            <h1>Bài luận tuần 3: Kỹ năng thuyết trình</h1>
            <form action="/mod/assign/view.php?id=501&action=save" method="post" class="mform">
              <div data-fieldtype="editor" class="tox-tinymce">
                <iframe id="id_onlinetext_editor_ifr" src="/tiny-blank" style="width:100%;height:120px;"></iframe>
                <textarea id="id_onlinetext_editor" name="onlinetext_editor" style="display:none"></textarea>
              </div>
              <input id="id_submitbutton" type="submit" value="Save changes" />
            </form>
          </body></html>`);
          return;
        }

        if (action === 'submit') {
          res.end(`<!doctype html><html><head><title>Confirm Submit 501</title></head><body>
            <h1>Submit assignment</h1>
            <form action="/mod/assign/view.php?id=501&action=confirm" method="post">
              <label><input type="checkbox" id="id_submissionstatement" name="submissionstatement" /> This submission is my own work</label>
              <button type="submit">Continue</button>
            </form>
          </body></html>`);
          return;
        }

        const statusCell = serverState.assign501Submitted
          ? 'Submitted for grading'
          : (serverState.assign501DraftSaved ? 'Draft (not submitted)' : 'No attempt');
        const actionControls = serverState.assign501Submitted
          ? `<p>Nội dung đã nộp: ${serverState.assign501Text}</p>`
          : (serverState.assign501DraftSaved
              ? `<a class="btn btn-primary" href="/mod/assign/view.php?id=501&action=submit">Submit assignment</a>
                 <a class="btn btn-secondary" href="/mod/assign/view.php?id=501&action=editsubmission">Edit submission</a>`
              : `<a class="btn btn-primary" href="/mod/assign/view.php?id=501&action=editsubmission">Add submission</a>`);
        res.end(`<!doctype html><html><head><title>Assignment 501</title></head><body>
          <h1>Bài luận tuần 3: Kỹ năng thuyết trình</h1>
          <div id="intro">Hãy viết đoạn văn phân tích vai trò của tương tác ánh mắt khi thuyết trình. Word limit: 300</div>
          <div data-region="activity-dates">Closes: Sunday, 29 November 2099, 11:59 PM</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${statusCell}</td></tr></tbody></table>
          ${actionControls}
        </body></html>`);
        return;
      }

      // --- ASSIGN 502: Moodle File Manager Repository AJAX Upload + SHA-256 readback ---
      if (path === '/repository/repository_ajax.php' && req.method === 'POST') {
        const raw = await readRawBody(req);
        const contentType = String(req.headers['content-type'] || '');
        const bMatch = contentType.match(/boundary=([^\s;]+)/i);
        let uploadedName = 'uploaded.txt';
        let filePayload = raw;
        if (bMatch) {
          const boundary = `--${bMatch[1]}`;
          const parts = raw.toString('latin1').split(boundary);
          for (const p of parts) {
            if (p.includes('name="repo_upload_file"')) {
              const fnMatch = p.match(/filename="([^"]+)"/);
              if (fnMatch) uploadedName = fnMatch[1];
              const hdrEnd = p.indexOf('\r\n\r\n');
              if (hdrEnd >= 0) {
                const bodyLat = p.slice(hdrEnd + 4, p.endsWith('\r\n') ? -2 : undefined);
                filePayload = Buffer.from(bodyLat, 'latin1');
              }
            }
          }
        }
        const sha = createHash('sha256').update(filePayload).digest('hex');
        serverState.assign502UploadedFiles.set('draft_502', {
          name: uploadedName,
          sha256: sha,
          size: filePayload.length
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          event: 'fileuploaded',
          itemid: 'draft_502',
          filename: uploadedName,
          sha256: sha,
          size: filePayload.length
        }));
        return;
      }

      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '502') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          await readRawBody(req);
          if (serverState.assign502UploadedFiles.has('draft_502')) {
            serverState.assign502Submitted = true;
          }
          res.writeHead(302, { Location: '/mod/assign/view.php?id=502' });
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          const draft = serverState.assign502UploadedFiles.get('draft_502');
          const fpHtml = draft
            ? `<div class="fp-file" data-file-name="${draft.name}" data-file-sha256="${draft.sha256}" data-file-size="${draft.size}"><span class="fp-filename">${draft.name}</span></div>`
            : '';
          res.end(`<!doctype html><html><head><title>Upload Assign 502</title></head><body>
            <h1>Nộp file báo cáo bài tập 2</h1>
            <form action="/mod/assign/view.php?id=502&action=save" method="post" class="mform">
              <input type="hidden" id="draftitemid" name="attachments_filemanager" value="draft_502" />
              <div class="filemanager" data-itemid="draft_502">
                <button type="button" class="fp-btn-add" onclick="openPicker()">Add...</button>
                <div class="fp-content">${fpHtml}</div>
              </div>
              <div id="fp-picker-area"></div>
              <button id="id_submitbutton" type="submit">Save changes</button>
            </form>
            <script>
              function openPicker() {
                document.getElementById('fp-picker-area').innerHTML =
                  '<div class="fp-upload-form">' +
                    '<a href="#" onclick="showUploadForm(event)">Upload a file</a>' +
                    '<div id="repo-form" style="display:none">' +
                      '<input type="file" name="repo_upload_file" id="repo_upload_file" />' +
                      '<button type="button" onclick="doRepoUpload()">Upload this file</button>' +
                    '</div>' +
                  '</div>';
              }
              function showUploadForm(e) {
                e.preventDefault();
                document.getElementById('repo-form').style.display = 'block';
              }
              async function doRepoUpload() {
                var inp = document.getElementById('repo_upload_file');
                var fd = new FormData();
                fd.append('itemid', 'draft_502');
                fd.append('repo_upload_file', inp.files[0]);
                var r = await fetch('/repository/repository_ajax.php?action=upload', { method: 'POST', body: fd });
                var j = await r.json();
                document.querySelector('.fp-content').innerHTML =
                  '<div class="fp-file" data-file-name="' + j.filename + '" data-file-sha256="' + j.sha256 + '" data-file-size="' + j.size + '">' +
                  '<span class="fp-filename">' + j.filename + '</span></div>';
                document.getElementById('fp-picker-area').innerHTML = '';
              }
            </script>
          </body></html>`);
          return;
        }

        const draft = serverState.assign502UploadedFiles.get('draft_502');
        res.end(`<!doctype html><html><head><title>Assign 502</title></head><body>
          <h1>Nộp file báo cáo bài tập 2</h1>
          <div id="intro">Nộp file báo cáo thực hành định dạng txt/docx.</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${serverState.assign502Submitted ? 'Submitted for grading' : 'No attempt'}</td></tr></tbody></table>
          ${draft ? `<p>File đã nộp: ${draft.name} (sha256=${draft.sha256})</p>` : ''}
          ${serverState.assign502Submitted ? '' : '<a class="btn btn-primary" href="/mod/assign/view.php?id=502&action=editsubmission">Add submission</a>'}
        </body></html>`);
        return;
      }

      // --- ASSIGN 503 + Course 503: Combined Atto Online Text + Direct Multipart <input type="file"> (.docx generated by AI) ---
      if (path === '/course/view.php' && reqUrl.searchParams.get('id') === '503') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 503</title></head><body>
          <h1>Course 503: Mixed Writing & File Upload</h1>
          <ul>
            <li class="activity modtype_assign activity-item">
              <div class="instancename"><a href="/mod/assign/view.php?id=503">Nộp báo cáo tuần 5</a></div>
              <div data-region="completion-info">
                <button data-action="toggle-manual-completion" data-toggletype="manual:mark-done" class="btn btn-outline-secondary">Mark as done</button>
              </div>
            </li>
          </ul>
        </body></html>`);
        return;
      }

      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '503') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          const raw = await readRawBody(req);
          const contentType = String(req.headers['content-type'] || '');
          const bMatch = contentType.match(/boundary=([^\s;]+)/i);
          if (bMatch) {
            const parts = raw.toString('latin1').split(`--${bMatch[1]}`);
            for (const p of parts) {
              const hdrEnd = p.indexOf('\r\n\r\n');
              if (hdrEnd < 0) continue;
              const hdr = p.slice(0, hdrEnd);
              const bodyLat = p.slice(hdrEnd + 4, p.endsWith('\r\n') ? -2 : undefined);
              if (hdr.includes('name="assign_text"')) {
                serverState.assign503Text = Buffer.from(bodyLat, 'latin1').toString('utf8');
              } else if (hdr.includes('name="upload_doc"') && hdr.includes('filename=')) {
                const buf = Buffer.from(bodyLat, 'latin1');
                serverState.assign503DocSize = buf.length;
                serverState.assign503DocHeaderHex = buf.subarray(0, 2).toString('hex').toUpperCase();
              }
            }
          }
          serverState.assign503Submitted = true;
          res.writeHead(302, { Location: '/mod/assign/view.php?id=503' });
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          res.end(`<!doctype html><html><head><title>Edit Assign 503</title></head><body>
            <h1>Nộp báo cáo tuần 5</h1>
            <form action="/mod/assign/view.php?id=503&action=save" method="post" enctype="multipart/form-data" class="mform">
              <div class="editor_atto_wrap">
                <div id="id_assign_texteditable" class="editor_atto_content" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
                <textarea id="id_assign_text" name="assign_text" style="display:none"></textarea>
              </div>
              <input type="file" name="upload_doc" id="upload_doc" />
              <button id="id_submitbutton" type="submit">Save changes</button>
            </form>
          </body></html>`);
          return;
        }

        res.end(`<!doctype html><html><head><title>Assign 503</title></head><body>
          <h1>Nộp báo cáo tuần 5</h1>
          <div id="intro">Viết tóm tắt bài học và đính kèm file báo cáo chi tiết (docx).</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${serverState.assign503Submitted ? 'Submitted for grading' : 'No attempt'}</td></tr></tbody></table>
          ${serverState.assign503Submitted ? '' : '<a class="btn btn-primary" href="/mod/assign/view.php?id=503&action=editsubmission">Add submission</a>'}
        </body></html>`);
        return;
      }

      // --- ASSIGN 504: Mixed Online Text (TinyMCE) + File Upload + 2-step Confirm (Word -> Save -> Push -> Submit) ---
      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '504') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          const raw = await readRawBody(req);
          const contentType = String(req.headers['content-type'] || '');
          const bMatch = contentType.match(/boundary=([^\s;]+)/i);
          if (bMatch) {
            const parts = raw.toString('latin1').split(`--${bMatch[1]}`);
            for (const p of parts) {
              const hdrEnd = p.indexOf('\r\n\r\n');
              if (hdrEnd < 0) continue;
              const hdr = p.slice(0, hdrEnd);
              const bodyLat = p.slice(hdrEnd + 4, p.endsWith('\r\n') ? -2 : undefined);
              if (hdr.includes('name="onlinetext_editor"')) {
                serverState.assign504Text = Buffer.from(bodyLat, 'latin1').toString('utf8');
              } else if (hdr.includes('name="word_doc"') && hdr.includes('filename=')) {
                const buf = Buffer.from(bodyLat, 'latin1');
                serverState.assign504UploadedSize = buf.length;
                serverState.assign504UploadedHeaderHex = buf.subarray(0, 2).toString('hex').toUpperCase();
                serverState.assign504UploadedSha256 = createHash('sha256').update(buf).digest('hex');
              }
            }
          }
          serverState.assign504DraftSaved = true;
          res.writeHead(302, { Location: '/mod/assign/view.php?id=504' });
          res.end();
          return;
        }
        if (req.method === 'POST' && action === 'confirm') {
          const bodyStr = (await readRawBody(req)).toString('utf8');
          const params = new URLSearchParams(bodyStr);
          if (params.get('submissionstatement') === 'on') {
            serverState.assign504Submitted = true;
          }
          res.writeHead(302, { Location: '/mod/assign/view.php?id=504' });
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          res.end(`<!doctype html><html><head><title>Edit Assign 504</title></head><body>
            <h1>Bài tập tự luận & Nộp file Word tuần 6</h1>
            <form action="/mod/assign/view.php?id=504&action=save" method="post" enctype="multipart/form-data" class="mform">
              <div data-fieldtype="editor" class="tox-tinymce">
                <iframe id="id_onlinetext_editor_ifr" src="/tiny-blank" style="width:100%;height:120px;"></iframe>
                <textarea id="id_onlinetext_editor" name="onlinetext_editor" style="display:none"></textarea>
              </div>
              <input type="file" name="word_doc" id="word_doc" />
              <button id="id_submitbutton" type="submit">Save changes</button>
            </form>
          </body></html>`);
          return;
        }
        if (action === 'submit') {
          res.end(`<!doctype html><html><head><title>Confirm Submit 504</title></head><body>
            <h1>Submit assignment</h1>
            <form action="/mod/assign/view.php?id=504&action=confirm" method="post">
              <label><input type="checkbox" id="id_submissionstatement" name="submissionstatement" /> This submission is my own work</label>
              <button type="submit">Continue</button>
            </form>
          </body></html>`);
          return;
        }
        const statusCell504 = serverState.assign504Submitted
          ? 'Submitted for grading'
          : (serverState.assign504DraftSaved ? 'Draft (not submitted)' : 'No attempt');
        const controls504 = serverState.assign504Submitted
          ? `<p>Đã nộp file Word SHA=${serverState.assign504UploadedSha256}</p>`
          : (serverState.assign504DraftSaved
              ? `<a class="btn btn-primary" href="/mod/assign/view.php?id=504&action=submit">Submit assignment</a>
                 <a class="btn btn-secondary" href="/mod/assign/view.php?id=504&action=editsubmission">Edit submission</a>`
              : `<a class="btn btn-primary" href="/mod/assign/view.php?id=504&action=editsubmission">Add submission</a>`);
        res.end(`<!doctype html><html><head><title>Assign 504</title></head><body>
          <h1>Bài tập tự luận & Nộp file Word tuần 6</h1>
          <div id="intro">Viết bài phân tích kỹ năng lãnh đạo nhóm trong Microsoft Word và nộp file .docx lên hệ thống.</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${statusCell504}</td></tr></tbody></table>
          ${controls504}
        </body></html>`);
        return;
      }

      // --- ASSIGN 505: Online-text only assignment (Word draft + Online Text fill) ---
      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '505') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          const bodyStr = (await readRawBody(req)).toString('utf8');
          const params = new URLSearchParams(bodyStr);
          serverState.assign505Text = params.get('assign_essay') || '';
          serverState.assign505Submitted = true;
          res.writeHead(302, { Location: '/mod/assign/view.php?id=505' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          res.end(`<!doctype html><html><head><title>Edit Assign 505</title></head><body>
            <h1>Bài tự luận trực tuyến 5</h1>
            <form action="/mod/assign/view.php?id=505&action=save" method="post" class="mform">
              <textarea name="assign_essay" id="id_assign_essay"></textarea>
              <button id="id_submitbutton" type="submit">Save changes</button>
            </form>
          </body></html>`);
          return;
        }
        res.end(`<!doctype html><html><head><title>Assign 505</title></head><body>
          <h1>Bài tự luận trực tuyến 5</h1>
          <div id="intro">Trình bày vai trò của phản biện xây dựng trong học tập.</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${serverState.assign505Submitted ? 'Submitted for grading' : 'No attempt'}</td></tr></tbody></table>
          ${serverState.assign505Submitted ? '' : '<a class="btn btn-primary" href="/mod/assign/view.php?id=505&action=editsubmission">Add submission</a>'}
        </body></html>`);
        return;
      }

      // --- ASSIGN 506: Audit test (failOnAiError safe halt + runLogger.quizDetails logging) ---
      if (path === '/mod/assign/view.php' && reqUrl.searchParams.get('id') === '506') {
        const action = reqUrl.searchParams.get('action');
        if (req.method === 'POST' && action === 'save') {
          const bodyStr = (await readRawBody(req)).toString('utf8');
          const params = new URLSearchParams(bodyStr);
          serverState.assign506Text = params.get('assign_audit') || '';
          serverState.assign506Submitted = true;
          res.writeHead(302, { Location: '/mod/assign/view.php?id=506' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (action === 'editsubmission') {
          res.end(`<!doctype html><html><head><title>Edit Assign 506</title></head><body>
            <h1>Bài tập kiểm thử audit 6</h1>
            <form action="/mod/assign/view.php?id=506&action=save" method="post" class="mform">
              <textarea name="assign_audit" id="id_assign_audit"></textarea>
              <button id="id_submitbutton" type="submit">Save changes</button>
            </form>
          </body></html>`);
          return;
        }
        res.end(`<!doctype html><html><head><title>Assign 506</title></head><body>
          <h1>Bài tập kiểm thử audit 6</h1>
          <div id="intro">Viết nhận xét ngắn về quy trình kiểm thử phần mềm.</div>
          <table class="submissionstatustable"><tbody><tr><td>Submission status</td><td>${serverState.assign506Submitted ? 'Submitted for grading' : 'No attempt'}</td></tr></tbody></table>
          ${serverState.assign506Submitted ? '' : '<a class="btn btn-primary" href="/mod/assign/view.php?id=506&action=editsubmission">Add submission</a>'}
        </body></html>`);
        return;
      }

      // --- Generic external form with direct file input ---
      if (path === '/generic-upload') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Generic Upload Form</title></head><body>
          <form><input type="file" id="doc_upload" name="doc" /></form>
        </body></html>`);
        return;
      }

      // --- QUIZ 601 + Course 601: High-accuracy Verification + TinyMCE Essay ---
      if (path === '/course/view.php' && reqUrl.searchParams.get('id') === '601') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 601</title></head><body>
          <ul>
            <li class="section">
              <div class="summary">Tài liệu tuần 6: Nguyên tắc giao tiếp hiệu quả gồm Lắng nghe chủ động và Phản hồi tích cực; tuyệt đối không áp đặt người nghe.</div>
              <ul>
                <li class="activity modtype_quiz activity-item">
                  <div class="instancename"><a href="/mod/quiz/view.php?id=601">06.TRẮC NGHIỆM & TỰ LUẬN: Giao tiếp</a></div>
                </li>
              </ul>
            </li>
          </ul>
        </body></html>`);
        return;
      }

      if (path === '/mod/quiz/view.php' && reqUrl.searchParams.get('id') === '601') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Quiz 601</title></head><body>
          <h1>06.TRẮC NGHIỆM & TỰ LUẬN: Giao tiếp</h1>
          <form action="/mod/quiz/attempt.php" method="get">
            <input type="hidden" name="id" value="601" />
            <button type="submit">Start attempt</button>
          </form>
        </body></html>`);
        return;
      }

      if (path === '/mod/quiz/attempt.php') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Attempt 601</title></head><body>
          <form id="responseform" action="/mod/quiz/summary.php" method="post">
            <div id="question-1-1" class="que multichoice">
              <div class="content"><div class="formulation">
                <div class="qtext">Điều nào sau đây NGOẠI TRỪ là nguyên tắc giao tiếp hiệu quả?</div>
                <div class="answer">
                  <div class="r0"><input type="radio" name="q1:1_answer" id="q1_0" value="0"><label for="q1_0">Lắng nghe chủ động</label></div>
                  <div class="r1"><input type="radio" name="q1:1_answer" id="q1_1" value="1"><label for="q1_1">Áp đặt người nghe</label></div>
                </div>
              </div></div>
            </div>
            <div id="question-1-2" class="que multichoice">
              <div class="content"><div class="formulation">
                <div class="qtext">Chọn TẤT CẢ các yếu tố đúng của giao tiếp hiệu quả:</div>
                <div class="answer">
                  <div class="r0"><input type="checkbox" name="q1:2_choice0" id="q2_0" value="1"><label for="q2_0">Lắng nghe chủ động</label></div>
                  <div class="r1"><input type="checkbox" name="q1:2_choice1" id="q2_1" value="1"><label for="q2_1">Phản hồi tích cực</label></div>
                  <div class="r2"><input type="checkbox" name="q1:2_choice2" id="q2_2" value="1"><label for="q2_2">Ngắt lời người khác</label></div>
                </div>
              </div></div>
            </div>
            <div id="question-1-3" class="que essay">
              <div class="content"><div class="formulation">
                <div class="qtext">Viết ngắn gọn 1 câu nêu vai trò của phản hồi tích cực:</div>
                <div class="tox-tinymce">
                  <iframe id="id_q3_ifr" src="/tiny-blank" style="width:100%;height:80px;"></iframe>
                  <textarea id="id_q3" name="q1:3_answer" style="display:none"></textarea>
                </div>
              </div></div>
            </div>
            <input type="submit" value="Finish attempt ..." />
          </form>
        </body></html>`);
        return;
      }

      if (path === '/mod/quiz/summary.php') {
        if (req.method === 'POST') {
          serverState.quiz601SubmittedBody = (await readRawBody(req)).toString('utf8');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Summary 601</title></head><body>
          <form action="/mod/quiz/review.php" method="get">
            <button type="submit">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }

      if (path === '/mod/quiz/review.php') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Review 601</title></head><body>
          <p>State: Finished</p><p>Grade: 10.00 out of 10.00 (100%)</p>
        </body></html>`);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch({ headless: true });
  });

  test.after(async () => {
    (ModelRouter as any).execute = realExecute;
    await browser?.close().catch(() => {});
    srv?.close();
    await rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
  });

  test('ISOLATED-ASSIGN-01: Moodle Online Text Writing via TinyMCE iframe + 2-step draft -> confirm submission', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = makeIsolatedCtx();
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    (ModelRouter as any).execute = async () => ({
      profileId: 'mock-writer',
      modelUsed: 'mock-flash',
      output: JSON.stringify({
        essayText: 'Tương tác ánh mắt giúp người thuyết trình tạo kết nối tin cậy và giữ sự tập trung của khán giả.',
        fileTitle: 'Ky nang thuyet trinh',
        fileContent: 'Noi dung bai luan'
      })
    });

    try {
      await page.goto(`${baseUrl}/mod/assign/view.php?id=501`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({ tool: 'quiz.solve', args: { autoSubmit: true } }, ctx);
      assert.strictEqual(res.success, true, res.error || res.observationText);
      assert.strictEqual(res.data?.wroteEssay, true);
      assert.strictEqual(res.data?.submitted, true);
      assert.strictEqual(serverState.assign501Submitted, true);
      assert.ok(serverState.assign501Text.includes('kết nối tin cậy'));
    } finally {
      (ModelRouter as any).execute = realExecute;
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-ASSIGN-02: Moodle File Manager AJAX upload submission with SHA-256 verification & private-path block', async () => {
    const localReport = join(tempWorkDir, 'bao-cao-nhom.txt');
    const reportBytes = Buffer.from('Bao cao thuc hanh tuan 2 - AutoTask AI test\n', 'utf8');
    await writeFile(localReport, reportBytes);
    const expectedSha = createHash('sha256').update(reportBytes).digest('hex');

    // Create a fake nested ".private" path inside tempWorkDir to prove sensitive path blocking works
    const privDir = join(tempWorkDir, '.private');
    await mkdir(privDir, { recursive: true });
    const privFile = join(privDir, 'secret.txt');
    await writeFile(privFile, 'sensitive');

    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = makeIsolatedCtx({ attachmentPath: localReport });
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    try {
      await page.goto(`${baseUrl}/mod/assign/view.php?id=502`, { waitUntil: 'domcontentloaded' });

      // Sensitive .private path MUST be rejected before touching upload
      const blocked = await executeAgentTool({ tool: 'quiz.solve', args: { autoSubmit: true, filePath: privFile } }, ctx);
      assert.strictEqual(blocked.success, false, 'Sensitive .private path must be rejected');
      assert.match(blocked.error || blocked.observationText || '', /Sensitive|not permitted/i);

      await page.goto(`${baseUrl}/mod/assign/view.php?id=502`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({ tool: 'quiz.solve', args: { autoSubmit: true, filePath: localReport } }, ctx);
      assert.strictEqual(res.success, true, res.error || res.observationText);
      assert.strictEqual(serverState.assign502Submitted, true);
      const uploaded = serverState.assign502UploadedFiles.get('draft_502');
      assert.ok(uploaded);
      assert.strictEqual(uploaded.name, 'bao-cao-nhom.txt');
      assert.strictEqual(uploaded.sha256, expectedSha);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-ASSIGN-03: Prompt parsing + AI-generated DOCX upload + Atto text + browser.fill(<input type="file">)', async () => {
    // 1. Prompt parser checks for file paths, formats, and writing intent
    const p1 = extractCredentialsAndUrlFromPrompt('vào lms nộp file C:\\docs\\bao_cao_tuan5.docx cho bài tập tuần 5');
    assert.strictEqual(p1.userIntent, 'SOLVE_QUIZ');
    assert.strictEqual(p1.solveAssignments, true);
    assert.strictEqual(p1.attachmentPath, 'C:\\docs\\bao_cao_tuan5.docx');

    const p2 = extractCredentialsAndUrlFromPrompt('viết bài tự luận và xuất file docx nộp bài tập tuần 5');
    assert.strictEqual(p2.userIntent, 'SOLVE_QUIZ');
    assert.strictEqual(p2.solveAssignments, true);
    assert.strictEqual(p2.documentFormat, 'docx');

    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = makeIsolatedCtx({
      solveAssignments: true,
      documentFormat: 'docx',
      targetActivity: 'Nộp báo cáo tuần 5'
    });
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    let generatedArtifactPath: string | undefined;

    (ModelRouter as any).execute = async () => ({
      profileId: 'mock-doc-writer',
      modelUsed: 'mock-flash',
      output: JSON.stringify({
        essayText: 'Tóm tắt báo cáo tuần 5 về kỹ năng làm việc nhóm.',
        fileTitle: 'Bao cao Tuan 5 - Ky nang mem',
        fileContent: 'Phần 1: Mục tiêu làm việc nhóm\nPhần 2: Kết luận thực hành'
      })
    });

    try {
      // 2. From course 503, AI writes Atto text AND generates a real .docx artifact + uploads via direct multipart <input type="file">
      await page.goto(`${baseUrl}/course/view.php?id=503`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({
        tool: 'quiz.solve',
        args: {
          autoSubmit: true,
          solveAssignments: true,
          documentFormat: 'docx',
          targetActivity: 'Nộp báo cáo tuần 5'
        }
      }, ctx);
      assert.strictEqual(res.success, true, res.error || res.observationText);
      generatedArtifactPath = res.data?.uploadedFile;
      assert.ok(generatedArtifactPath && generatedArtifactPath.endsWith('.docx'));
      assert.strictEqual(serverState.assign503Submitted, true);
      assert.ok(serverState.assign503Text.includes('làm việc nhóm'));
      assert.strictEqual(serverState.assign503DocHeaderHex, '504B', 'Uploaded binary must be a genuine ZIP/DOCX starting with PK');
      assert.ok(serverState.assign503DocSize > 1000);

      // 3. Generic browser.fill also supports direct <input type="file"> upload on arbitrary forms
      const plainTxt = join(tempWorkDir, 'plain-note.txt');
      await writeFile(plainTxt, 'hello file upload');
      await page.goto(`${baseUrl}/generic-upload`, { waitUntil: 'domcontentloaded' });
      const fillFileRes = await executeAgentTool({
        tool: 'browser.fill',
        args: { selector: '#doc_upload', value: plainTxt }
      }, ctx);
      assert.strictEqual(fillFileRes.success, true);
      assert.strictEqual(await page.locator('#doc_upload').evaluate((el: HTMLInputElement) => el.files?.length), 1);
    } finally {
      (ModelRouter as any).execute = realExecute;
      if (generatedArtifactPath) {
        await unlink(generatedArtifactPath).catch(() => {});
      }
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-QUIZ-04: High-precision 2nd-pass catches overconfident negation & checkbox traps + TinyMCE qtype_essay', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = makeIsolatedCtx();
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    let verifyCalledWithTrapAndLabels = false;

    (ModelRouter as any).execute = async (req: any) => {
      if (req.system.includes('phản biện & kiểm chứng')) {
        const body = JSON.parse(req.text);
        const qList = body.questionsToVerify || [];
        // Both negation radio (0.88 < 0.92) and checkbox (0.91 < 0.92) must be escalated to 2nd pass with A/B labels & studyContext!
        const hasQ1 = qList.some((q: any) => q.id === 'm1' && q.options?.[0]?.label === 'A');
        const hasQ2 = qList.some((q: any) => q.id === 'm2');
        const hasStudy = typeof body.quizContext?.studyContext === 'string' && body.quizContext.studyContext.includes('không áp đặt');
        if (hasQ1 && hasQ2 && hasStudy) {
          verifyCalledWithTrapAndLabels = true;
        }
        return {
          profileId: 'mock-verify',
          modelUsed: 'mock-flash',
          output: JSON.stringify({
            answers: [
              { id: 'm1', reasoning: 'NGOẠI TRỪ -> chọn Áp đặt người nghe', selected: ['m1_o1'], confidence: 0.98 },
              { id: 'm2', reasoning: 'Đủ cả 2 ý đúng', selected: ['m2_o0', 'm2_o1'], confidence: 0.99 }
            ]
          })
        };
      }

      // Pass 1 intentionally returns overconfident wrong/incomplete answers for m1 (0.88) & m2 (0.91) + essay m3
      const parsed = JSON.parse(req.text);
      const ans = (parsed.questions || []).map((q: any) => {
        if (q.id === 'm1') return { id: 'm1', reasoning: 'Pass 1 nhầm khẳng định', selected: ['m1_o0'], confidence: 0.88 };
        if (q.id === 'm2') return { id: 'm2', reasoning: 'Pass 1 thiếu ý 2', selected: ['m2_o0'], confidence: 0.91 };
        return { id: 'm3', reasoning: 'Viết câu essay', text: 'Phản hồi tích cực giúp cải thiện hiệu quả giao tiếp.', confidence: 0.95 };
      });
      return {
        profileId: 'mock-pass1',
        modelUsed: 'mock-flash',
        output: JSON.stringify({ answers: ans })
      };
    };

    try {
      await page.goto(`${baseUrl}/course/view.php?id=601`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({ tool: 'quiz.solve', args: { autoSubmit: true } }, ctx);
      assert.strictEqual(res.success, true, res.error || res.observationText);
      assert.strictEqual(verifyCalledWithTrapAndLabels, true, 'High-risk negation & checkbox items must trigger labeled 2nd-pass verification with studyContext');
      assert.ok(serverState.quiz601SubmittedBody.includes('q1%3A1_answer=1'), 'm1 must end up fixed to option 1 (Áp đặt người nghe)');
      assert.ok(serverState.quiz601SubmittedBody.includes('q1%3A2_choice0=1') && serverState.quiz601SubmittedBody.includes('q1%3A2_choice1=1'), 'm2 must select both correct checkboxes');
      assert.ok(!serverState.quiz601SubmittedBody.includes('q1%3A2_choice2=1'), 'm2 must keep wrong option unchecked');
      assert.ok(decodeURIComponent(serverState.quiz601SubmittedBody.replace(/\+/g, ' ')).includes('cải thiện hiệu quả giao tiếp'));
    } finally {
      (ModelRouter as any).execute = realExecute;
      (WordAutomation as any).compose = realWordCompose;
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-WORD-05: Prompt Word extraction + AI structured essay -> Live Word compose & save -> push .docx -> confirm submit', async () => {
    // 1. Prompt parser checks for explicit Microsoft Word workflow cues and output save path
    const wp1 = extractCredentialsAndUrlFromPrompt('vào lms tự động mở Word viết bài tập tự luận rồi lưu và nộp');
    assert.strictEqual(wp1.userIntent, 'SOLVE_QUIZ');
    assert.strictEqual(wp1.solveAssignments, true);
    assert.strictEqual(wp1.useWordApp, true);
    assert.strictEqual(wp1.documentFormat, 'docx');

    const wp2 = extractCredentialsAndUrlFromPrompt('viết bài luận trong word rồi lưu vào C:\\Temp\\bai_luan_tuan6.docx và nộp lên LMS');
    assert.strictEqual(wp2.useWordApp, true);
    assert.strictEqual(wp2.wordSavePath, 'C:\\Temp\\bai_luan_tuan6.docx');
    assert.strictEqual(wp2.attachmentPath, undefined, 'Word save target must not be mistaken for a pre-existing attachmentPath');

    // 2. Security validation on Word save paths
    assert.throws(() => validateWordOutputPath(join(tempWorkDir, '.private', 'leak.docx')), /Sensitive/i);
    assert.throws(() => validateWordOutputPath(join(tempWorkDir, 'wrong.txt')), /\.docx/i);

    // 3. Python Word worker availability check (non-GUI check) + real path guard subprocess check
    const envCheck = await WordAutomation.checkAvailability();
    assert.strictEqual(typeof envCheck.ok, 'boolean');
    if (process.platform === 'win32') {
      assert.strictEqual(envCheck.wordComRegistered, true);
    }

    const guardProc = spawnSync(
      process.env.AUTOTASK_PYTHON || 'python',
      ['desktop/word_worker.py'],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          title: 'Guard check',
          content: 'Sensitive path must fail closed',
          outputPath: join(tempWorkDir, '.private', 'bad.docx')
        }),
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      }
    );
    assert.strictEqual(guardProc.status, 1, 'word_worker.py must reject .private output paths');
    assert.match(guardProc.stdout || '', /Sensitive output path/i);

    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = makeIsolatedCtx({ solveAssignments: true, useWordApp: true, documentFormat: 'docx' });
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    let generatedWordPath: string | undefined;
    let wordComposeCapturedInput: any = null;
    let expectedDocSha = '';

    (ModelRouter as any).execute = async () => ({
      profileId: 'mock-word-writer',
      modelUsed: 'mock-flash',
      output: JSON.stringify({
        essayText: 'Lãnh đạo nhóm hiệu quả đòi hỏi lắng nghe tích cực, phân công minh bạch và trách nhiệm giải trình.',
        fileTitle: 'Bai Luan Lanh Dao Nhom Tuan 6',
        fileContent: '# Phân tích kỹ năng lãnh đạo nhóm\nLãnh đạo nhóm là quá trình định hướng và truyền cảm hứng.\n\n## Ba trụ cột chính\n- Giao tiếp minh bạch\n- Phân công đúng năng lực\n- Phản hồi xây dựng'
      })
    });

    (WordAutomation as any).compose = async (input: any) => {
      wordComposeCapturedInput = input;
      const docOut = await createDocument({
        title: input.title,
        content: input.content,
        format: 'docx',
        baseName: 'autotask-word-test'
      });
      generatedWordPath = docOut.path;
      const bytes = await readFile(docOut.path);
      expectedDocSha = createHash('sha256').update(bytes).digest('hex');
      return {
        ok: true,
        usedWordApp: true,
        engine: 'microsoft-word-live',
        path: docOut.path,
        bytes: bytes.length,
        wordCount: 38,
        paragraphCount: 5,
        windowTitle: 'Microsoft Word',
        wasAlreadyRunning: false
      };
    };

    try {
      await page.goto(`${baseUrl}/mod/assign/view.php?id=504`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({
        tool: 'quiz.solve',
        args: { autoSubmit: true, solveAssignments: true, useWordApp: true }
      }, ctx);

      assert.strictEqual(res.success, true, res.error || res.observationText);
      assert.ok(wordComposeCapturedInput, 'WordAutomation.compose must be invoked');
      assert.strictEqual(wordComposeCapturedInput.visible, true);
      assert.ok(wordComposeCapturedInput.content.includes('# Phân tích kỹ năng lãnh đạo nhóm'));
      assert.strictEqual(res.data?.usedWordApp, true);
      assert.strictEqual(res.data?.wordEngine, 'microsoft-word-live');
      assert.strictEqual(res.data?.wordCount, 38);
      assert.strictEqual(res.data?.submitted, true);
      assert.strictEqual(serverState.assign504Submitted, true);
      assert.strictEqual(serverState.assign504UploadedHeaderHex, '504B');
      assert.strictEqual(serverState.assign504UploadedSha256, expectedDocSha);
      assert.ok(serverState.assign504UploadedSize > 1000);
      assert.ok(serverState.assign504Text.includes('phân công minh bạch'));

      // Verify agent.reportResult surfaces Microsoft Word metrics honestly
      const report = await executeAgentTool({
        tool: 'agent.reportResult',
        args: { status: 'DONE', summary: 'Đã hoàn tất bài tập qua Word.' }
      }, ctx);
      assert.strictEqual(report.success, true);
      assert.match(report.data?.summary || '', /Microsoft Word, 38 từ/);
    } finally {
      (ModelRouter as any).execute = realExecute;
      (WordAutomation as any).compose = realWordCompose;
      if (generatedWordPath) {
        await unlink(generatedWordPath).catch(() => {});
      }
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-WORD-06: Online-Text-only assignment drafts & saves in Word when useWordApp=true + Word python fallback honors custom path', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const customSavePath = join(tempWorkDir, 'saved-essay-custom.docx');
    const ctx = makeIsolatedCtx({ solveAssignments: true, useWordApp: true, wordSavePath: customSavePath });
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;

    let composeCalled = false;

    (ModelRouter as any).execute = async () => ({
      profileId: 'mock-word-essay',
      modelUsed: 'mock-flash',
      output: JSON.stringify({
        essayText: 'Phản biện xây dựng tập trung vào lập luận khách quan và giải pháp cải thiện.',
        fileTitle: 'Phan bien xay dung',
        fileContent: '# Vai trò của phản biện xây dựng\nPhản biện xây dựng giúp phát hiện điểm mù tư duy.'
      })
    });

    (WordAutomation as any).compose = async (input: any) => {
      composeCalled = true;
      assert.strictEqual(input.outputPath, customSavePath);
      const docOut = await createDocument({
        title: input.title,
        content: input.content,
        format: 'docx',
        baseName: 'autotask-online-word'
      });
      try {
        const bytes = await readFile(docOut.path);
        await writeFile(customSavePath, bytes);
        return {
          ok: true,
          usedWordApp: true,
          engine: 'microsoft-word-live',
          path: customSavePath,
          bytes: bytes.length,
          wordCount: 24,
          paragraphCount: 3
        };
      } finally {
        await unlink(docOut.path).catch(() => {});
      }
    };

    try {
      await page.goto(`${baseUrl}/mod/assign/view.php?id=505`, { waitUntil: 'domcontentloaded' });
      const res = await executeAgentTool({
        tool: 'quiz.solve',
        args: { autoSubmit: true, solveAssignments: true, useWordApp: true, wordSavePath: customSavePath }
      }, ctx);

      assert.strictEqual(res.success, true, res.error || res.observationText);
      assert.strictEqual(composeCalled, true, 'WordAutomation.compose must draft & save local .docx even for online-text-only when useWordApp=true');
      assert.strictEqual(res.data?.wroteEssay, true);
      assert.strictEqual(res.data?.usedWordApp, true);
      assert.strictEqual(res.data?.uploadedFile, customSavePath);
      assert.strictEqual(serverState.assign505Submitted, true);
      assert.ok(serverState.assign505Text.includes('lập luận khách quan'));

      const savedBytes = await readFile(customSavePath);
      assert.strictEqual(savedBytes.subarray(0, 2).toString('hex').toUpperCase(), '504B');
    } finally {
      (ModelRouter as any).execute = realExecute;
      (WordAutomation as any).compose = realWordCompose;
      await context.close().catch(() => {});
    }
  });

  test('ISOLATED-AUDIT-07: Assignment failOnAiError halts cleanly, runLogger records quizDetails, and compact promptModelSelection preserves/switches models', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const auditLogDir = join(tempWorkDir, 'audit-logs');
    await mkdir(auditLogDir, { recursive: true });
    const ctx = makeIsolatedCtx({ disableLogs: false, logDir: auditLogDir, useWordApp: false });
    ctx.browser = browser;
    ctx.context = context;
    ctx.page = page;
    ctx.runLogger = new AgentRunLogger({ goal: 'Kiểm thử audit assignment', ctx, logDir: auditLogDir });

    try {
      // 1. When AI fails with failOnAiError: true, executeAssignmentSubmit MUST halt cleanly without submitting garbage
      (ModelRouter as any).execute = async () => {
        throw new Error('429 All API keys exhausted');
      };

      await page.goto(`${baseUrl}/mod/assign/view.php?id=506`, { waitUntil: 'domcontentloaded' });
      const failRes = await executeAssignmentSubmit(page, ctx, { autoSubmit: true, failOnAiError: true, useWordApp: false });
      assert.strictEqual(failRes.success, false);
      assert.strictEqual(failRes.data?.aiFailed, true);
      assert.strictEqual(failRes.data?.submitted, false);
      assert.strictEqual(serverState.assign506Submitted, false, 'Must NOT submit fallback prompt copy when AI fails');

      // 2. When AI succeeds, executeAssignmentSubmit records details cleanly into ctx.runLogger.log.quizDetails
      (ModelRouter as any).execute = async () => ({
        profileId: 'mock-audit-prof',
        modelUsed: 'gemini-3.6-flash',
        output: JSON.stringify({
          essayText: 'Kiểm thử phần mềm giúp phát hiện sớm lỗi logic và bảo đảm chất lượng phát hành.',
          fileTitle: 'Kiem thu phan mem',
          fileContent: 'Nội dung kiểm thử phần mềm.'
        })
      });

      await page.goto(`${baseUrl}/mod/assign/view.php?id=506`, { waitUntil: 'domcontentloaded' });
      const okRes = await executeAssignmentSubmit(page, ctx, { autoSubmit: true, failOnAiError: true, useWordApp: false });
      assert.strictEqual(okRes.success, true, okRes.error || okRes.observationText);
      assert.strictEqual(okRes.data?.submitted, true);
      assert.strictEqual(serverState.assign506Submitted, true);
      assert.strictEqual(ctx.runLogger.log.quizDetails.length, 1);
      assert.strictEqual(ctx.runLogger.log.quizDetails[0].quizTitle, 'Bài tập kiểm thử audit 6');
      assert.strictEqual(ctx.runLogger.log.quizDetails[0].aiSolvedCount, 1);

      // 3. Compact follow-up model selector: Enter preserves active model in 1 step, 'm' opens full menu
      const mockDb: any = {
        default: 'p1',
        profiles: {
          p1: { provider: 'gemini', model: 'gemini-3.6-flash', authType: 'api-key', verifiedStatus: 'OK' }
        },
        fallbacks: []
      };
      ctx.config.modelOverride = 'gemini-3.6-flash';
      let promptsAsked = 0;
      const keepPick = await promptModelSelection(ctx, {
        question: async () => {
          promptsAsked++;
          return '';
        }
      }, { db: mockDb, compactIfChosen: true });
      assert.strictEqual(promptsAsked, 1);
      assert.strictEqual(keepPick.cancelled, false);
      assert.strictEqual(keepPick.modelOverride, 'gemini-3.6-flash');

      const seqAnswers = ['m', '1'];
      let seqIdx = 0;
      const expandPick = await promptModelSelection(ctx, {
        question: async () => seqAnswers[seqIdx++] ?? ''
      }, { db: mockDb, compactIfChosen: true });
      assert.strictEqual(seqIdx, 2);
      assert.strictEqual(expandPick.cancelled, false);
      assert.strictEqual(expandPick.mode, 'auto');
      assert.strictEqual(ctx.config.modelOverride, undefined);
    } finally {
      (ModelRouter as any).execute = realExecute;
      (WordAutomation as any).compose = realWordCompose;
      await context.close().catch(() => {});
    }
  });
});
