import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { executeTask } from '../src/main.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { loadCheckpoint, clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig, Question } from '../src/types.js';

interface AttemptSessionState {
  attemptId: number;
  status: 'inprogress' | 'finished';
  lastPage: number;
  /** Draft values saved ONLY when POST /mod/quiz/processattempt.php succeeds */
  savedFields: Record<string, string>;
  /** Count of processattempt saves per slot prefix */
  processAttemptPosts: number;
  uiChromeTouched: string[];
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function getCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function moodleChromeHtml(page: number, nextIsFinish: boolean): { head: string; foot: string } {
  return {
    head: `
      <header role="banner" class="navbar fixed-top navbar-light bg-white">
        <a class="navbar-brand" href="/course/view.php?id=10">HUSTLMS Sandbox</a>
        <div class="simplesearchform">
          <form role="search" action="/search/index.php" method="get" class="search-input-form">
            <label class="sr-only" for="nav-q">Search</label>
            <input id="nav-q" type="search" name="q" placeholder="Search" class="form-control">
          </form>
        </div>
      </header>
      <div class="course-search-bar">
        <form action="/course/search.php" method="get">
          <input type="text" name="courseSearch" aria-label="Search courses" placeholder="Search courses">
        </form>
      </div>
      <aside id="mod_quiz_navblock" class="block block_FakeBlock" role="navigation" aria-label="Quiz navigation">
        <div class="qn_buttons clearfix">
          <a class="qnbutton" id="quiznavbutton1" href="/mod/quiz/attempt.php?attempt=77&cmid=55&page=0">1</a>
          <a class="qnbutton" id="quiznavbutton4" href="/mod/quiz/attempt.php?attempt=77&cmid=55&page=1">4</a>
        </div>
        <div class="othernav"><a class="endtestlink" href="/mod/quiz/summary.php?attempt=77&cmid=55">Finish attempt ...</a></div>
        <div id="quiz-timer-wrapper">Time left <span id="quiz-time-left">14:20</span>
          <input type="text" name="timerfield" value="14:20" readonly aria-label="timer">
        </div>
      </aside>
      <form id="responseform" method="post" action="/mod/quiz/processattempt.php" enctype="application/x-www-form-urlencoded">
        <input type="hidden" name="attempt" value="77">
        <input type="hidden" name="cmid" value="55">
        <input type="hidden" name="thispage" value="${page}">
        <input type="hidden" name="nextpage" value="${nextIsFinish ? -1 : page + 1}">`,
    foot: `
        <div class="submitbtns">
          ${page > 0 ? '<input type="submit" name="previous" value="Previous page" class="mod_quiz-prev-nav btn btn-secondary">' : ''}
          <input type="submit" name="next" value="${nextIsFinish ? 'Finish attempt ...' : 'Next page'}" class="mod_quiz-next-nav btn btn-primary">
        </div>
      </form>
      <div class="jumpmenu">
        <form class="form-inline" action="/course/jumpto.php" method="get">
          <select id="jumpto" name="jump" class="custom-select urlselect" aria-label="Jump to...">
            <option value="">Jump to...</option>
            <option value="/mod/assign/view.php?id=9">Lab Assignment 1</option>
          </select>
        </form>
      </div>`
  };
}

function renderAttemptPage0(saved: Record<string, string>): string {
  const c = moodleChromeHtml(0, false);
  const m1Val = saved['q7001:1_answer'] ?? '-1';
  const m2Val0 = saved['q7001:2_sub0'] ?? '';
  const m2Val1 = saved['q7001:2_sub1'] ?? '';
  const m3Val = saved['q7001:3_answer'] ?? '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="Moodle 4.3">
    <title>Practice Quiz: Data Structures (Page 1 of 2)</title>
    <style>.sr-only,.accesshide{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
  </head>
  <body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz moodle">
    ${c.head}
    <!-- Slot 1: multichoice single with clear-my-choice and flag checkbox -->
    <div id="question-7001-1" class="que multichoice deferredfeedback ${m1Val !== '-1' ? 'answersaved' : 'notyetanswered'}">
      <div class="info">
        <h3 class="no">Question <span class="qno">1</span></h3>
        <div class="questionflag editable">
          <input type="checkbox" id="q7001:1_:flaggedcheckbox" name="q7001:1_:flagged" value="1">
          <label for="q7001:1_:flaggedcheckbox">Flag question</label>
        </div>
      </div>
      <div class="content"><div class="formulation clearfix">
        <input type="hidden" name="q7001:1_:sequencecheck" value="1">
        <div class="qtext"><p>Which ordering principle defines a Stack data structure?</p></div>
        <div class="ablock"><div class="answer">
          <div class="r0">
            <input type="radio" name="q7001:1_answer" value="0" id="q7001:1_answer0" aria-labelledby="q7001:1_answer0_lbl" ${m1Val === '0' ? 'checked' : ''}>
            <div id="q7001:1_answer0_lbl" class="d-flex w-100"><span class="answernumber">a. </span><div class="flex-fill">FIFO (First-In, First-Out)</div></div>
          </div>
          <div class="r1">
            <input type="radio" name="q7001:1_answer" value="1" id="q7001:1_answer1" aria-labelledby="q7001:1_answer1_lbl" ${m1Val === '1' ? 'checked' : ''}>
            <div id="q7001:1_answer1_lbl" class="d-flex w-100"><span class="answernumber">b. </span><div class="flex-fill">LIFO (Last-In, First-Out)</div></div>
          </div>
          <div class="qtype_multichoice_clearchoice">
            <input type="radio" name="q7001:1_answer" id="q7001:1_answer-1" value="-1" class="sr-only" ${m1Val === '-1' ? 'checked' : ''}>
            <label for="q7001:1_answer-1"><a href="#">Clear my choice</a></label>
          </div>
        </div></div>
      </div></div>
    </div>

    <!-- Slot 2: matching select (2 rows) with non-numeric option values ("o_stack", "o_queue") to verify select checkpoint resume -->
    <div id="question-7001-2" class="que match deferredfeedback ${m2Val0 ? 'answersaved' : 'notyetanswered'}">
      <div class="info"><h3 class="no">Question <span class="qno">2</span></h3></div>
      <div class="content"><div class="formulation clearfix">
        <div class="qtext"><p>Match each operation pair with its primary data structure.</p></div>
        <div class="ablock"><table class="answer"><tbody>
          <tr class="r0">
            <td class="text"><p>push / pop</p></td>
            <td class="control">
              <label class="sr-only" for="menuq7001:2_sub0">Answer 1</label>
              <select id="menuq7001:2_sub0" name="q7001:2_sub0" class="select custom-select">
                <option value="" ${m2Val0 === '' ? 'selected' : ''}>Choose...</option>
                <option value="o_queue" ${m2Val0 === 'o_queue' ? 'selected' : ''}>Queue</option>
                <option value="o_stack" ${m2Val0 === 'o_stack' ? 'selected' : ''}>Stack</option>
              </select>
            </td>
          </tr>
          <tr class="r1">
            <td class="text"><p>enqueue / dequeue</p></td>
            <td class="control">
              <label class="sr-only" for="menuq7001:2_sub1">Answer 2</label>
              <select id="menuq7001:2_sub1" name="q7001:2_sub1" class="select custom-select">
                <option value="" ${m2Val1 === '' ? 'selected' : ''}>Choose...</option>
                <option value="o_queue" ${m2Val1 === 'o_queue' ? 'selected' : ''}>Queue</option>
                <option value="o_stack" ${m2Val1 === 'o_stack' ? 'selected' : ''}>Stack</option>
              </select>
            </td>
          </tr>
        </tbody></table></div>
      </div></div>
    </div>

    <!-- Slot 3: shortanswer -->
    <div id="question-7001-3" class="que shortanswer deferredfeedback ${m3Val ? 'answersaved' : 'notyetanswered'}">
      <div class="info"><h3 class="no">Question <span class="qno">3</span></h3></div>
      <div class="content"><div class="formulation clearfix">
        <div class="qtext"><p>State the worst-case time complexity of array index lookup in Big-O notation.</p></div>
        <div class="ablock"><span class="answer">
          <label class="sr-only" for="q7001:3_answer">Answer:</label>
          <input type="text" id="q7001:3_answer" name="q7001:3_answer" value="${esc(m3Val)}" size="20" class="form-control d-inline">
        </span></div>
      </div></div>
    </div>
    ${c.foot}
  </body></html>`;
}

function renderAttemptPage1(saved: Record<string, string>): string {
  const c = moodleChromeHtml(1, true);
  const m4Val = saved['q7001:4_answer'] ?? '';
  const m5Val = saved['q7001:5_answer'] ?? '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="Moodle 4.3">
    <title>Practice Quiz: Data Structures (Page 2 of 2)</title>
    <style>.sr-only,.accesshide{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
  </head>
  <body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz moodle">
    ${c.head}
    <!-- Slot 4: truefalse -->
    <div id="question-7001-4" class="que truefalse deferredfeedback ${m4Val ? 'answersaved' : 'notyetanswered'}">
      <div class="info"><h3 class="no">Question <span class="qno">4</span></h3></div>
      <div class="content"><div class="formulation clearfix">
        <div class="qtext"><p>A balanced binary search tree guarantees O(log n) lookup time.</p></div>
        <div class="ablock"><div class="answer">
          <div class="r0"><input type="radio" name="q7001:4_answer" value="1" id="q7001:4_answer1" ${m4Val === '1' ? 'checked' : ''}><label for="q7001:4_answer1">True</label></div>
          <div class="r1"><input type="radio" name="q7001:4_answer" value="0" id="q7001:4_answer0" ${m4Val === '0' ? 'checked' : ''}><label for="q7001:4_answer0">False</label></div>
        </div></div>
      </div></div>
    </div>

    <!-- Slot 5: Moodle Atto contenteditable essay -->
    <div id="question-7001-5" class="que essay deferredfeedback ${m5Val ? 'answersaved' : 'notyetanswered'}">
      <div class="info"><h3 class="no">Question <span class="qno">5</span></h3></div>
      <div class="content"><div class="formulation clearfix">
        <div class="qtext"><p>Briefly explain the precondition and time complexity of binary search.</p></div>
        <div class="ablock"><div class="answer"><div class="editor_atto_wrap">
          <textarea id="q7001:5_answer" name="q7001:5_answer" style="display:none">${esc(m5Val)}</textarea>
          <div class="editor_atto">
            <div id="q7001:5_answereditable" class="editor_atto_content form-control" contenteditable="true" role="textbox" aria-multiline="true" style="min-height:80px">${esc(m5Val)}</div>
          </div>
        </div></div></div>
      </div></div>
    </div>
    ${c.foot}
  </body></html>`;
}

describe('Phase 6 — Real Browser & Two-Node-Process Moodle LMS Crash/Restart E2E', () => {
  let server: Server;
  let port = 0;
  let tempDir = '';
  const taskId = 'moodle-e2e-quiz-55';

  // Server-side ground truth state (keyed by MoodleSession cookie)
  const sessions = new Map<string, AttemptSessionState>();
  let attemptsCreatedCount = 0;
  let finalSubmitCalls = 0;
  let simulateProcessAttempt500 = false;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'autotask-moodle-e2e-'));
    await clearCheckpoint(taskId);

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      let sid = getCookie(req, 'MoodleSession');
      const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
      if (!sid) {
        sid = 'msess_e2e_77';
        headers['Set-Cookie'] = `MoodleSession=${sid}; Path=/; HttpOnly`;
      }

      if (u.pathname === '/course/view.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Course: IT3011 Data Structures</title></head>
          <body class="path-course-view moodle">
            <h1>IT3011 - Data Structures &amp; Algorithms</h1>
            <ul class="section">
              <li class="activity quiz modtype_quiz">
                <a href="/mod/quiz/view.php?id=55">Practice Quiz: Data Structures</a>
                <div class="activity-dates">Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM</div>
              </li>
            </ul>
          </body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/view.php') {
        const existing = sessions.get(sid);
        const btnLabel = existing && existing.status === 'inprogress'
          ? 'Continue the last attempt'
          : 'Attempt quiz now';
        const actionUrl = existing && existing.status === 'inprogress'
          ? `/mod/quiz/attempt.php?attempt=77&cmid=55&page=${existing.lastPage}`
          : '/mod/quiz/startattempt.php';
        const method = existing && existing.status === 'inprogress' ? 'get' : 'post';

        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Practice Quiz: Data Structures</title></head>
          <body class="path-mod-quiz moodle">
            <h2>Practice Quiz: Data Structures</h2>
            <div class="activity-dates">Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM</div>
            <p>Grading method: None (Ungraded permitted self-practice)</p>
            <form method="${method}" action="${actionUrl}">
              <input type="hidden" name="cmid" value="55">
              <button type="submit" class="btn btn-primary">${btnLabel}</button>
            </form>
          </body></html>`);
        return;
      }

      if (u.pathname === '/mod/quiz/startattempt.php' && req.method === 'POST') {
        attemptsCreatedCount++;
        sessions.set(sid, {
          attemptId: 77,
          status: 'inprogress',
          lastPage: 0,
          savedFields: {},
          processAttemptPosts: 0,
          uiChromeTouched: []
        });
        res.writeHead(303, { ...headers, Location: '/mod/quiz/attempt.php?attempt=77&cmid=55&page=0' });
        res.end();
        return;
      }

      if (u.pathname === '/mod/quiz/attempt.php') {
        const state = sessions.get(sid);
        if (!state) {
          res.writeHead(303, { ...headers, Location: '/mod/quiz/view.php?id=55' });
          res.end();
          return;
        }
        const pageNum = Number(u.searchParams.get('page') || '0');
        state.lastPage = pageNum;
        res.writeHead(200, headers);
        res.end(pageNum === 0 ? renderAttemptPage0(state.savedFields) : renderAttemptPage1(state.savedFields));
        return;
      }

      if (u.pathname === '/mod/quiz/processattempt.php' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          if (simulateProcessAttempt500) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><body><h1>HTTP 500 Internal Server Error</h1><p>Database write failed while transitioning to Page 2.</p></body></html>');
            return;
          }
          const form = parseFormUrlEncoded(body);
          const state = sessions.get(sid);
          if (!state) {
            res.writeHead(400);
            res.end('No active attempt');
            return;
          }
          if (form.finishattempt === '1') {
            finalSubmitCalls++;
            state.status = 'finished';
            res.writeHead(303, { Location: '/mod/quiz/review.php?attempt=77&cmid=55' });
            res.end();
            return;
          }
          state.processAttemptPosts++;
          for (const [k, v] of Object.entries(form)) {
            if (['q', 'courseSearch', 'jump', 'q7001:1_:flagged'].includes(k) && v) {
              state.uiChromeTouched.push(`${k}=${v}`);
            }
            if (k.startsWith('q7001:')) {
              state.savedFields[k] = v;
            }
          }
          const nextPage = Number(form.nextpage ?? '0');
          if (nextPage < 0) {
            res.writeHead(303, { Location: '/mod/quiz/summary.php?attempt=77&cmid=55' });
          } else {
            state.lastPage = nextPage;
            res.writeHead(303, { Location: `/mod/quiz/attempt.php?attempt=77&cmid=55&page=${nextPage}` });
          }
          res.end();
        });
        return;
      }

      if (u.pathname === '/mod/quiz/summary.php') {
        res.writeHead(200, headers);
        res.end(`<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Summary of attempt</title></head>
          <body class="path-mod-quiz moodle">
            <h2>Summary of attempt</h2>
            <form method="post" action="/mod/quiz/processattempt.php">
              <input type="hidden" name="attempt" value="77">
              <input type="hidden" name="finishattempt" value="1">
              <button type="submit" class="btn btn-primary">Submit all and finish</button>
            </form>
          </body></html>`);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>(resolveListen => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port;
        resolveListen();
      });
    });
  });

  after(async () => {
    await clearCheckpoint(taskId);
    await new Promise<void>(r => server.close(() => r()));
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('E2E-MOODLE-01: verifies all 14 checkpoints across two distinct Node processes (Process A crash -> Process B resume -> stop before final submit)', async () => {
    const storagePath = join(tempDir, 'moodle-storage.json');
    const workerScript = resolve('tests', 'helpers', 'lms-moodle-worker.ts');
    const tsxCli = resolve('node_modules', 'tsx', 'dist', 'cli.mjs');

    // ==================== LAUNCH PROCESS A ====================
    const eventsA: any[] = [];
    const stderrA: string[] = [];

    const procA = spawn(
      process.execPath,
      [tsxCli, workerScript, '--mode=processA', `--port=${port}`, `--taskId=${taskId}`, `--storagePath=${storagePath}`],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const pidA = procA.pid!;
    assert.ok(pidA && pidA !== process.pid, 'Process A must run in a separate OS process');

    try {
      await new Promise<void>((resolveCrashPoint, rejectCrashPoint) => {
        let buf = '';
        const timer = setTimeout(() => {
          procA.kill();
          rejectCrashPoint(new Error(`Process A timed out. Events: ${JSON.stringify(eventsA)} Stderr: ${stderrA.join('')}`));
        }, 60000);

        procA.stderr.on('data', d => stderrA.push(d.toString()));
        procA.stdout.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
              const ev = JSON.parse(trimmed);
              eventsA.push(ev);
              if (ev.event === 'PROCESS_A_CRASH_POINT_REACHED') {
                clearTimeout(timer);
                resolveCrashPoint();
              }
            } catch {}
          }
        });
        procA.on('exit', code => {
          if (!eventsA.some(e => e.event === 'PROCESS_A_CRASH_POINT_REACHED')) {
            clearTimeout(timer);
            rejectCrashPoint(new Error(`Process A exited prematurely (code=${code}): ${stderrA.join('')}`));
          }
        });
      });
    } catch (e) {
      try { procA.kill(); } catch {}
      throw e;
    }

    // Checkpoints 1-8 verified in Process A before crash
    const discEv = eventsA.find(e => e.event === 'PROCESS_A_DISCOVERED');
    assert.ok(discEv, 'Process A must complete course discovery');
    assert.equal(discEv.detectedCoursePlatform, 'moodle', 'Checkpoint 1: recognize Moodle platform');
    assert.equal(discEv.activities.length, 1, 'Checkpoint 2: discover quiz activity without starting attempt');
    assert.equal(discEv.activities[0].title, 'Practice Quiz: Data Structures');
    assert.ok(discEv.deadlines[0].startsWith('2026-11-14'), 'Checkpoint 2: extract Moodle Closed deadline');

    const crashEv = eventsA.find(e => e.event === 'PROCESS_A_CRASH_POINT_REACHED');
    assert.ok(crashEv);
    assert.deepEqual(crashEv.solvedQuestionIds, ['m1', 'm2_1', 'm2_2', 'm3'], 'Checkpoint 3 & 4: scan only m1, m2_1, m2_2, m3 (0 UI chrome items)');
    assert.deepEqual(crashEv.page2QuestionIds, ['m4', 'm5'], 'Checkpoint 7: verified navigation reached Page 2 (m4, m5)');
    assert.equal(crashEv.checkpointStepsCompleted, 1, 'Checkpoint 8: checkpoint saved for Step 1');
    assert.equal(crashEv.checkpointDomFilledSteps, 1, 'Checkpoint 8: domFilledSteps = 1');
    assert.equal(crashEv.checkpointServerSavedSteps, 1, 'Checkpoint 8 & 14: serverSavedSteps = 1 after verified POST to Page 2');
    assert.ok(crashEv.checkpointChecksum && crashEv.checkpointChecksum.length === 64, 'Checkpoint 8: SHA-256 checksum persisted');

    // Checkpoint 14 (part 1): Verify server actually received & persisted Step 1 draft via processattempt.php
    const serverSessionAfterA = sessions.get('msess_e2e_77')!;
    assert.ok(serverSessionAfterA, 'Server session must exist after Process A started attempt');
    assert.equal(attemptsCreatedCount, 1, 'Exactly 1 quiz attempt started');
    assert.equal(serverSessionAfterA.savedFields['q7001:1_answer'], '1', 'Server persisted m1 = LIFO (value 1)');
    assert.equal(serverSessionAfterA.savedFields['q7001:2_sub0'], 'o_stack', 'Server persisted m2_1 = Stack (value o_stack)');
    assert.equal(serverSessionAfterA.savedFields['q7001:2_sub1'], 'o_queue', 'Server persisted m2_2 = Queue (value o_queue)');
    assert.equal(serverSessionAfterA.savedFields['q7001:3_answer'], 'O(1)', 'Server persisted m3 = O(1)');
    assert.deepEqual(serverSessionAfterA.uiChromeTouched, [], 'Checkpoint 4: 0 UI chrome/flag controls touched');

    // ==================== CHECKPOINT 9: TERMINATE PROCESS A ====================
    await new Promise<void>(resolveExit => {
      procA.once('exit', () => resolveExit());
      procA.kill();
    });

    // ==================== CHECKPOINT 10-14: LAUNCH PROCESS B ====================
    const eventsB: any[] = [];
    const stderrB: string[] = [];

    const procB = spawn(
      process.execPath,
      [tsxCli, workerScript, '--mode=processB', `--port=${port}`, `--taskId=${taskId}`, `--storagePath=${storagePath}`],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const pidB = procB.pid!;
    assert.ok(pidB && pidB !== process.pid && pidB !== pidA, `Checkpoint 10: PID_B (${pidB}) !== PID_A (${pidA}) !== parent (${process.pid})`);

    const exitCodeB = await new Promise<number>((resolveB, rejectB) => {
      let buf = '';
      const timer = setTimeout(() => rejectB(new Error(`Process B timed out. Events: ${JSON.stringify(eventsB)} Stderr: ${stderrB.join('')}`)), 60000);

      procB.stderr.on('data', d => stderrB.push(d.toString()));
      procB.stdout.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try { eventsB.push(JSON.parse(trimmed)); } catch {}
        }
      });
      procB.on('exit', code => {
        clearTimeout(timer);
        resolveB(code ?? 1);
      });
    });

    assert.equal(exitCodeB, 0, `Process B must exit 0. Stderr: ${stderrB.join('')}`);
    const doneEv = eventsB.find(e => e.event === 'PROCESS_B_COMPLETED_TO_REVIEW');
    assert.ok(doneEv, `Process B completion event missing. Events: ${JSON.stringify(eventsB)}`);

    // Verify Checkpoints 10, 11, 12, 13, 14
    assert.ok(doneEv.pid && doneEv.pid !== crashEv.pid && doneEv.pid !== process.pid, `Worker PID_B (${doneEv.pid}) !== Worker PID_A (${crashEv.pid}) !== runner (${process.pid})`);
    assert.equal(doneEv.detectedAttemptPlatform, 'moodle');
    assert.equal(attemptsCreatedCount, 1, 'Checkpoint 12: Process B must NOT create a duplicate quiz attempt');
    assert.deepEqual(doneEv.solvedInProcessB, ['m4', 'm5'], 'Checkpoint 11 & 12: Process B solved ONLY Page 2 (m4, m5), zero re-fill of Page 1');
    assert.equal(doneEv.questionsFound, 6, 'Cumulative questionsFound across Pages 1+2 = 6');
    assert.equal(doneEv.questionsFilled, 6, 'Cumulative questionsFilled across Pages 1+2 = 6');
    assert.equal(doneEv.m4Checked, true, 'Checkpoint 6: Page 2 True/False radio verified on live DOM');
    assert.equal(
      doneEv.m5Text,
      'Binary search requires a sorted array and runs in O(log n) time.',
      'Checkpoint 6: Page 2 Moodle Atto contenteditable essay verified on live DOM'
    );
    assert.equal(
      doneEv.m5HiddenValue,
      'Binary search requires a sorted array and runs in O(log n) time.',
      'Checkpoint 6: Page 2 Moodle Atto paired hidden <textarea> dynamically synchronized'
    );
    assert.equal(doneEv.status, 'READY_FOR_REVIEW', 'Checkpoint 13: Task halts at READY_FOR_REVIEW for human review');
    assert.equal(doneEv.finishBtnVisible, true, 'Checkpoint 13: Stops right before "Finish attempt ..." button');
    assert.ok(doneEv.finalUrl.includes('page=1'), 'Checkpoint 13: Remains on Page 2 reviewable form, never auto-submitted');
    assert.equal(doneEv.checkpointDomFilledSteps, 2, 'Checkpoint 14: Page 2 is recorded as DOM-filled (domFilledSteps = 2)');
    assert.equal(doneEv.checkpointServerSavedSteps, 1, 'Checkpoint 14: Only Page 1 is server-saved (serverSavedSteps = 1)');
    assert.equal(finalSubmitCalls, 0, 'Checkpoint 13 & 14: 0 final submission POSTs sent to server');
    assert.equal(serverSessionAfterA.status, 'inprogress', 'Checkpoint 14: Server attempt status remains inprogress until explicit user submit');
    // Step 2 answers exist in browser DOM (domVerified=true), NOT yet posted to server (distinguishing DOM fill vs Server persistence!)
    assert.equal(serverSessionAfterA.savedFields['q7001:4_answer'], undefined, 'Checkpoint 14: Unposted Page 2 DOM draft is not falsely claimed as server-saved');
  });

  test('E2E-MOODLE-02: executeTask() against server HTTP 500 on processattempt.php never reports false save or completion success', async () => {
    const failTaskId = 'moodle-e2e-http500';
    const failSessionCookie = 'msess_http500_fail';
    const origExecute = ModelRouter.execute;
    simulateProcessAttempt500 = true;
    await clearCheckpoint(failTaskId);

    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'MoodleSession', value: failSessionCookie, domain: '127.0.0.1', path: '/' }]);

      ModelRouter.execute = (async (req: any) => {
        const parsed = JSON.parse(req.text) as { questions: Question[] };
        const answers = parsed.questions.map(q => {
          if (['radio', 'checkbox', 'select'].includes(q.kind)) {
            return { id: q.id, selected: [q.options[0].id], confidence: 0.92 };
          }
          return { id: q.id, text: 'O(1)', confidence: 0.92 };
        });
        return {
          output: JSON.stringify({ answers }),
          initialProfile: 'http500-test',
          finalProfile: 'http500-test',
          attempts: 1,
          fallbackCount: 0,
          history: []
        };
      }) as typeof ModelRouter.execute;

      const cfg: AppConfig = {
        allowedHosts: ['127.0.0.1'],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: [],
        deadlinePages: [],
        tasks: [],
        provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
      };

      const res = await executeTask(
        ctx,
        {
          id: failTaskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php?id=55`,
          title: 'Practice Quiz: Data Structures',
          aiPermitted: true,
          mode: 'PRACTICE_ASSISTED',
          confirmStartNewAttempt: true,
          maxPages: 3
        },
        cfg
      );

      // Must NOT report READY_FOR_REVIEW or SUBMITTED when processattempt.php returned HTTP 500
      assert.equal(res.status, 'PARTIAL');
      assert.ok(res.warnings.some(w => w.includes('HTTP 500')), `Expected HTTP 500 warning, got: ${JSON.stringify(res.warnings)}`);

      // Checkpoint on disk must record serverSavedSteps = 0 and roll back stepsCompleted to 0
      const cp = await loadCheckpoint(failTaskId);
      assert.ok(cp, 'Checkpoint must exist with explicit save failure state');
      assert.equal(cp.domFilledSteps, 1, 'DOM fill occurred before POST');
      assert.equal(cp.serverSavedSteps, 0, 'Server save count MUST remain 0 after HTTP 500');
      assert.equal(cp.stepsCompleted, 0, 'stepsCompleted rolled back to confirmed serverSavedSteps (0)');
      assert.ok(cp.lastSaveError?.includes('HTTP 500'), `Expected HTTP 500 in lastSaveError, got: ${cp.lastSaveError}`);

      // Server state must confirm zero persisted fields and zero submissions
      const state = sessions.get(failSessionCookie)!;
      assert.ok(state, 'Attempt was opened on server');
      assert.equal(state.processAttemptPosts, 0, 'Zero successful processattempt saves on server');
      assert.deepEqual(state.savedFields, {}, 'Server persisted 0 draft fields on HTTP 500');
      assert.equal(finalSubmitCalls, 0);

      await ctx.close();
    } finally {
      simulateProcessAttempt500 = false;
      ModelRouter.execute = origExecute;
      await clearCheckpoint(failTaskId);
      await browser.close();
    }
  });
});
