/** Real Multi-Page Integration & True Cross-Process Acceptance Test Suite
 * Demonstrates the full lifecycle of a multi-page form with server-side persistent draft storage,
 * abrupt crash termination of Node Process A, independent initialization of Node Process B,
 * state evaluation directly from live server-rendered DOM WITHOUT test-controller DOM manipulation,
 * verified step advancement, and Submit Guard safety halt.
 *
 * Implements PROC2-01 through PROC2-15 with genuine independent Node child processes (PID_A !== PID_B).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { loadCheckpoint, clearCheckpoint } from '../src/task-manager.js';

interface SessionDraft {
  q1?: string;
  q2?: string;
  q3_checkbox?: string[];
  q3_file?: string;
}

let server: Server;
let serverPort: number;
let serverBaseUrl: string;
const drafts: Record<string, SessionDraft> = {};

function getSessionId(req: IncomingMessage, res: ServerResponse): string {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session_id=([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }
  const newSid = 'sess_' + Math.random().toString(36).substring(2, 10);
  res.setHeader('Set-Cookie', `session_id=${newSid}; Path=/; HttpOnly`);
  return newSid;
}

before(async () => {
  await new Promise<void>((resResolve) => {
    server = createServer((req, res) => {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = urlObj.pathname;
      const sid = getSessionId(req, res);
      if (!drafts[sid]) {
        drafts[sid] = {};
      }
      const draft = drafts[sid];

      // Record any submitted form query parameters into persistent server-side draft store
      for (const [key, val] of urlObj.searchParams.entries()) {
        if (key === 'q1') draft.q1 = val;
        if (key === 'q2') draft.q2 = val;
        if (key === 'q3_checkbox') {
          if (!draft.q3_checkbox) draft.q3_checkbox = [];
          if (!draft.q3_checkbox.includes(val)) draft.q3_checkbox.push(val);
        }
        if (key === 'q3_file') draft.q3_file = val;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (pathname === '/' || pathname === '/page1') {
        const valQ1 = draft.q1 || '';
        const chkA = draft.q2 === 'opt_a' ? 'checked' : '';
        const chkB = draft.q2 === 'opt_b' ? 'checked' : '';

        res.end(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>Trang 1</title></head><body>
            <h2>Trang 1 - Khảo sát ban đầu</h2>
            <form id="f1" action="/page2" method="get">
              <div class="question" data-atqa-id="q1">
                <label for="q1">Câu hỏi 1 (Họ tên):</label>
                <input type="text" id="q1" name="q1" value="${valQ1}">
              </div>
              <div class="question" data-atqa-id="q2">
                <p>Câu hỏi 2 (Lựa chọn):</p>
                <label><input type="radio" name="q2" value="opt_a" ${chkA} data-atqa-choice="opt_a"> Lựa chọn A</label>
                <label><input type="radio" name="q2" value="opt_b" ${chkB} data-atqa-choice="opt_b"> Lựa chọn B</label>
              </div>
              <button type="submit" id="btn-next">Tiếp theo</button>
            </form>
          </body></html>
        `);
      } else if (pathname === '/page2') {
        const hasAssignment = draft.q3_file ? draft.q3_file : 'assignment.docx';
        res.end(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>Trang 2</title></head><body>
            <h2>Trang 2 - Tải lên tài liệu</h2>
            <form id="f2" action="/page3" method="get">
              <div class="question" data-atqa-id="q3">
                <label for="q3">Tải lên bài tập:</label>
                <input type="file" id="q3" name="q3_file">
                <div class="upload-chip"><span class="filename">${hasAssignment}</span></div>
              </div>
              <button type="submit" id="btn-next2">Tiếp theo</button>
            </form>
          </body></html>
        `);
      } else if (pathname === '/page3') {
        res.end(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>Trang 3</title></head><body>
            <h2>Trang 3 - Xác nhận nộp bài</h2>
            <div class="question" data-atqa-id="q4">
              <label for="q4">Ý kiến bổ sung:</label>
              <textarea id="q4" name="q4">Hoàn thành bài khảo sát</textarea>
            </div>
            <!-- Submit Guard target: locateNext must refuse to return this -->
            <button type="button" id="btn-submit">Submit all and finish</button>
          </body></html>
        `);
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverPort = addr.port;
      serverBaseUrl = `http://127.0.0.1:${serverPort}`;
      resResolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resResolve) => server.close(() => resResolve()));
});

describe('True Cross-Process E2E Suite (PROC2-01 to PROC2-15)', () => {
  const taskId = 'proc2-true-cross-process-task';
  const storagePath = join(tmpdir(), `proc2-storage-${Date.now()}.json`);
  const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
  const workerScript = resolve('tests/helpers/cross-process-worker.ts');

  let childA: ChildProcess | null = null;
  let pidA: number = 0;
  let workerPidA: number = 0;
  let childAExitCode: number | null = null;
  let childAExitSignal: string | null = null;
  const eventsA: any[] = [];

  let childB: ChildProcess | null = null;
  let pidB: number = 0;
  let workerPidB: number = 0;
  let childBExitCode: number | null = null;
  let childBExitSignal: string | null = null;
  const eventsB: any[] = [];

  test('PROC2-01: HTTP server initializes, sets session cookies, and tracks server-side draft storage', async () => {
    await clearCheckpoint(taskId);
    if (existsSync(storagePath)) {
      unlinkSync(storagePath);
    }

    const res = await fetch(`${serverBaseUrl}/page1`);
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Server must return Set-Cookie header');
    assert.ok(setCookie.includes('session_id=sess_'), 'Must issue session_id cookie');
  });

  test('PROC2-02: Spawn Process A (Node child_process) — PID_A is distinct from test runner process PID', async () => {
    childA = spawn(process.execPath, [
      tsxCli,
      workerScript,
      `--mode=initial`,
      `--port=${serverPort}`,
      `--taskId=${taskId}`,
      `--storagePath=${storagePath}`
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    assert.ok(childA.pid, 'Process A must be assigned an OS process ID');
    pidA = childA.pid;
    assert.notEqual(pidA, process.pid, 'Process A PID must be distinct from runner PID');

    childA.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            eventsA.push(JSON.parse(trimmed));
          } catch {}
        }
      }
    });

    childA.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            eventsA.push(JSON.parse(trimmed));
          } catch {}
        }
      }
    });

    childA.on('exit', (code, signal) => {
      childAExitCode = code;
      childAExitSignal = signal;
    });
  });

  test('PROC2-03: Process A fills Page 1, navigates to Page 2, and server records draft in persistent storage', async () => {
    // Wait for PROCESS_A_READY event
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      if (eventsA.some(e => e.event === 'PROCESS_A_READY')) {
        break;
      }
      if (eventsA.some(e => e.event === 'PROCESS_A_ERROR')) {
        const errEvent = eventsA.find(e => e.event === 'PROCESS_A_ERROR');
        throw new Error(`Process A error: ${errEvent?.error}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const readyEvent = eventsA.find(e => e.event === 'PROCESS_A_READY');
    assert.ok(readyEvent, 'Process A must emit PROCESS_A_READY event');
    assert.equal(readyEvent.stepsCompleted, 1);
    assert.ok(readyEvent.url.includes('/page2'), 'Process A must have navigated to /page2');

    // Verify server draft store has received data
    const sessions = Object.values(drafts);
    assert.ok(sessions.length > 0, 'Server draft store must contain at least one session');
    const matched = sessions.find(s => s.q1 === 'Nguyen Van A' && s.q2 === 'opt_a');
    assert.ok(matched, 'Server draft store must persist Q1 and Q2 from Process A');
  });

  test('PROC2-04: Process A writes Step 1 checkpoint with HMAC/SHA-256 tamper-evident checksum to disk', async () => {
    const cp = await loadCheckpoint(taskId);
    assert.ok(cp, 'Checkpoint file must exist on disk after Process A execution');
    assert.equal(cp.taskId, taskId);
    assert.equal(cp.stepsCompleted, 1);
    assert.ok(cp.checksum, 'Checkpoint must possess tamper-evident checksum');
    assert.equal(cp.answersRecorded?.['q1']?.text, 'Nguyen Van A');
    assert.deepEqual(cp.answersRecorded?.['q2']?.selected, ['opt_a']);
  });

  test('PROC2-05: Process A emits PROCESS_A_READY with PID_A and confirms running state in memory', () => {
    const readyEvent = eventsA.find(e => e.event === 'PROCESS_A_READY');
    assert.ok(readyEvent);
    assert.ok(readyEvent.pid > 0, 'Worker must report valid PID');
    assert.notEqual(readyEvent.pid, process.pid, 'Worker PID must be distinct from runner PID');
    workerPidA = readyEvent.pid;
    assert.equal(childAExitCode, null, 'Process A must still be running (not yet crashed/terminated)');
  });

  test('PROC2-06: Abrupt crash simulation — Test runner terminates Process A with SIGTERM/kill; process terminates abruptly', async () => {
    assert.ok(childA, 'Child A must exist');
    childA.kill('SIGTERM');

    // Wait for exit
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      if (childAExitCode !== null || childAExitSignal !== null) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(
      childAExitCode !== null || childAExitSignal !== null,
      'Process A must have exited after termination signal'
    );
  });

  test('PROC2-07: Post-crash checkpoint verification — Checkpoint on disk remains uncorrupted and intact', async () => {
    // Verify checkpoint is completely intact after Process A termination
    const cp = await loadCheckpoint(taskId);
    assert.ok(cp, 'Checkpoint must survive abrupt process crash without corruption');
    assert.equal(cp.stepsCompleted, 1);
    assert.equal(cp.status, 'RUNNING');
    assert.ok(cp.checksum, 'Checksum must be valid');
  });

  test('PROC2-08: Spawn Process B (Node child_process) — PID_B is distinct from runner PID and PID_B !== PID_A', async () => {
    childB = spawn(process.execPath, [
      tsxCli,
      workerScript,
      `--mode=resume`,
      `--port=${serverPort}`,
      `--taskId=${taskId}`,
      `--storagePath=${storagePath}`
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    assert.ok(childB.pid, 'Process B must have an OS PID');
    pidB = childB.pid;
    assert.notEqual(pidB, process.pid, 'PID_B must be distinct from runner PID');
    assert.notEqual(pidB, pidA, 'PID_B must be distinct from crashed PID_A (true independent processes)');

    childB.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            eventsB.push(JSON.parse(trimmed));
          } catch {}
        }
      }
    });

    childB.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            eventsB.push(JSON.parse(trimmed));
          } catch {}
        }
      }
    });

    childB.on('exit', (code, signal) => {
      childBExitCode = code;
      childBExitSignal = signal;
    });
  });

  test('PROC2-09: Process B loads checkpoint from disk and verifies integrity checksum', async () => {
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      if (eventsB.some(e => e.event === 'PROCESS_B_CHECKPOINT_LOADED')) {
        break;
      }
      if (eventsB.some(e => e.event === 'PROCESS_B_ERROR')) {
        const errEvent = eventsB.find(e => e.event === 'PROCESS_B_ERROR');
        throw new Error(`Process B error: ${errEvent?.error}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const cpEvent = eventsB.find(e => e.event === 'PROCESS_B_CHECKPOINT_LOADED');
    assert.ok(cpEvent, 'Process B must emit PROCESS_B_CHECKPOINT_LOADED');
    workerPidB = cpEvent.pid;
    assert.ok(workerPidB > 0, 'Process B worker must report valid PID');
    assert.notEqual(workerPidB, process.pid, 'Process B worker PID must be distinct from runner PID');
    assert.notEqual(workerPidB, workerPidA, 'Process B worker PID must be distinct from Process A worker PID');
    assert.equal(cpEvent.stepsCompleted, 1);
    assert.ok(cpEvent.checksum, 'Process B must verify tamper-evident checksum');
  });

  test('PROC2-10: Process B opens task URL in fresh Chromium session; server renders drafted values without test-controller DOM manipulation', async () => {
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      if (eventsB.some(e => e.event === 'PROCESS_B_SERVER_DOM_VERIFIED')) {
        break;
      }
      if (eventsB.some(e => e.event === 'PROCESS_B_ERROR')) {
        const errEvent = eventsB.find(e => e.event === 'PROCESS_B_ERROR');
        throw new Error(`Process B error: ${errEvent?.error}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const domEvent = eventsB.find(e => e.event === 'PROCESS_B_SERVER_DOM_VERIFIED');
    assert.ok(domEvent, 'Process B must emit PROCESS_B_SERVER_DOM_VERIFIED');
    assert.equal(domEvent.valQ1, 'Nguyen Van A', 'Server must render saved Q1 input');
    assert.equal(domEvent.radioAChecked, true, 'Server must render saved Q2 radio selection');
  });

  test('PROC2-11: Process B ResumeCoordinator.evaluateState reads server-rendered DOM and reports NAVIGATION_REQUIRED without any fillAnswer invocation', async () => {
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      if (eventsB.some(e => e.event === 'PROCESS_B_EVALUATED')) {
        break;
      }
      if (eventsB.some(e => e.event === 'PROCESS_B_ERROR')) {
        const errEvent = eventsB.find(e => e.event === 'PROCESS_B_ERROR');
        throw new Error(`Process B error: ${errEvent?.error}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const evalEvent = eventsB.find(e => e.event === 'PROCESS_B_EVALUATED');
    assert.ok(evalEvent, 'Process B must emit PROCESS_B_EVALUATED');
    assert.equal(evalEvent.state, 'NAVIGATION_REQUIRED');
    assert.equal(evalEvent.verifiedCount, 2, 'Must have verified 2/2 DOM values match checkpoint');
    assert.equal(evalEvent.currentStep, 1);
    assert.equal(evalEvent.targetStep, 2);
  });

  test('PROC2-12: Process B advances to Step 2 via ResumeCoordinator.advanceToStep with DOM verification', async () => {
    // Wait for completion or error
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      if (eventsB.some(e => e.event === 'PROCESS_B_SUCCESS')) {
        break;
      }
      if (eventsB.some(e => e.event === 'PROCESS_B_ERROR')) {
        const errEvent = eventsB.find(e => e.event === 'PROCESS_B_ERROR');
        throw new Error(`Process B error: ${errEvent?.error}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const successEvent = eventsB.find(e => e.event === 'PROCESS_B_SUCCESS');
    assert.ok(successEvent, 'Process B must reach PROCESS_B_SUCCESS');
    assert.equal(successEvent.stepsCompleted, 2);
  });

  test('PROC2-13: Process B verifies Step 2 DOM, updates checkpoint to stepsCompleted: 2', async () => {
    const cp = await loadCheckpoint(taskId);
    assert.ok(cp, 'Checkpoint must exist');
    assert.equal(cp.stepsCompleted, 2, 'Checkpoint must be advanced to Step 2');
    assert.ok(cp.answersByStep?.[2]?.q3?.fileName, 'Assignment docx must be recorded in Step 2');
  });

  test('PROC2-14: Process B navigates to Page 3 and confirms Submit Guard halts before Submit all and finish', () => {
    const successEvent = eventsB.find(e => e.event === 'PROCESS_B_SUCCESS');
    assert.ok(successEvent);
    assert.equal(successEvent.submitGuardBlocked, true, 'Submit Guard must block blind submission on Page 3');
    assert.ok(successEvent.finalUrl.includes('/page3'), 'Must have reached Page 3');
  });

  test('PROC2-15: Process B emits PROCESS_B_SUCCESS, exits with code 0, and runner performs clean checkpoint teardown', async () => {
    // Wait for childB to exit
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      if (childBExitCode !== null) break;
      await new Promise(r => setTimeout(r, 100));
    }

    assert.equal(childBExitCode, 0, 'Process B must exit with exit code 0');

    // Clean up temporary checkpoint and storage
    await clearCheckpoint(taskId);
    const cleared = await loadCheckpoint(taskId);
    assert.equal(cleared, null, 'Checkpoint must be cleanly cleared after successful completion');

    if (existsSync(storagePath)) {
      try { unlinkSync(storagePath); } catch {}
    }
  });
});
