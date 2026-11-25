/** Isolated Test Suite: Upgrades v12 (RAG/Review/Vision/Ordering, Handwriting+Word+Extract, BrowserDownload/GForms/Parallel, Key Scanner/Role Routing) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { executeQuizSolve } from '../src/agent/quiz-solver.js';
import { executeAssignmentSubmit } from '../src/agent/assignment-solver.js';
import { executeAgentTool, formatDeadlinesObservation } from '../src/agent/tools.js';
import { synthesizeSpeechWav, parseSubtitleTranscript } from '../src/agent/multimedia-interactive.js';
import { DEFAULT_ALLOWED_HOSTS, extractCredentialsAndUrlFromPrompt } from '../src/agent/loop.js';
import { resolveKnownPlatformFromPrompt } from '../src/agent/lms-catalog.js';
import { buildHistoryPrompt } from '../src/agent/planner.js';
import { parseDeadline } from '../src/calendar.js';
import { HandwritingGenerator } from '../src/agent/handwriting.js';
import { detectProviderFromApiKey, scanAndSelectModelFromApiKey, addApiKeysToProfile } from '../src/agent/cli.js';
import { createDocument, extractLocalDocumentText } from '../src/documents.js';
import {
  ModelRouter,
  getCooldownKey,
  resetProfileCooldowns,
  getKeySlotTelemetrySnapshot,
  syncCooldownFromProbe,
  recordKeySlotUsage
} from '../src/model-center/model-router.js';
import { readProfilesDb, saveProfilesDb, getProfileKeySlots } from '../src/model-center/routing.js';
import type { ModelProfilesDb } from '../src/model-center/types.js';
import type { ProviderSpec, ResolvedProvider } from '../src/providers.js';
import type { AgentContext } from '../src/agent/types.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DwHwMAAQYBAf4Y09UAAAAASUVORK5CYII=';

let srv: Server;
let baseUrl: string;
let browser: Browser;
let tempDir: string;
const realExecute = ModelRouter.execute;

const state = {
  quiz701Submitted: '' as string,
  quiz801Submitted: '' as string,
  quiz802Submitted: '' as string,
  assign803UploadedName: '',
  assign803UploadedSize: 0,
  assign803UploadedMagic: '',
  assign803Submitted: false,
  gformPage2Submitted: '' as string,
  parallelQuizHits: [] as string[],
  parallelCourseHits: [] as string[],
  spaQuizSubmitted: '' as string,
  multimediaSubmitted: '' as string,
  quiz851Submitted: '' as string,
  quiz861Submitted: '' as string,
  quiz861SearchHijacked: false,
  quiz881Round: 0,
  quiz891Round: 0,
  quiz891LastQ1: '' as string,
  quiz891LastQ2: '' as string,
  quiz892Round: 0
};

function makeCtx(overrides?: Partial<AgentContext['config']>): AgentContext {
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
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function mockRouterRes(output: string, modelUsed = 'mock-model') {
  return {
    output,
    modelUsed,
    initialProfile: 'mock',
    finalProfile: 'mock',
    attempts: 1,
    fallbackCount: 0,
    history: [],
    latencyMs: 5
  };
}

test.describe('Upgrades v12 — Mục 1..4 Isolated Verification', () => {
  test.before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'at-v12-'));

    srv = createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const path = reqUrl.pathname;
      const id = reqUrl.searchParams.get('id') || '';

      // 1. Slide / Course Material TXT for RAG & browser.download
      if (path === '/slides/note80.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Tài liệu bài giảng chương 8: Mã xác thực bài giảng là XRAY-9988.');
        return;
      }

      // 2. Mục 1A: Review-guided Re-attempt Quiz 701
      if (path === '/mod/quiz/view.php' && id === '701') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Quiz 701</title></head><body>
          <h1>Quiz 701 - Địa lý</h1>
          <div id="feedback">Your final grade for this quiz is 5.00/10.00.</div>
          <a href="/mod/quiz/review.php?attempt=700">Review</a>
          <form method="GET" action="/mod/quiz/attempt.php">
            <input type="hidden" name="attempt" value="701"/>
            <button type="submit">Re-attempt quiz</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/review.php' && reqUrl.searchParams.get('attempt') === '700') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Review Quiz 701</title></head><body>
          <div class="que multichoice deferredfeedback incorrect">
            <div class="content"><div class="qtext">Thủ đô của Việt Nam?</div>
            <div class="answer">Your answer is incorrect.</div>
            <div class="outcome"><div class="feedback"><div class="specificfeedback">Hãy nhớ chọn thành phố miền Bắc.</div><div class="rightanswer">The correct answer is: Hà Nội</div></div></div>
            </div>
          </div>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('attempt') === '701') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Attempt 701</title></head><body>
          <form method="POST" action="/mod/quiz/processattempt.php?id=701">
            <div id="question-1-1" class="que multichoice deferredfeedback">
              <div class="content">
                <div class="qtext">Thủ đô của Việt Nam?</div>
                <div class="answer">
                  <div class="r0"><input type="radio" id="q701_a" name="q1_ans" value="0"/><label for="q701_a">Đà Nẵng</label></div>
                  <div class="r1"><input type="radio" id="q701_b" name="q1_ans" value="1"/><label for="q701_b">Hà Nội</label></div>
                </div>
              </div>
            </div>
            <button type="submit" name="finishattempt">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/processattempt.php' && id === '701' && req.method === 'POST') {
        state.quiz701Submitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Review 701</h1><div>Grade 10.00 out of 10.00</div></body></html>');
        return;
      }

      // 3. Mục 1B: Course 80 (RAG + Visual 2nd-opinion)
      if (path === '/course/view.php' && id === '80') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 80</title></head><body>
          <ul><li class="section main" id="section-1">
            <h3>Chương 8</h3>
            <a href="/slides/note80.txt">Slide bài giảng chương 8</a>
            <a href="/mod/quiz/view.php?id=801">Quiz 801: Kiểm tra chương 8</a>
          </li></ul>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '801') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Quiz 801</h1>
          <form method="GET" action="/mod/quiz/attempt.php">
            <input type="hidden" name="id" value="801"/>
            <button type="submit">Attempt quiz now</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '801') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <form method="POST" action="/mod/quiz/processattempt.php?id=801">
            <div id="question-2-1" class="que shortanswer">
              <div class="content">
                <div class="qtext">Nhập mã xác thực trong slide chương 8:</div>
                <div class="answer"><input type="text" name="q801_1" value=""/></div>
              </div>
            </div>
            <div id="question-2-2" class="que multichoice">
              <div class="content">
                <div class="qtext">Nhìn hình vẽ sau và chọn màu: <img src="data:image/png;base64,${TINY_PNG_BASE64}" alt="sample"/></div>
                <div class="answer">
                  <div class="r0"><input type="radio" id="q801_2a" name="q801_2" value="0"/><label for="q801_2a">Đỏ</label></div>
                  <div class="r1"><input type="radio" id="q801_2b" name="q801_2" value="1"/><label for="q801_2b">Xanh</label></div>
                </div>
              </div>
            </div>
            <button type="submit">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/processattempt.php' && id === '801' && req.method === 'POST') {
        state.quiz801Submitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div>Grade 10.00 / 10.00</div></body></html>');
        return;
      }

      // 4. Mục 1C: Moodle Advanced Ordering quiz 802
      if (path === '/mod/quiz/attempt.php' && id === '802') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <form method="POST" action="/mod/quiz/processattempt.php?id=802">
            <div id="question-3-1" class="que ordering">
              <div class="formulation">
                <div class="qtext">Sắp xếp các bước tăng dần:</div>
                <div class="answer ordering">
                  <ul class="sortablelist" id="ord_list_802">
                    <li class="sortableitem" draggable="true" data-value="item_b">Bước 2</li>
                    <li class="sortableitem" draggable="true" data-value="item_a">Bước 1</li>
                  </ul>
                  <input type="hidden" id="ord_val_802" name="q3:1_response_ordering" value="item_b,item_a"/>
                </div>
              </div>
            </div>
            <button type="submit">Submit all and finish</button>
          </form>
          <script>
            (function() {
              var list = document.getElementById('ord_list_802');
              var hidden = document.getElementById('ord_val_802');
              var dragged = null;
              list.addEventListener('dragstart', function(e) {
                dragged = e.target.closest('.sortableitem');
                if (e.dataTransfer) e.dataTransfer.setData('text/plain', dragged ? dragged.dataset.value : '');
              });
              list.addEventListener('dragover', function(e) { e.preventDefault(); });
              list.addEventListener('drop', function(e) {
                e.preventDefault();
                var target = e.target.closest('.sortableitem');
                if (dragged && target && dragged !== target) {
                  list.insertBefore(dragged, target);
                  hidden.value = Array.from(list.querySelectorAll('.sortableitem')).map(function(n){ return n.dataset.value; }).join(',');
                }
              });
            })();
          </script>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/processattempt.php' && id === '802' && req.method === 'POST') {
        state.quiz802Submitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div>Grade 10.00 / 10.00</div></body></html>');
        return;
      }

      // 5. Mục 2A: Handwritten PDF assignment upload 803
      if (path === '/mod/assign/view.php' && id === '803') {
        if (req.method === 'POST') {
          const buf = await readRawBody(req);
          const raw = buf.toString('latin1');
          const m = raw.match(/filename="([^"]+)"/);
          state.assign803UploadedName = m ? m[1] : '';
          state.assign803UploadedSize = buf.length;
          state.assign803UploadedMagic = raw.includes('%PDF-') ? 'PDF' : 'OTHER';
          state.assign803Submitted = true;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><td class="submissionstatussubmitted">Submitted for grading</td></body></html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Bài tập viết tay 803</h1>
          <form method="POST" enctype="multipart/form-data" action="/mod/assign/view.php?id=803">
            <input type="file" name="submission_file"/>
            <button type="submit">Save changes</button>
          </form>
        </body></html>`);
        return;
      }

      // 6. Mục 3A: Google Forms 2-page simulation
      if (path === '/forms/d/e/test/viewform') {
        const pg = reqUrl.searchParams.get('page') || '1';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (pg === '1') {
          res.end(`<!doctype html><html><body>
            <form id="gf1">
              <div role="listitem" class="freebirdFormviewerComponentsQuestionBaseRoot">
                <div role="heading">Chọn đáp án đúng ở trang 1:</div>
                <input type="radio" id="gf1_a" name="entry.1" value="Sai"/><label for="gf1_a">Sai</label>
                <input type="radio" id="gf1_b" name="entry.1" value="Đúng"/><label for="gf1_b">Đúng</label>
              </div>
              <div role="button" tabindex="0" onclick="window.location='/forms/d/e/test/viewform?page=2'">Tiếp</div>
            </form>
          </body></html>`);
        } else {
          res.end(`<!doctype html><html><body>
            <form id="gf2" method="POST" action="/forms/d/e/test/formResponse">
              <div role="listitem" class="freebirdFormviewerComponentsQuestionBaseRoot">
                <div role="heading">Nhập ghi chú trang 2:</div>
                <input type="text" name="entry.2" value=""/>
              </div>
              <div role="button" tabindex="0" onclick="document.getElementById('gf2').submit()">Gửi</div>
            </form>
          </body></html>`);
        }
        return;
      }
      if (path === '/forms/d/e/test/formResponse' && req.method === 'POST') {
        state.gformPage2Submitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div>Câu trả lời của bạn đã được ghi lại.</div></body></html>');
        return;
      }

      // 7. Mục 3B: Parallel Multi-Quiz course 90 & Parallel Multi-Course dashboard (/my/)
      if (path === '/course/view.php' && id === '90') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 90 Parallel</title></head><body><ul>
          <li><a href="/mod/quiz/view.php?id=901">Quiz 01</a></li>
          <li><a href="/mod/quiz/view.php?id=902">Quiz 02</a></li>
          <li><a href="/mod/quiz/view.php?id=903">Quiz 03</a></li>
        </ul></body></html>`);
        return;
      }
      if (path === '/course/view.php' && (id === '91' || id === '92')) {
        const qId = id === '91' ? '911' : '921';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>${id === '91' ? 'ED3220' : 'IT3040'}</title></head><body><ul>
          <li><a href="/mod/quiz/view.php?id=${qId}">Quiz ${qId}</a></li>
        </ul></body></html>`);
        return;
      }
      if (path === '/my/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Dashboard</title></head><body>
          <a href="/course/view.php?id=91">ED3220 - Kỹ năng mềm</a>
          <a href="/course/view.php?id=92">IT3040 - Kỹ thuật lập trình</a>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && /^90[123]|911|921$/.test(id)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Quiz ${id}</h1>
          <form method="GET" action="/mod/quiz/attempt.php">
            <input type="hidden" name="id" value="${id}"/>
            <button type="submit">Attempt quiz now</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && /^90[123]|911|921$/.test(id)) {
        if (/^90[123]$/.test(id)) {
          state.parallelQuizHits.push(`start:${id}:${Date.now()}`);
          await new Promise(r => setTimeout(r, 120));
        } else {
          state.parallelCourseHits.push(`start:${id}:${Date.now()}`);
          await new Promise(r => setTimeout(r, 80));
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <form method="POST" action="/mod/quiz/processattempt.php?id=${id}">
            <div id="question-${id}-1" class="que multichoice">
              <div class="content">
                <div class="qtext">Câu hỏi của bài ${id}?</div>
                <div class="answer">
                  <div class="r0"><input type="radio" id="q_${id}_a" name="q_${id}" value="0"/><label for="q_${id}_a">Đáp án A</label></div>
                </div>
              </div>
            </div>
            <button type="submit">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/processattempt.php' && /^90[123]|911|921$/.test(id)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div>Grade 10.00 / 10.00</div></body></html>');
        return;
      }

      // 8. Mục 5: Real-time deadline classification & Opened-only filtering
      if (path === '/my/courses-star') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>My courses</title></head><body>
          <div class="dashboard-card">
            <a href="https://example.invalid/courses/#">Star this course</a>
            <a href="/my/courses.php#">Star this course</a>
            <a href="/course/view.php?id=95">BL-MI2020 - Xác suất thống kê</a>
          </div>
        </body></html>`);
        return;
      }
      if (path === '/course/view.php' && id === '95') {
        const futureDate = new Date(Date.now() + 3 * 86400000);
        const dd = String(futureDate.getDate()).padStart(2, '0');
        const mm = String(futureDate.getMonth() + 1).padStart(2, '0');
        const yyyy = futureDate.getFullYear();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>XSTK 95</title></head><body>
          <ul>
            <li class="section main"><h3 class="sectionname">Tuần 1</h3><ul>
              <li class="activity modtype_resource">
                <span class="instancename">Video bài giảng chương 1</span>
                <div class="activity-dates">Opened: <time datetime="2026-09-06T17:00:00.000Z">7 September 2026</time></div>
              </li>
              <li class="activity modtype_quiz">
                <a class="aalink" href="/mod/quiz/view.php?id=951"><span class="instancename">Ôn tập tuần 1</span></a>
                <div class="activity-dates">Opened: Monday, 7 September 2026, 12:00 AM Closed: Saturday, 26 September 2026, 11:59 PM</div>
              </li>
            </ul></li>
            <li class="section main"><h3 class="sectionname">Tuần 12</h3><ul>
              <li class="activity modtype_quiz">
                <a class="aalink" href="/mod/quiz/view.php?id=952"><span class="instancename">Kiểm tra trắc nghiệm sắp tới</span></a>
                <div class="activity-dates">Hạn nộp: ${dd}/${mm}/${yyyy} 23:59</div>
              </li>
            </ul></li>
          </ul>
        </body></html>`);
        return;
      }

      // 9. Mục 6: Deep Verify closed quizzes (done vs missed) & Single-URL SPA quiz (SohoA/HUSTack)
      if (path === '/course/view.php' && id === '96') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 96 DeepVerify</title></head><body>
          <ul>
            <li class="activity modtype_quiz">
              <a class="aalink" href="/mod/quiz/view.php?id=961"><span class="instancename">Quiz 961 (Đã làm trước khi đóng)</span></a>
              <div class="activity-dates">Closed: Saturday, 3 October 2026, 11:59 PM</div>
            </li>
            <li class="activity modtype_quiz">
              <a class="aalink" href="/mod/quiz/view.php?id=962"><span class="instancename">Quiz 962 (Bỏ lỡ khi đóng)</span></a>
              <div class="activity-dates">Closed: Saturday, 10 October 2026, 11:59 PM</div>
            </li>
          </ul>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '961') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Quiz 961</h1>
          <div class="quizinfo">Closed: Saturday, 3 October 2026, 11:59 PM</div>
          <table class="generaltable quizattemptsummary">
            <tbody><tr><td>Finished</td><td>9.50 / 10.00</td></tr></tbody>
          </table>
          <div>Your final grade for this quiz is 9.50 / 10.00.</div>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '962') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Quiz 962</h1>
          <div class="quizinfo">This quiz closed on Saturday, 10 October 2026, 11:59 PM</div>
          <div>No more attempts are allowed</div>
        </body></html>`);
        return;
      }
      if (path === '/sohoa/phong-hoc/kiem-tra/97') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>SohoA SPA Exam</title></head><body>
          <div id="spa-stage">
            <fieldset>
              <legend>Câu 1 SPA: 2 + 2 = ?</legend>
              <input type="radio" id="s1_a" name="s1" value="3"/><label for="s1_a">3</label>
              <input type="radio" id="s1_b" name="s1" value="4"/><label for="s1_b">4</label>
            </fieldset>
            <button type="button" id="next-spa" onclick="nextStep()">Câu tiếp</button>
          </div>
          <script>
            window.__answers = [];
            function nextStep() {
              var sel1 = document.querySelector('input[name="s1"]:checked');
              window.__answers.push('s1=' + (sel1 ? sel1.value : ''));
              document.getElementById('spa-stage').innerHTML =
                '<fieldset><legend>Câu 2 SPA: Thủ đô Nhật Bản?</legend>' +
                '<input type="radio" id="s2_a" name="s2" value="Osaka"/><label for="s2_a">Osaka</label>' +
                '<input type="radio" id="s2_b" name="s2" value="Tokyo"/><label for="s2_b">Tokyo</label>' +
                '</fieldset>' +
                '<button type="button" id="submit-spa" onclick="submitSpa()">Hoàn thành bài thi</button>';
            }
            function submitSpa() {
              var sel2 = document.querySelector('input[name="s2"]:checked');
              window.__answers.push('s2=' + (sel2 ? sel2.value : ''));
              fetch('/sohoa/submit', { method: 'POST', body: window.__answers.join('&') }).then(function() {
                document.getElementById('spa-stage').innerHTML = '<div>Grade 10.00 / 10.00</div>';
              });
            }
          </script>
        </body></html>`);
        return;
      }
      if (path === '/sohoa/submit' && req.method === 'POST') {
        state.spaQuizSubmitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
        return;
      }

      // 10. Mục 7: Multimedia & Interactive (Video gate, Listening VTT, Speaking WAV+getUserMedia, Drag-Drop, Ordering, Matching, Slider)
      if (path === '/media/lesson.vtt') {
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
        res.end('WEBVTT\n\n00:00:01.000 --> 00:00:04.500\nHost: Our annual summit moves to Singapore on Friday.\n');
        return;
      }
      if (path === '/interactive/video-gated') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Video Gate Activity</title></head><body>
          <h1>Xem hết video để mở khóa bài tập</h1>
          <video id="lesson-video" controls width="320" height="180"></video>
          <button type="button" id="unlock-quiz-btn" disabled onclick="location.href='/interactive/multimedia-exam'">Bắt đầu làm bài</button>
          <script>
            document.getElementById('lesson-video').addEventListener('ended', function() {
              document.getElementById('unlock-quiz-btn').disabled = false;
            });
          </script>
        </body></html>`);
        return;
      }
      if (path === '/interactive/multimedia-exam') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Multimedia Interactive Quiz</title></head><body>
          <h1>Bài tập tổng hợp Đa phương tiện & Tương tác</h1>
          <div class="exercise-question" data-question-id="lis1">
            <h3 class="question-title">Listen and select the conference city:</h3>
            <audio controls src="/media/dialog.mp3">
              <track kind="captions" src="/media/lesson.vtt" default>
            </audio>
            <div role="radiogroup" aria-label="Conference city">
              <label><input type="radio" name="city" value="hanoi">Hanoi</label>
              <label><input type="radio" name="city" value="singapore">Singapore</label>
            </div>
          </div>

          <div class="exercise-question" data-question-id="spk1">
            <h3 class="question-title">Record your voice reading the sentence: "Could you repeat that, please?"</h3>
            <button type="button" class="btn-microphone" onclick="startVoiceRec()">Start Microphone</button>
            <button type="button" id="stop-rec-btn" style="display:none" onclick="stopVoiceRec()">Stop recording</button>
            <span id="rec-status"></span>
          </div>

          <div class="exercise-question" data-question-id="dnd1">
            <h3 class="question-title">Kéo thả thủ đô vào đúng quốc gia:</h3>
            <div class="drag-bank">
              <span class="drag-item" draggable="true">Paris</span>
              <span class="drag-item" draggable="true">Tokyo</span>
            </div>
            <div class="drop-zones">
              <div class="dropzone" data-zone="france" aria-label="France"></div>
              <div class="dropzone" data-zone="japan" aria-label="Japan"></div>
            </div>
          </div>

          <div class="exercise-question" data-question-id="ord1">
            <h3 class="question-title">Sắp xếp các từ theo đúng thứ tự câu:</h3>
            <div class="word-bank">
              <span draggable="true">world</span>
              <span draggable="true">Hello</span>
            </div>
          </div>

          <div class="matching-question" id="match1">
            <h3 class="question-title">Nối từ tiếng Anh với nghĩa tiếng Việt tương ứng:</h3>
            <div class="matching-left">
              <button type="button" class="match-left" onclick="window.__pickLeft('Sun')">Sun</button>
              <button type="button" class="match-left" onclick="window.__pickLeft('Moon')">Moon</button>
            </div>
            <div class="matching-right">
              <button type="button" class="match-right" onclick="window.__pickRight('Mặt trăng')">Mặt trăng</button>
              <button type="button" class="match-right" onclick="window.__pickRight('Mặt trời')">Mặt trời</button>
            </div>
          </div>

          <div class="exercise-question" data-question-id="sl1">
            <h3 class="question-title">Chọn mức độ đánh giá (1 đến 5):</h3>
            <input type="range" min="1" max="5" step="1" value="1" name="rating">
          </div>

          <button type="button" id="submit-multimedia" onclick="submitAll()">Nộp bài</button>
          <script>
            window.__spkStreamTracks = 0;
            window.__spkHasRiff = false;
            window.__spkDone = false;
            window.__pendingLeft = null;
            window.__matchedPairs = [];
            async function startVoiceRec() {
              try {
                var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                window.__spkStreamTracks = stream ? stream.getAudioTracks().length : 0;
              } catch (e) {}
              if (window.__atqaLastSynthesizedWav) {
                var hdr = String.fromCharCode.apply(null, Array.from(new Uint8Array(window.__atqaLastSynthesizedWav).slice(0, 4)));
                window.__spkHasRiff = (hdr === 'RIFF');
              }
              document.getElementById('stop-rec-btn').style.display = 'inline-block';
            }
            function stopVoiceRec() {
              window.__spkDone = true;
              document.getElementById('rec-status').textContent = 'Recorded OK';
            }
            window.__pickLeft = function(v) { window.__pendingLeft = v; };
            window.__pickRight = function(v) {
              if (window.__pendingLeft) {
                window.__matchedPairs.push(window.__pendingLeft + '->' + v);
                window.__pendingLeft = null;
              }
            };
            function submitAll() {
              var cityEl = document.querySelector('input[name="city"]:checked');
              var zones = Array.from(document.querySelectorAll('.dropzone')).map(function(z) {
                return z.getAttribute('aria-label') + '=' + z.textContent.trim();
              });
              var ordWords = Array.from(document.querySelectorAll('.word-bank span')).map(function(s) {
                return s.textContent.trim();
              });
              var sliderVal = document.querySelector('input[type="range"]').value;
              var payload = {
                city: cityEl ? cityEl.value : '',
                spkDone: window.__spkDone,
                spkHasRiff: window.__spkHasRiff,
                spkTracks: window.__spkStreamTracks,
                zones: zones,
                order: ordWords,
                matches: window.__matchedPairs.slice().sort(),
                slider: sliderVal
              };
              fetch('/interactive/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              }).then(function() {
                document.body.innerHTML = '<div>Grade 10.00 / 10.00</div>';
              });
            }
          </script>
        </body></html>`);
        return;
      }
      if (path === '/interactive/submit' && req.method === 'POST') {
        state.multimediaSubmitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
        return;
      }

      // 11. Mục 8: Sticky header DOM fill + HTML Page RAG + Hard Math & Checkbox Consistency Round-2 Verification
      if (path === '/mod/page/view.php' && id === '850') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Bài giảng Xung đột & Xác suất</title></head><body>
          <div id="region-main">
            <h2>Phân loại xung đột nhóm</h2>
            <p>Tuân theo (Accommodating): Sẵn sàng để mọi người làm theo cách của họ nếu không bất tiện; để người tự tin hơn làm lãnh đạo.</p>
            <p>Né tránh (Avoiding): Không đưa ra ý kiến để tránh bị phản đối; tránh tiếp xúc người có quan điểm vững vàng.</p>
            <p>Công thức xác suất điều kiện: P(A|B) = P(AB) / P(B).</p>
          </div>
        </body></html>`);
        return;
      }
      if (path === '/course/view.php' && id === '85') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Course 85 Soft Skills + Math</title></head><body>
          <ul><li class="section" id="section-1">
            <h3>Tuần 13: Mâu thuẫn & Xác suất</h3>
            <a href="/mod/page/view.php?id=850">Bài giảng 850</a>
            <a href="/mod/quiz/view.php?id=851">Quiz 851 Kiểm tra nâng cao</a>
          </li></ul>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '851') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><h1>Quiz 851</h1>
          <a href="/mod/quiz/attempt.php?id=851" class="btn btn-primary">Attempt quiz</a>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '851') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Quiz 851 Attempt</title></head><body>
          <div id="sticky-cover" style="position:fixed;top:0;left:0;right:0;height:140px;background:rgba(20,30,60,0.4);z-index:9999;">Sticky Header Covering Radio</div>
          <form method="POST" action="/mod/quiz/finish-851">
            <div class="que multichoice" id="question-851-1">
              <div class="qtext">Khi mâu thuẫn nhóm xảy ra, kiểu phản ứng “Né tránh” có biểu hiện:</div>
              <div class="formulation"><div class="answer">
                <label><input type="checkbox" name="q1_a" value="1">Không đưa ra ý kiến để tránh bị phản đối</label>
                <label><input type="checkbox" name="q1_b" value="1">Sẵn sàng để mọi người làm theo cách của họ nếu không bất tiện</label>
                <label><input type="checkbox" name="q1_c" value="1">Tránh tiếp xúc người có quan điểm vững vàng</label>
              </div></div>
            </div>
            <div class="que multichoice" id="question-851-2">
              <div class="qtext">Khi mâu thuẫn nhóm xảy ra, kiểu phản ứng “Tuân theo” có biểu hiện:</div>
              <div class="formulation"><div class="answer">
                <label><input type="checkbox" name="q2_a" value="1">Sẵn sàng để mọi người làm theo cách của họ nếu không bất tiện</label>
                <label><input type="checkbox" name="q2_b" value="1">Để người tự tin hơn làm lãnh đạo</label>
              </div></div>
            </div>
            <div class="que numerical" id="question-851-3">
              <div class="qtext">Tính xác suất P(A|B) biết P(AB) = 0.3 và P(B) = 0.4:</div>
              <div class="formulation"><input type="text" name="q3_ans" value=""></div>
            </div>
            <div class="que multichoice" id="question-851-4">
              <div class="qtext">Chọn đáp án đúng về tiêu chuẩn kết quả làm việc:</div>
              <div class="formulation">
                <label><input type="radio" name="q4_ans" value="wrong" id="q851_4_w">Thái độ cá nhân</label>
                <label><input type="radio" name="q4_ans" value="right" id="q851_4_r">Tiêu chuẩn về kết quả làm việc</label>
              </div>
            </div>
            <button type="submit">Nộp bài và kết thúc</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/finish-851' && req.method === 'POST') {
        state.quiz851Submitted = (await readRawBody(req)).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><div>Grade 10.00 out of 10.00 (100%)</div></body></html>`);
        return;
      }

      // 12. UPG-9A & 9B: Moodle header search decoy + "Nộp bài..." next-nav -> summary.php -> modal confirm -> review.php, stuck In progress guard, & 45-resource course quiz extraction
      if (path === '/course/search.php') {
        state.quiz861SearchHijacked = true;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Search page</body></html>');
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '861') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>13. Trắc nghiệm Kỹ năng mềm | LMS HUST</title></head><body>
          <h1>13. Trắc nghiệm Kỹ năng mềm</h1>
          <table class="quizattemptsummary"><tbody><tr><td>1</td><td>Finished</td><td>4.00 / 10.00</td></tr></tbody></table>
          <div>Your final grade for this quiz is 4.00/10.00.</div>
          <form method="POST" action="/mod/quiz/startattempt.php">
            <input type="hidden" name="cmid" value="861">
            <button type="submit" class="btn btn-primary">Re-attempt quiz</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/startattempt.php' && req.method === 'POST') {
        res.writeHead(303, { Location: '/mod/quiz/attempt.php?attempt=861&cmid=861' });
        res.end('');
        return;
      }
      if (path === '/mod/quiz/attempt.php' && (reqUrl.searchParams.get('attempt') === '861' || id === '861')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Quiz 861 Attempt</title></head><body>
          <header><form action="/course/search.php"><input name="q" value=""><button type="submit">Tìm kiếm</button></form></header>
          <form id="responseform" method="POST" action="/mod/quiz/processattempt.php">
            <div class="que multichoice" id="question-861-1">
              <div class="qtext">Chọn nguyên tắc giải quyết mâu thuẫn win-win:</div>
              <div class="formulation"><div class="answer">
                <label><input type="radio" name="q861_1" value="0">Né tránh</label>
                <label><input type="radio" name="q861_1" value="1">Cộng tác</label>
              </div></div>
            </div>
            <div class="submitbtns">
              <input type="submit" name="next" value="Nộp bài ..." class="mod_quiz-next-nav btn btn-primary">
            </div>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/processattempt.php' && req.method === 'POST') {
        const body = (await readRawBody(req)).toString('utf8');
        if (body.includes('finish861=1')) {
          state.quiz861Submitted = body;
          res.writeHead(303, { Location: '/mod/quiz/review.php?attempt=861&cmid=861' });
          res.end('');
          return;
        }
        res.writeHead(303, { Location: '/mod/quiz/summary.php?attempt=861&cmid=861' });
        res.end('');
        return;
      }
      if (path === '/mod/quiz/summary.php' && reqUrl.searchParams.get('attempt') === '861') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Tóm tắt lần làm bài</title></head><body>
          <header><form action="/course/search.php"><button type="submit">Tìm kiếm</button></form></header>
          <div>Trạng thái: In progress (Đang tiến hành)</div>
          <button type="button" id="open-confirm-861" onclick="document.getElementById('confirm-modal-861').style.display='block'">Nộp bài và kết thúc</button>
          <div id="confirm-modal-861" class="modal show" role="dialog" style="display:none">
            <div class="modal-dialog">
              <form method="POST" action="/mod/quiz/processattempt.php">
                <input type="hidden" name="finish861" value="1">
                <button type="submit" class="btn btn-primary">Submit all and finish</button>
              </form>
            </div>
          </div>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/review.php' && reqUrl.searchParams.get('attempt') === '861') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Review Quiz 861</title></head><body>
          <table class="quizreviewsummary"><tbody>
            <tr><th>State</th><td>Finished</td></tr>
            <tr><th>Grade</th><td>9.00 out of 10.00 (90%)</td></tr>
          </tbody></table>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '862') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Stuck Quiz 862</title></head><body>
          <div>Trạng thái: In progress</div>
          <form id="responseform" method="GET" action="/mod/quiz/attempt.php?id=862">
            <div class="que multichoice" id="question-862-1">
              <div class="qtext">Câu 1 kẹt không chuyển trang?</div>
              <div class="formulation"><div class="answer">
                <label><input type="radio" name="q862_1" value="1">Đúng</label>
              </div></div>
            </div>
            <button type="submit">Nộp bài và kết thúc</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/course/view.php' && id === '86') {
        const noise = Array.from({ length: 45 }, (_, i) =>
          `<li><a href="/mod/${i % 2 === 0 ? 'page' : 'forum'}/view.php?id=${9000 + i}">Tài liệu/Thông báo #${i + 1}</a></li>`
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>BL-MI2020 Xác suất thống kê</title></head><body>
          <ul class="topics">
            ${noise}
            <li class="activity quiz"><a href="/mod/quiz/view.php?id=871">Quiz 1 Tuần 9 (Đã xong 10đ)</a></li>
            <li class="activity quiz"><a href="/mod/quiz/view.php?id=872">Quiz 2 Chương 3 (Chưa làm)</a></li>
            <li class="activity quiz"><a href="/mod/quiz/view.php?id=873">Quiz 3 Chương 4 (In progress)</a></li>
          </ul>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '871') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Quiz 1</h1><table class="quizattemptsummary"><tr><td>1</td><td>Finished</td><td>10.00 / 10.00</td></tr></table><div>Your final grade for this quiz is 10.00/10.00.</div></body></html>');
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '872') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Quiz 2 Chương 3</h1><button type="button">Attempt quiz</button></body></html>');
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '873') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Quiz 3 Chương 4</h1><div>Trạng thái: In progress</div><button type="button">Continue your attempt</button></body></html>');
        return;
      }

      // 13. UPG-10: Auto Score-Retry loop when observed score < 8 (< maxGradeToReattempt)
      if (path === '/mod/quiz/view.php' && id === '881') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (state.quiz881Round === 0) {
          res.end(`<!doctype html><html><head><title>Quiz 881</title></head><body>
            <table class="quizattemptsummary"><tr><td>1</td><td>Finished</td><td>4.00 / 10.00</td><td><a href="/mod/quiz/review.php?attempt=8810">Review</a></td></tr></table>
            <div>Your final grade for this quiz is 4.00/10.00.</div>
            <form method="GET" action="/mod/quiz/attempt.php"><input type="hidden" name="id" value="881"><button type="submit">Re-attempt quiz</button></form>
          </body></html>`);
        } else if (state.quiz881Round === 1) {
          res.end(`<!doctype html><html><head><title>Quiz 881</title></head><body>
            <table class="quizattemptsummary"><tr><td>2</td><td>Finished</td><td>6.00 / 10.00</td><td><a href="/mod/quiz/review.php?attempt=8811">Review</a></td></tr></table>
            <div>Your final grade for this quiz is 6.00/10.00.</div>
            <form method="GET" action="/mod/quiz/attempt.php"><input type="hidden" name="id" value="881"><button type="submit">Re-attempt quiz</button></form>
          </body></html>`);
        } else {
          res.end(`<!doctype html><html><head><title>Quiz 881</title></head><body>
            <table class="quizattemptsummary"><tr><td>3</td><td>Finished</td><td>10.00 / 10.00</td></tr></table>
            <div>Your final grade for this quiz is 10.00/10.00.</div>
          </body></html>`);
        }
        return;
      }
      if (path === '/mod/quiz/review.php' && reqUrl.searchParams.get('attempt') === '8811') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div class="que"><div class="qtext">Thủ đô Việt Nam?</div><div class="rightanswer">The correct answer is: Hà Nội</div></div></body></html>');
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '881') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Attempt 881</title></head><body>
          <form method="POST" action="/mod/quiz/finish-881">
            <div class="que multichoice" id="question-881-1">
              <div class="qtext">Thủ đô Việt Nam?</div>
              <div class="formulation"><div class="answer">
                <label><input type="radio" name="q881_1" value="hcm">TP.HCM</label>
                <label><input type="radio" name="q881_1" value="hn">Hà Nội</label>
              </div></div>
            </div>
            <button type="submit">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/finish-881' && req.method === 'POST') {
        const body = (await readRawBody(req)).toString('utf8');
        state.quiz881Round += 1;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (body.includes('q881_1=hn')) {
          res.end('<html><body><div>Grade 10.00 out of 10.00 (100%)</div></body></html>');
        } else {
          res.end('<html><body><div>Grade 6.00 out of 10.00 (60%)</div></body></html>');
        }
        return;
      }

      // 14. UPG-11: Moodle 4 resource wrapper RAG, multi-page review pagination + Vietnamese partial state + aria-labelledby + single-Q checkbox Round-2 + batch score retry
      if (path === '/course/view.php' && id === '89') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>BL-ED3220 - Kỹ năng mềm</title></head><body>
          <h1>BL-ED3220 - Kỹ năng mềm</h1>
          <ul>
            <li class="section main" id="section-14"><h3 class="sectionname">Tuần 14: Đánh giá nhóm</h3><ul>
              <li class="activity modtype_resource activity-item">
                <div class="instancename"><a href="/mod/resource/view.php?id=890">4.3. Bài giảng Đánh giá nhóm</a></div>
              </li>
              <li class="activity modtype_quiz activity-item">
                <div class="instancename"><a href="/mod/quiz/view.php?id=891">14.TRẮC NGHIỆM "Đánh giá nhóm"</a></div>
                <div data-region="completion-info"><span class="badge bg-success">Done: Make attempts</span></div>
              </li>
            </ul></li>
          </ul>
        </body></html>`);
        return;
      }
      if (path === '/mod/resource/view.php' && id === '890') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><div class="resourceworkaround">Nhấp vào liên kết <a href="/pluginfile.php/890/slide.txt">slide.txt</a> để xem tệp.</div></body></html>');
        return;
      }
      if (path === '/pluginfile.php/890/slide.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('TAI LIEU ED3220: Muc dich danh gia nhom khong bao gom Tao co hoi thich nghi; Van de can quan tam gom Phuong phap, Chu trinh, Nguoi chiu trach nhiem (khong gom dao tao sau danh gia).');
        return;
      }
      if (path === '/mod/quiz/view.php' && id === '891') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (state.quiz891Round === 0) {
          res.end(`<!doctype html><html><head><title>14.TRẮC NGHIỆM "Đánh giá nhóm"</title></head><body>
            <table class="quizattemptsummary"><tr><td>1</td><td>Finished</td><td>4.00 / 10.00</td><td><a href="/mod/quiz/review.php?attempt=8910">Review</a></td></tr></table>
            <div>Your final grade for this quiz is 4.00/10.00.</div>
            <form method="GET" action="/mod/quiz/attempt.php"><input type="hidden" name="id" value="891"><button type="submit">Re-attempt quiz</button></form>
          </body></html>`);
        } else {
          const scoreNow = state.quiz891Round === 1 ? '4.00' : '10.00';
          res.end(`<!doctype html><html><head><title>14.TRẮC NGHIỆM "Đánh giá nhóm"</title></head><body>
            <table class="quizattemptsummary"><tr><td>2</td><td>Finished</td><td>${scoreNow} / 10.00</td><td><a href="/mod/quiz/review.php?attempt=8911">Review</a></td></tr></table>
            <div>Your final grade for this quiz is ${scoreNow}/10.00.</div>
            ${state.quiz891Round === 1 ? '<form method="GET" action="/mod/quiz/attempt.php"><input type="hidden" name="id" value="891"><button type="submit">Re-attempt quiz</button></form>' : ''}
          </body></html>`);
        }
        return;
      }
      if (path === '/mod/quiz/review.php' && (reqUrl.searchParams.get('attempt') === '8910' || reqUrl.searchParams.get('attempt') === '8911')) {
        const revPage = reqUrl.searchParams.get('page') || '0';
        const att = reqUrl.searchParams.get('attempt')!;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (revPage === '0') {
          res.end(`<!doctype html><html><body>
            <table class="quizreviewsummary"><tr><th>Grade</th><td>4.00 out of 10.00 (40%)</td></tr></table>
            <div class="qn_buttons"><a class="qnbutton" href="/mod/quiz/review.php?attempt=${att}&page=0">1</a><a class="qnbutton" href="/mod/quiz/review.php?attempt=${att}&page=1">2</a></div>
            <div class="que multichoice deferredfeedback" id="question-891-1">
              <div class="info"><div class="state">Đúng một phần</div><div class="grade">Mark 1.25 out of 5.00</div></div>
              <div class="content"><div class="qtext">Khi đánh giá nhóm, các vấn đề cần quan tâm là:</div>
                <div class="answer">
                  <div class="r0"><input type="checkbox" checked="checked" aria-labelledby="rev_q1_lbl0" value="1"/><div id="rev_q1_lbl0">A. Phương pháp đánh giá</div></div>
                  <div class="r1"><input type="checkbox" checked="checked" aria-labelledby="rev_q1_lbl1" value="1"/><div id="rev_q1_lbl1">A. Ai chịu trách nhiệm đánh giá</div></div>
                  <div class="r0"><input type="checkbox" checked="checked" aria-labelledby="rev_q1_lbl2" value="1"/><div id="rev_q1_lbl2">A. Chu trình đánh giá</div></div>
                  <div class="r1"><input type="checkbox" checked="checked" aria-labelledby="rev_q1_lbl3" value="1"/><div id="rev_q1_lbl3">A. Kĩ năng cần đào tạo sau đánh giá</div></div>
                </div>
              </div>
            </div>
          </body></html>`);
        } else {
          res.end(`<!doctype html><html><body>
            <div class="qn_buttons"><a class="qnbutton" href="/mod/quiz/review.php?attempt=${att}&page=0">1</a><a class="qnbutton" href="/mod/quiz/review.php?attempt=${att}&page=1">2</a></div>
            <div class="que multichoice deferredfeedback complete" id="question-891-2">
              <div class="info"><div class="state">Đã hoàn thành</div></div>
              <div class="content"><div class="qtext">Mục đích của đánh giá nhóm:</div>
                <div class="answer">
                  <div class="r0"><input type="checkbox" checked="checked" aria-labelledby="rev_q2_lbl0" value="1"/><div id="rev_q2_lbl0">Giúp các thành viên hiểu nhau hơn</div></div>
                  <div class="r1"><input type="checkbox" checked="checked" aria-labelledby="rev_q2_lbl1" value="1"/><div id="rev_q2_lbl1">Thấy được ưu điểm (nhược điểm)</div></div>
                  <div class="r0"><input type="checkbox" checked="checked" aria-labelledby="rev_q2_lbl2" value="1"/><div id="rev_q2_lbl2">Thấy được kiến thức, kỹ năng, thái độ</div></div>
                  <div class="r1"><input type="checkbox" checked="checked" aria-labelledby="rev_q2_lbl3" value="1"/><div id="rev_q2_lbl3">Tạo cơ hội thích nghi</div></div>
                </div>
              </div>
            </div>
          </body></html>`);
        }
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '891') {
        const pg = reqUrl.searchParams.get('page') || '0';
        if (req.method === 'POST' && pg === '1') {
          state.quiz891LastQ1 = (await readRawBody(req)).toString('utf8');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (pg === '0') {
          res.end(`<!doctype html><html><head><title>14.TRẮC NGHIỆM "Đánh giá nhóm"</title></head><body>
            <form id="responseform" method="POST" action="/mod/quiz/attempt.php?id=891&page=1">
              <div class="que multichoice deferredfeedback" id="question-891-1">
                <div class="content"><div class="qtext">Khi đánh giá nhóm, các vấn đề cần quan tâm là:</div>
                  <div class="answer">
                    <div class="r0"><input type="checkbox" id="q891_1_c0" aria-labelledby="q891_1_l0" name="q891_1_c0" value="1"/><div id="q891_1_l0">A. Phương pháp đánh giá</div></div>
                    <div class="r1"><input type="checkbox" id="q891_1_c1" aria-labelledby="q891_1_l1" name="q891_1_c1" value="1"/><div id="q891_1_l1">A. Ai chịu trách nhiệm đánh giá</div></div>
                    <div class="r0"><input type="checkbox" id="q891_1_c2" aria-labelledby="q891_1_l2" name="q891_1_c2" value="1"/><div id="q891_1_l2">A. Chu trình đánh giá</div></div>
                    <div class="r1"><input type="checkbox" id="q891_1_c3" aria-labelledby="q891_1_l3" name="q891_1_c3" value="1"/><div id="q891_1_l3">A. Kĩ năng cần đào tạo sau đánh giá</div></div>
                  </div>
                </div>
              </div>
              <input type="submit" class="mod_quiz-next-nav" name="next" value="Next page" />
            </form>
          </body></html>`);
        } else {
          res.end(`<!doctype html><html><head><title>14.TRẮC NGHIỆM "Đánh giá nhóm"</title></head><body>
            <form id="responseform" method="POST" action="/mod/quiz/finish-891">
              <div class="que multichoice deferredfeedback" id="question-891-2">
                <div class="content"><div class="qtext">Mục đích của đánh giá nhóm:</div>
                  <div class="answer">
                    <div class="r0"><input type="checkbox" id="q891_2_c0" aria-labelledby="q891_2_l0" name="q891_2_c0" value="1"/><div id="q891_2_l0">Giúp các thành viên hiểu nhau hơn</div></div>
                    <div class="r1"><input type="checkbox" id="q891_2_c1" aria-labelledby="q891_2_l1" name="q891_2_c1" value="1"/><div id="q891_2_l1">Thấy được ưu điểm (nhược điểm)</div></div>
                    <div class="r0"><input type="checkbox" id="q891_2_c2" aria-labelledby="q891_2_l2" name="q891_2_c2" value="1"/><div id="q891_2_l2">Thấy được kiến thức, kỹ năng, thái độ</div></div>
                    <div class="r1"><input type="checkbox" id="q891_2_c3" aria-labelledby="q891_2_l3" name="q891_2_c3" value="1"/><div id="q891_2_l3">Tạo cơ hội thích nghi</div></div>
                  </div>
                </div>
              </div>
              <button type="submit" name="finishattempt">Submit all and finish</button>
            </form>
          </body></html>`);
        }
        return;
      }
      if (path === '/mod/quiz/finish-891' && req.method === 'POST') {
        state.quiz891LastQ2 = (await readRawBody(req)).toString('utf8');
        state.quiz891Round += 1;
        const q1Ok = state.quiz891LastQ1.includes('q891_1_c0=1') && state.quiz891LastQ1.includes('q891_1_c1=1') && state.quiz891LastQ1.includes('q891_1_c2=1') && !state.quiz891LastQ1.includes('q891_1_c3=1');
        const q2Ok = state.quiz891LastQ2.includes('q891_2_c0=1') && state.quiz891LastQ2.includes('q891_2_c1=1') && state.quiz891LastQ2.includes('q891_2_c2=1') && !state.quiz891LastQ2.includes('q891_2_c3=1');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (q1Ok && q2Ok) {
          res.end('<html><body><div>Grade 10.00 out of 10.00 (100%)</div></body></html>');
        } else {
          res.end('<html><body><div>Grade 4.00 out of 10.00 (40%)</div></body></html>');
        }
        return;
      }

      // 15. UPG-12: Moodle 4.4 multi-attempt cards (Attempt 1=4.00, Attempt 2=10.00), hidden 0.00/Time limit headings, & re-attempt stop gate
      if (path === '/mod/quiz/view.php' && id === '892') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const attempt2Card = state.quiz892Round >= 1
          ? `<table class="generaltable quizattemptsummary"><tbody>
              <tr><th>Attempt</th><td>2</td></tr>
              <tr><th>State</th><td>Finished</td></tr>
              <tr><th>Marks</th><td>4.00 / 4.00</td></tr>
              <tr><th>Grade</th><td>10.00 out of 10.00 (100%)</td></tr>
            </tbody></table>`
          : '';
        res.end(`<!doctype html><html><head><title>Quiz 892 - Multi Attempt Cards</title></head><body>
          <h1>14.TRẮC NGHIỆM "Đánh giá nhóm"</h1>
          <h3 style="display:none">Highest grade: 0.00 / 10.00.</h3>
          <div class="modal" style="display:none"><h3>Time limit</h3></div>
          <p>Grade to pass: 5.00 out of 10.00</p>
          <p>Grading method: Highest grade</p>
          <form method="GET" action="/mod/quiz/attempt.php"><input type="hidden" name="id" value="892"><button type="submit">Re-attempt quiz</button></form>
          <h3>Your attempts</h3>
          <table class="generaltable quizattemptsummary"><tbody>
            <tr><th>Attempt</th><td>1</td></tr>
            <tr><th>State</th><td>Finished</td></tr>
            <tr><th>Marks</th><td>1.60 / 4.00</td></tr>
            <tr><th>Grade</th><td>4.00 out of 10.00 (40%)</td></tr>
          </tbody></table>
          ${attempt2Card}
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/attempt.php' && id === '892') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Attempt 892</title></head><body>
          <form id="responseform" method="POST" action="/mod/quiz/finish-892">
            <div class="que multichoice deferredfeedback" id="question-892-1">
              <div class="content"><div class="qtext">Câu 892 test?</div>
                <div class="answer">
                  <div class="r0"><input type="radio" id="q892_a" name="q892" value="0"/><label for="q892_a">Sai</label></div>
                  <div class="r1"><input type="radio" id="q892_b" name="q892" value="1"/><label for="q892_b">Đúng</label></div>
                </div>
              </div>
            </div>
            <button type="submit" name="finishattempt">Submit all and finish</button>
          </form>
        </body></html>`);
        return;
      }
      if (path === '/mod/quiz/finish-892' && req.method === 'POST') {
        await readRawBody(req);
        state.quiz892Round += 1;
        res.writeHead(302, { Location: '/mod/quiz/view.php?id=892' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch({ headless: true });
  });

  test.after(async () => {
    ModelRouter.execute = realExecute;
    await browser?.close().catch(() => {});
    await new Promise<void>(resolve => srv?.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('UPG-1A: Review-guided Re-attempt reads review.php feedback & rightanswer', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const capturedPrompts: string[] = [];

    ModelRouter.execute = async (req: any) => {
      capturedPrompts.push(String(req.text || ''));
      return mockRouterRes(JSON.stringify({
        answers: [{ id: '1', selected: ['Hà Nội'], confidence: 'high', reason: 'Theo review' }]
      }), 'mock-solver');
    };

    try {
      const ctx = makeCtx({ allowReattempt: true });
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/mod/quiz/view.php?id=701`, { waitUntil: 'domcontentloaded' });
      const res = await executeQuizSolve(page, ctx, { allowReattempt: true, autoSubmit: true });
      assert.equal(res.success, true);
      assert.ok(capturedPrompts.some(p => p.includes('previousAttemptReview') && p.includes('Hà Nội')));
      assert.match(decodeURIComponent(state.quiz701Submitted), /q1_ans=1/);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-1B: Course Material RAG (TXT slide) & Visual 2nd-opinion pass with imageBase64', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const calls: any[] = [];

    ModelRouter.execute = async (req: any, opts: any) => {
      calls.push({ req, opts });
      const txt = String(req.text || '');
      const payload = JSON.parse(txt);
      if (calls.length === 1) {
        assert.ok(txt.includes('XRAY-9988'), 'Solver must receive RAG slide content XRAY-9988');
        const q1 = payload.questions[0];
        return mockRouterRes(JSON.stringify({
          answers: [{ id: q1.id, text: 'XRAY-9988', confidence: 0.95 }]
        }), 'mock-solver-text');
      }
      if (calls.length === 2) {
        const q2 = payload.questions[0];
        return mockRouterRes(JSON.stringify({
          answers: [{ id: q2.id, selected: [q2.options[0].id], confidence: 0.72 }]
        }), 'mock-solver-vision');
      }
      // 2nd pass verifier call
      assert.equal(opts.requiresVision, true);
      assert.ok(req.imageBase64 && req.imageBase64.length > 20, '2nd pass must attach visual question imageBase64');
      const vq = payload.questionsToVerify[0];
      const greenOpt = vq.options.find((o: any) => o.text === 'Xanh') || vq.options[1];
      return mockRouterRes(JSON.stringify({
        answers: [{ id: vq.id, selected: [greenOpt.id], confidence: 0.96, reason: 'Nhìn ảnh rõ hơn' }]
      }), 'mock-verifier');
    };

    try {
      const ctx = makeCtx({ solveAll: false });
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/course/view.php?id=80`, { waitUntil: 'domcontentloaded' });
      const res = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(res.success, true);
      assert.equal(calls.length, 3);
      const body = decodeURIComponent(state.quiz801Submitted);
      assert.ok(body.includes('XRAY-9988'));
      assert.ok(body.includes('q801_2=1'));
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-1C: Advanced Moodle ordering adapter works via quiz.solve', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const q = payload.questions[0];
      const step1 = q.options.find((o: any) => o.text.includes('Bước 1'));
      const step2 = q.options.find((o: any) => o.text.includes('Bước 2'));
      return mockRouterRes(JSON.stringify({
        answers: [{ id: q.id, selected: [step1.id, step2.id], confidence: 0.96 }]
      }), 'mock-solver');
    };

    try {
      const ctx = makeCtx();
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=802`, { waitUntil: 'domcontentloaded' });
      const res = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(res.success, true);
      assert.ok(decodeURIComponent(state.quiz802Submitted).includes('item_a,item_b'));
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-2A & 2B: Handwriting synthesis from user sample + extractLocalDocumentText + prompt parser', async () => {
    // Generate synthetic user handwriting sample image via Python Pillow
    const sampleImg = join(tempDir, 'user-handwriting-sample.png');
    const mkSample = spawnSync(
      'python',
      [
        '-c',
        [
          'from PIL import Image, ImageDraw',
          'img = Image.new("RGB", (240, 100), (255, 255, 255))',
          'd = ImageDraw.Draw(img)',
          'd.line([(20, 40), (90, 36), (160, 42), (220, 38)], fill=(18, 42, 130), width=4)',
          'd.line([(30, 72), (100, 78), (190, 70)], fill=(18, 42, 130), width=4)',
          `img.save(r"${sampleImg}")`
        ].join('; ')
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(mkSample.status, 0, mkSample.stderr);

    const outPdf = join(tempDir, 'hw-out.pdf');
    const outPng = join(tempDir, 'hw-out.png');
    const outDocx = join(tempDir, 'hw-out.docx');
    const sampleText = '# Đề bài mẫu\nSinh viên Việt Nam học tập sáng tạo ăđơưệử.';

    const rPdf = await HandwritingGenerator.generate({
      title: 'Bai viet tay',
      content: sampleText,
      format: 'pdf',
      outputPath: outPdf,
      samplePath: sampleImg,
      studentHeader: 'Nguyễn Văn A - 20230001'
    });
    assert.equal(rPdf.success, true);
    assert.equal(rPdf.sampleAnalyzed, true);
    assert.equal((await readFileMagic(outPdf)).slice(0, 5), '%PDF-');

    const rPng = await HandwritingGenerator.generate({
      title: 'Bai viet tay PNG',
      content: sampleText,
      format: 'png',
      outputPath: outPng,
      samplePath: sampleImg
    });
    assert.equal(rPng.success, true);
    const pngInfo = await stat(outPng);
    assert.ok(pngInfo.size > 5000);

    const rDocx = await HandwritingGenerator.generate({
      title: 'Bai viet tay DOCX',
      content: sampleText,
      format: 'docx',
      outputPath: outDocx,
      samplePath: sampleImg
    });
    assert.equal(rDocx.success, true);
    assert.equal((await readFileMagic(outDocx)).slice(0, 2), 'PK');

    // Also test extractLocalDocumentText on txt + docx + pdf + security block on .private
    const txtPath = join(tempDir, 'ref.txt');
    await writeFile(txtPath, 'Nội dung tham khảo tiếng Việt ABC-777', 'utf8');
    const docOut = await createDocument({
      title: 'Tiêu đề test',
      content: '# Phần 1\nVăn bản từ DOCX',
      format: 'docx',
      baseName: 'v12-ref-test'
    });
    const docxPath = docOut.path;

    const pdfTextOut = await createDocument({
      title: 'PDF Test',
      content: 'PDF-EXTRACT-OK-777',
      format: 'pdf',
      baseName: 'v12-pdf-test'
    });
    const textPdfPath = pdfTextOut.path;

    try {
      assert.ok((await extractLocalDocumentText(txtPath)).includes('ABC-777'));
      assert.ok((await extractLocalDocumentText(docxPath)).includes('Văn bản từ DOCX'));
      assert.ok((await extractLocalDocumentText(textPdfPath)).includes('PDF-EXTRACT-OK-777'));
      await assert.rejects(() => extractLocalDocumentText('.private/playbooks.json'), /Sensitive path segment/i);
    } finally {
      if (existsSync(docxPath)) await unlink(docxPath).catch(() => {});
      if (existsSync(textPdfPath)) await unlink(textPdfPath).catch(() => {});
    }

    // Test Python helper word_worker.insert_markdown_table_into_word with mock Word COM objects
    const pyHelperScript = [
      'import sys; from types import SimpleNamespace; sys.path.insert(0, "desktop"); import word_worker',
      'cells = {}',
      'class FakeTable:',
      '    def __init__(self): self.Borders = SimpleNamespace(Enable=False); self.Range = SimpleNamespace(End=10)',
      '    def Cell(self, r, c): cells.setdefault((r, c), SimpleNamespace(Range=SimpleNamespace(Text="", Font=SimpleNamespace(Name="", Size=0, Bold=False)))); return cells[(r, c)]',
      'doc = SimpleNamespace(Tables=SimpleNamespace(Add=lambda rng, r, c: FakeTable()), Range=lambda a, b: SimpleNamespace(Select=lambda: None))',
      'sel = SimpleNamespace(Range=object(), TypeParagraph=lambda: None)',
      'word_worker.insert_markdown_table_into_word(doc, sel, ["| **Cột 1** | Cột 2 |", "| --- | --- |", "| A | B |"])',
      'assert cells[(1,1)].Range.Text == "Cột 1" and cells[(1,1)].Range.Font.Bold is True',
      'assert cells[(2,1)].Range.Text == "A" and cells[(2,2)].Range.Text == "B" and cells[(2,1)].Range.Font.Bold is False',
      'assert word_worker.normalize_inline_markdown("`code` **bold**") == "code bold"',
    ].join('\n');
    const pyHelperCheck = spawnSync('python', ['-c', pyHelperScript], { encoding: 'utf8', timeout: 8000 });
    assert.equal(pyHelperCheck.status, 0, pyHelperCheck.stderr);

    // Upload generated handwritten PDF inside Assignment 803
    const context = await browser.newContext();
    const page = await context.newPage();
    let generatedArtifactPath: string | undefined;
    ModelRouter.execute = async () => mockRouterRes(JSON.stringify({
      fileTitle: 'Bai_Tap_Viet_Tay_803',
      fileContent: '# Câu trả lời\nNội dung chữ viết tay thử nghiệm có dấu tiếng Việt đầy đủ.'
    }), 'mock-writer');

    try {
      const ctx = makeCtx({ handwritingMode: true, handwritingSamplePath: sampleImg, documentFormat: 'pdf' });
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/mod/assign/view.php?id=803`, { waitUntil: 'domcontentloaded' });
      const res = await executeAssignmentSubmit(page, ctx, {
        autoSubmit: true,
        handwritingMode: true,
        handwritingSamplePath: sampleImg,
        documentFormat: 'pdf',
        useWordApp: false
      });
      assert.equal(res.success, true);
      generatedArtifactPath = res.data?.uploadedFile;
      assert.equal(res.data?.handwritten, true);
      assert.equal(state.assign803Submitted, true);
      assert.equal(state.assign803UploadedMagic, 'PDF');
      assert.ok(state.assign803UploadedName.endsWith('.pdf'));
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
      if (generatedArtifactPath && existsSync(generatedArtifactPath)) {
        await unlink(generatedArtifactPath).catch(() => {});
      }
    }

    // Prompt extraction check for Mục 2 & Mục 3 natural language
    const parsed = extractCredentialsAndUrlFromPrompt(
      'Vào LMS làm hết quiz ở cả môn ED3220 và IT3040 chạy song song 3 luồng, phần tự luận viết chữ viết tay theo mẫu chữ C:\\Users\\sample\\my_hand.png, header: "SV Nguyen - 2023"'
    );
    assert.deepEqual(parsed.targetCourses, ['ED3220', 'IT3040']);
    assert.equal(parsed.parallel, true);
    assert.equal(parsed.concurrency, 3);
    assert.equal(parsed.handwritingMode, true);
    assert.equal(parsed.handwritingSamplePath, 'C:\\Users\\sample\\my_hand.png');
    assert.equal(parsed.attachmentPath, undefined);
    assert.equal(parsed.studentHeader, 'SV Nguyen - 2023');
  });

  test('UPG-3A: browser.download + text extraction & Google Forms Next/Submit', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let downloadedPath: string | undefined;

    ModelRouter.execute = async (req: any) => {
      const txt = String(req.text || '');
      const payload = JSON.parse(txt);
      const q = payload.questions[0];
      if (txt.includes('trang 1')) {
        const rightOpt = q.options.find((o: any) => o.text === 'Đúng') || q.options[1];
        return mockRouterRes(JSON.stringify({ answers: [{ id: q.id, selected: [rightOpt.id], confidence: 0.96 }] }), 'mock-gf');
      }
      return mockRouterRes(JSON.stringify({ answers: [{ id: q.id, text: 'Ghi chú OK trang 2', confidence: 0.96 }] }), 'mock-gf');
    };

    try {
      const ctx = makeCtx();
      ctx.context = context;
      ctx.page = page;

      await page.goto(`${baseUrl}/course/view.php?id=80`, { waitUntil: 'domcontentloaded' });
      const dlRes = await executeAgentTool({
        tool: 'browser.download',
        args: { url: '/slides/note80.txt' }
      }, ctx);
      assert.equal(dlRes.success, true);
      downloadedPath = dlRes.data?.path;
      assert.ok(downloadedPath && existsSync(downloadedPath));
      assert.ok(String(dlRes.data?.extractedText || '').includes('XRAY-9988'));

      // Google Forms 2-page flow
      await page.goto(`${baseUrl}/forms/d/e/test/viewform`, { waitUntil: 'domcontentloaded' });
      const gfRes = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(gfRes.success, true);
      const decodedGform = decodeURIComponent(state.gformPage2Submitted.replace(/\+/g, ' '));
      assert.ok(decodedGform.includes('Ghi chú OK trang 2'), `Expected Google Form POST payload to include note, got: ${decodedGform}`);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
      if (downloadedPath && existsSync(downloadedPath)) {
        await unlink(downloadedPath).catch(() => {});
      }
    }
  });

  test('UPG-3B: Parallel multi-quiz & parallel multi-course execution leave zero leaked tabs', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    ModelRouter.execute = async () => mockRouterRes(JSON.stringify({
      answers: [{ id: '1', selected: ['Đáp án A'], confidence: 'high' }]
    }), 'mock-parallel');

    try {
      const ctx = makeCtx({ solveAll: true, parallel: true, concurrency: 3 });
      ctx.context = context;
      ctx.page = page;

      // Parallel multi-quiz on course 90
      await page.goto(`${baseUrl}/course/view.php?id=90`, { waitUntil: 'domcontentloaded' });
      const multiQuizRes = await executeQuizSolve(page, ctx, { solveAll: true, parallel: true, concurrency: 3 });
      assert.equal(multiQuizRes.success, true);
      assert.equal(multiQuizRes.data?.solvedCount, 3);
      assert.equal(state.parallelQuizHits.length, 3);
      assert.equal(context.pages().length, 1, 'No leaked tabs after parallel quizzes');
      assert.equal(ctx.page, page);

      // Parallel multi-course on /my/ dashboard
      await page.goto(`${baseUrl}/my/`, { waitUntil: 'domcontentloaded' });
      const multiCourseRes = await executeQuizSolve(page, ctx, {
        targetCourses: ['ED3220', 'IT3040'],
        parallel: true,
        concurrency: 2,
        solveAll: true
      });
      assert.equal(multiCourseRes.success, true);
      assert.equal(multiCourseRes.data?.parallelCourses, true);
      assert.equal(multiCourseRes.data?.solvedCount, 2);
      assert.equal(state.parallelCourseHits.length, 2);
      assert.equal(context.pages().length, 1, 'No leaked tabs after parallel courses');
      assert.equal(ctx.page, page);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-4: API Key provider detection, model scanner & planner role routing', async () => {
    assert.equal(detectProviderFromApiKey('AIzaSyD1234567890abcdefghijklmnopq'), 'gemini');
    assert.equal(detectProviderFromApiKey('gsk_1234567890abcdefghijklmnopqrstuv'), 'groq');
    assert.equal(detectProviderFromApiKey('sk-ant-api03-1234567890abcdefghijklmnop'), 'anthropic');
    assert.equal(detectProviderFromApiKey('sk-proj-1234567890abcdefghijklmnopqrstuv'), 'openai');
    assert.equal(detectProviderFromApiKey('not-a-key'), undefined);

    const ctx = makeCtx();
    const fakeKey = 'AIzaSyTestFakeKey1234567890abcdefgh';
    const tempDbPath = join(tempDir, 'temp-model-profiles.json');
    let savedKeyArg: { profileId: string; apiKey: string } | undefined;

    const rlChoices = ['2'];
    const mockRl = {
      question: async () => rlChoices.shift() || ''
    };

    const scanRes = await scanAndSelectModelFromApiKey(fakeKey, ctx, mockRl, {
      dbPath: tempDbPath,
      setKeyFn: (profileId, apiKey) => {
        savedKeyArg = { profileId, apiKey };
      },
      fetchModelsFn: async (provider) => ({
        source: 'API_LIVE',
        models: [
          {
            id: 'gemini-3-flash-preview',
            provider,
            capabilities: { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'] },
            isVerified: true,
            capabilitySource: 'VERIFIED'
          },
          {
            id: 'gemini-3.5-flash-lite',
            provider,
            capabilities: { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'] },
            isVerified: true,
            capabilitySource: 'VERIFIED'
          }
        ]
      })
    });

    assert.equal(scanRes.cancelled, false);
    assert.equal(scanRes.provider, 'gemini');
    assert.equal(scanRes.modelOverride, 'gemini-3.5-flash-lite');
    assert.equal(ctx.config.modelOverride, 'gemini-3.5-flash-lite');
    assert.equal(savedKeyArg?.apiKey, fakeKey);

    // Role-based routing check: planner prefers flash-lite when expanding pool vs solver prefers stronger flash
    const testDb: ModelProfilesDb = {
      default: 'g_main',
      profiles: {
        g_main: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3-flash-preview',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: []
    };

    const plannerPlan = await ModelRouter.resolveCandidates({
      db: testDb,
      expandModelPool: true,
      taskRole: 'planner',
      preferAccuracy: false
    });
    assert.ok(plannerPlan.primary.model.includes('flash-lite'), `Expected flash-lite for planner, got ${plannerPlan.primary.model}`);

    const solverPlan = await ModelRouter.resolveCandidates({
      db: testDb,
      expandModelPool: true,
      taskRole: 'solver',
      preferAccuracy: true
    });
    assert.ok(!solverPlan.primary.model.includes('flash-lite'), `Expected strong non-lite flash for solver, got ${solverPlan.primary.model}`);
  });

  test('UPG-5: Real-time clock in prompts, Opened-only filtering & upcoming vs expired deadline ranking', async () => {
    // 1. Opened-only date must return null; Opened + Closed returns closing date
    assert.equal(parseDeadline('Opened: Monday, 7 September 2026, 12:00 AM', '+07:00'), null);
    assert.equal(parseDeadline('Mở vào: 07/09/2026 08:00', '+07:00'), null);
    assert.equal(
      parseDeadline('Opened: Monday, 7 September 2026, 12:00 AM Closed: Saturday, 26 September 2026, 11:59 PM', '+07:00'),
      '2026-09-26T16:59:00.000Z'
    );

    // 2. formatDeadlinesObservation distinguishes past-only vs future deadlines against nowMs
    const fakeNow = Date.parse('2026-11-17T04:00:00.000Z');
    const pastOnlyMsg = formatDeadlinesObservation([
      { label: 'Ôn tập tuần 1', dueAt: '2026-09-26T16:59:00.000Z' },
      { label: 'Bài kiểm tra số 1', dueAt: '2026-10-03T16:59:00.000Z' }
    ], fakeNow);
    assert.ok(pastOnlyMsg.includes('KHÔNG CÓ bài nào sắp đến hạn'));
    assert.ok(pastOnlyMsg.includes('[ĐÃ QUÁ HẠN / ĐÃ ĐÓNG TRONG QUÁ KHỨ'));

    const mixedMsg = formatDeadlinesObservation([
      { label: 'Tuần 1 cũ', dueAt: '2026-09-26T16:59:00.000Z' },
      { label: 'Tuần 2 cũ', dueAt: '2026-10-03T16:59:00.000Z' },
      { label: 'Bài tuần 12 sắp tới', dueAt: '2026-11-20T16:59:00.000Z' }
    ], fakeNow);
    assert.ok(mixedMsg.includes('BÀI SẮP ĐẾN HẠN (1 bài có hạn trong tương lai)'));
    assert.ok(mixedMsg.includes('[SẮP ĐẾN HẠN - còn'));
    assert.ok(mixedMsg.indexOf('Bài tuần 12 sắp tới') < mixedMsg.indexOf('Tuần 1 cũ'));

    // 3. Planner prompt injects real-time clock & course star filtering + deadlines extraction on DOM
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const ctx = makeCtx({ userIntent: 'CHECK_DEADLINES', targetCourse: 'MI2020' });
      ctx.context = context;
      ctx.page = page;
      const historyPrompt = buildHistoryPrompt(ctx, 'kiểm tra bài nào sắp đến hạn');
      assert.ok(historyPrompt.includes('THỜI GIAN THỰC HIỆN TẠI (GMT+7)'));

      await page.goto(`${baseUrl}/my/courses-star`, { waitUntil: 'domcontentloaded' });
      const courseExtract = await executeAgentTool({ tool: 'browser.extractStructuredData', args: { type: 'courses' } }, ctx);
      assert.equal(courseExtract.success, true);
      assert.equal(courseExtract.data.courses.length, 1);
      assert.ok(courseExtract.data.courses[0].url.includes('/course/view.php?id=95'));
      assert.ok(courseExtract.observationText.includes('/course/view.php?id=95'));

      await page.goto(`${baseUrl}/course/view.php?id=95`, { waitUntil: 'domcontentloaded' });
      const dlExtract = await executeAgentTool({ tool: 'browser.extractStructuredData', args: { type: 'deadlines' } }, ctx);
      assert.equal(dlExtract.success, true);
      const dlLabels = (dlExtract.data.deadlines as any[]).map(d => d.label);
      assert.ok(!dlLabels.some(l => l.includes('Video bài giảng chương 1')), 'Opened-only video resource must not appear in deadlines');
      assert.ok(dlExtract.observationText.includes('Kiểm tra trắc nghiệm sắp tới'));
      assert.ok(dlExtract.observationText.includes('BÀI SẮP ĐẾN HẠN (1 bài có hạn trong tương lai)'));
      assert.ok(dlExtract.observationText.includes('Sắp đến hạn: còn'));
    } finally {
      await context.close();
    }
  });

  test('UPG-6: 100+ LMS catalog resolution, deepVerify closed quiz status & single-URL SPA quiz progression', async () => {
    // 1. Platform catalog resolution & DEFAULT_ALLOWED_HOSTS check
    assert.ok(DEFAULT_ALLOWED_HOSTS.length >= 100);
    for (const host of ['fami.hust.edu.vn', 'sohoa.hust.edu.vn', 'hustack.soict.ai', 'daotao.ai', 'mooc.hust.edu.vn', 'lms.ptit.edu.vn', 'coursera.org', 'olm.vn']) {
      assert.ok(DEFAULT_ALLOWED_HOSTS.includes(host), `Missing host in DEFAULT_ALLOWED_HOSTS: ${host}`);
    }
    assert.equal(resolveKnownPlatformFromPrompt('vào sohoa kiểm tra bài')?.url, 'https://fami.hust.edu.vn/sohoa');
    assert.equal(resolveKnownPlatformFromPrompt('mở hustack làm bài tập')?.url, 'https://hustack.soict.ai');
    assert.equal(resolveKnownPlatformFromPrompt('vào mooc hust học')?.url, 'https://mooc.hust.edu.vn');
    assert.equal(resolveKnownPlatformFromPrompt('vào mooc daotao.ai')?.url, 'https://daotao.ai');
    assert.equal(extractCredentialsAndUrlFromPrompt('vào hustack giải quiz').targetUrl, 'https://hustack.soict.ai');
    assert.equal(extractCredentialsAndUrlFromPrompt('vào sohoa làm bài').targetUrl, 'https://fami.hust.edu.vn/sohoa');
    // Guard against matching lowercase Vietnamese "nếu" as NEU LMS
    assert.equal(resolveKnownPlatformFromPrompt('nếu bài chưa làm thì làm tiếp'), undefined);

    const context = await browser.newContext();
    const page = await context.newPage();

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const q = payload.questions[0];
      if (q.prompt.includes('2 + 2')) {
        const opt = q.options.find((o: any) => o.text === '4') || q.options[1];
        return mockRouterRes(JSON.stringify({ answers: [{ id: q.id, selected: [opt.id], confidence: 0.99 }] }), 'mock-spa');
      }
      const opt = q.options.find((o: any) => o.text === 'Tokyo') || q.options[1];
      return mockRouterRes(JSON.stringify({ answers: [{ id: q.id, selected: [opt.id], confidence: 0.99 }] }), 'mock-spa');
    };

    try {
      const ctx = makeCtx();
      ctx.context = context;
      ctx.page = page;

      // 2. deepVerify enters closed quizzes 961 (done + graded) vs 962 (missed/unattempted)
      await page.goto(`${baseUrl}/course/view.php?id=96`, { waitUntil: 'domcontentloaded' });
      const actRes = await executeAgentTool({
        tool: 'browser.extractStructuredData',
        args: { type: 'activities', deepVerify: true }
      }, ctx);
      assert.equal(actRes.success, true);
      assert.ok(actRes.observationText.includes('[ĐÃ LÀM XONG ✓ | Điểm: 9.50 / 10.00 | Hiện đã đóng'));
      assert.ok(actRes.observationText.includes('[ĐÃ HẾT HẠN / ĐÓNG - CHƯA LÀM / BỎ LỠ ✗ | Đã đóng mà không có lượt nộp nào'));
      assert.ok(actRes.observationText.includes('1 bài ĐÃ LÀM XONG (có điểm/lượt nộp) | 0 bài ĐANG MỞ CHƯA LÀM | 1 bài ĐÃ ĐÓNG MÀ CHƯA LÀM (bỏ lỡ)'));
      assert.equal(context.pages().length, 1, 'Zero leaked tabs after deepVerify');

      // 3. Single-URL SPA quiz advances in-place without URL change
      await page.goto(`${baseUrl}/sohoa/phong-hoc/kiem-tra/97`, { waitUntil: 'domcontentloaded' });
      const spaRes = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(spaRes.success, true);
      assert.equal(spaRes.data?.questionsFilled, 2);
      assert.equal(state.spaQuizSubmitted, 's1=4&s2=Tokyo');
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-7: Multimedia & Interactive exercises (Video gate, Listening VTT, Speaking WAV+getUserMedia, Drag-Drop, Ordering, Matching, Slider)', async () => {
    // 1. Unit check: VTT caption cleanup & speech WAV synthesis worker
    const cleanedVtt = parseSubtitleTranscript('WEBVTT\n\n00:00:01.000 --> 00:00:04.500\n<c>Host:</c> Hello team.');
    assert.equal(cleanedVtt, 'Host: Hello team.');

    const wavOutPath = join(tempDir, 'test-speak.wav');
    const wavRes = await synthesizeSpeechWav('Could you repeat that, please?', wavOutPath, true);
    assert.equal(wavRes.ok, true);
    assert.equal((await readFileMagic(wavRes.wavPath)).slice(0, 4), 'RIFF');
    assert.ok((await stat(wavRes.wavPath)).size > 1000);

    // 2. Full E2E flow via executeQuizSolve starting on Video Gate -> Unlock -> Solve 6 multimedia/interactive questions -> Submit
    const context = await browser.newContext();
    const page = await context.newPage();
    state.multimediaSubmitted = '';

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const qs = (payload.questions || payload.questionsToVerify || []) as any[];
      const answers = qs.map((q: any) => {
        if (q.sourceType === 'interactive:speech') {
          return { id: q.id, text: 'Could you repeat that, please?', confidence: 0.97 };
        }
        if (q.sourceType === 'interactive:slider') {
          return { id: q.id, text: '4', confidence: 0.97 };
        }
        if (q.sourceType === 'interactive:matching') {
          const sunOpt = q.options.find((o: any) => o.text === 'Sun');
          const moonOpt = q.options.find((o: any) => o.text === 'Moon');
          const mtZone = q.zones.find((z: any) => z.text.includes('Mặt trời'));
          const mtrZone = q.zones.find((z: any) => z.text.includes('Mặt trăng'));
          return {
            id: q.id,
            placements: [
              { itemId: sunOpt.id, zoneId: mtZone.id },
              { itemId: moonOpt.id, zoneId: mtrZone.id }
            ],
            confidence: 0.97
          };
        }
        if (q.kind === 'dragdrop') {
          const parisOpt = q.options.find((o: any) => o.text === 'Paris');
          const tokyoOpt = q.options.find((o: any) => o.text === 'Tokyo');
          const frZone = q.zones.find((z: any) => z.text.includes('France'));
          const jpZone = q.zones.find((z: any) => z.text.includes('Japan'));
          return {
            id: q.id,
            placements: [
              { itemId: parisOpt.id, zoneId: frZone.id },
              { itemId: tokyoOpt.id, zoneId: jpZone.id }
            ],
            confidence: 0.97
          };
        }
        if (q.kind === 'ordering') {
          const helloOpt = q.options.find((o: any) => o.text === 'Hello');
          const worldOpt = q.options.find((o: any) => o.text === 'world');
          return { id: q.id, selected: [helloOpt.id, worldOpt.id], confidence: 0.97 };
        }
        // Listening radio question should carry extracted VTT transcript in prompt
        if (q.kind === 'radio') {
          assert.ok(String(q.prompt).includes('Singapore'), `Expected listening transcript in prompt, got: ${q.prompt}`);
          const sgOpt = q.options.find((o: any) => /Singapore/i.test(o.text));
          return { id: q.id, selected: [sgOpt.id], confidence: 0.97 };
        }
        return { id: q.id, selected: q.options?.[0]?.id ? [q.options[0].id] : undefined, confidence: 0.96 };
      });
      return mockRouterRes(JSON.stringify({ answers }), 'mock-multimedia');
    };

    try {
      const ctx = makeCtx();
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/interactive/video-gated`, { waitUntil: 'domcontentloaded' });
      const res = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(res.success, true, res.error || res.observationText);
      assert.equal(res.data?.questionsFound, 6);
      assert.equal(res.data?.questionsFilled, 6);
      assert.equal(res.data?.submitted, true);
      assert.ok(state.multimediaSubmitted, 'Expected multimedia exam payload to be submitted');

      const submitted = JSON.parse(state.multimediaSubmitted);
      assert.equal(submitted.city, 'singapore');
      assert.equal(submitted.spkDone, true);
      assert.equal(submitted.spkHasRiff, true);
      assert.ok(submitted.spkTracks >= 1, `Expected active Web Audio track in getUserMedia, got ${submitted.spkTracks}`);
      assert.deepEqual(submitted.zones, ['France=Paris', 'Japan=Tokyo']);
      assert.deepEqual(submitted.order, ['Hello', 'world']);
      assert.deepEqual(submitted.matches, ['Moon->Mặt trăng', 'Sun->Mặt trời']);
      assert.equal(submitted.slider, '4');
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-8: Multi-key rotation per profile (keySlots), sticky-overlay DOM check & Round-2 math/checkbox verification', async () => {
    resetProfileCooldowns();
    try {
      // 1. Multi-key slot attachment on one profile (zero secrets stored in JSON)
      const tempPoolDbPath = join(tempDir, 'temp-multi-key-profiles.json');
      const memVault = new Map<string, string>();
      const setKeyMock = (slotId: string, apiKey: string) => { memVault.set(slotId, apiKey); };
      const getKeyMock = (slotId: string) => memVault.get(slotId) || null;

      const initDb: ModelProfilesDb = {
        default: 'prf_gem',
        profiles: {
          prf_gem: {
            provider: 'gemini',
            kind: 'gemini',
            model: 'gemini-3-flash-preview',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            verifiedStatus: 'VERIFIED'
          }
        },
        fallbacks: []
      };
      setKeyMock('prf_gem', 'AIzaSyFakeKeyOne_1111111111111111111');
      await saveProfilesDb(initDb, tempPoolDbPath);

      const addRes = await addApiKeysToProfile('prf_gem', [
        'AIzaSyFakeKeyTwo_2222222222222222222',
        'AIzaSyFakeKeyThree_333333333333333333'
      ], {
        dbPath: tempPoolDbPath,
        setKeyFn: setKeyMock,
        getKeyFn: getKeyMock
      });
      assert.equal(addRes.addedSlots.length, 2);
      assert.equal(addRes.totalSlots, 3);

      const loadedDb = await readProfilesDb(tempPoolDbPath);
      const slots = getProfileKeySlots('prf_gem', loadedDb.profiles.prf_gem);
      assert.deepEqual(slots, ['prf_gem', 'prf_gem__k2', 'prf_gem__k3']);
      const rawDbText = await (await import('node:fs/promises')).readFile(tempPoolDbPath, 'utf8');
      assert.equal(rawDbText.includes('AIzaSyFakeKey'), false, 'Secrets must NEVER be saved in JSON DB');

      // Verify round-robin rotates across all 3 key slots INSIDE prf_gem even with profileOverride set!
      const p0 = await ModelRouter.resolveCandidates({
        db: loadedDb, expandModelPool: true, preferAccuracy: true, profileOverride: 'prf_gem', modelOverride: 'gemini-3-flash-preview', roundRobinIndex: 0
      });
      const p1 = await ModelRouter.resolveCandidates({
        db: loadedDb, expandModelPool: true, preferAccuracy: true, profileOverride: 'prf_gem', modelOverride: 'gemini-3-flash-preview', roundRobinIndex: 1
      });
      const p2 = await ModelRouter.resolveCandidates({
        db: loadedDb, expandModelPool: true, preferAccuracy: true, profileOverride: 'prf_gem', modelOverride: 'gemini-3-flash-preview', roundRobinIndex: 2
      });
      assert.equal(p0.primary.keySlot, undefined); // primary slot
      assert.equal(p1.primary.keySlot, 'prf_gem__k2');
      assert.equal(p2.primary.keySlot, 'prf_gem__k3');

      // Verify per-(profile, keySlot, model) isolation: DAILY 429 on slot 1 + OVERLOAD 503 on slot 2 -> switches immediately in 1 try each to slot 3!
      const attemptedSlots: string[] = [];
      const resolveSlotFn = async (spec: ProviderSpec): Promise<ResolvedProvider> => {
        const slot = spec.keySlot || spec.profileId || 'prf_gem';
        return {
          profileId: spec.profileId || 'prf_gem',
          keySlot: slot,
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3-flash-preview',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: getKeyMock(slot) || ''
        };
      };

      const rotExec = await ModelRouter.execute(
        { system: 's', text: 'hi' },
        {
          db: loadedDb,
          resolveFn: resolveSlotFn,
          expandModelPool: true,
          preferAccuracy: true,
          modelOverride: 'gemini-3-flash-preview',
          maxAttemptsPerModel: 3,
          waitOnRateLimit: false
        },
        async (prov) => {
          const usedSlot = prov.keySlot || prov.profileId || 'prf_gem';
          attemptedSlots.push(usedSlot);
          if (usedSlot === 'prf_gem') {
            const e: any = new Error('HTTP 429 PerDay quota exceeded');
            e.status = 429;
            e.rateLimitScope = 'DAILY';
            throw e;
          }
          if (usedSlot === 'prf_gem__k2') {
            const e: any = new Error('HTTP 503 [OVERLOAD] high demand');
            e.status = 503;
            e.rateLimitScope = 'OVERLOAD';
            throw e;
          }
          return `ok:${usedSlot}`;
        }
      );
      assert.deepEqual(attemptedSlots, ['prf_gem', 'prf_gem__k2', 'prf_gem__k3'], '503 OVERLOAD must switch immediately on single try without 3x retry waste');
      assert.equal(rotExec.output, 'ok:prf_gem__k3');
      assert.equal(rotExec.keySlotUsed, 'prf_gem__k3');
      assert.equal(getProfileKeySlots('prf_gem', loadedDb.profiles.prf_gem).length, 3);
      assert.equal(getCooldownKey('prf_gem', 'gemini-3-flash-preview', 'prf_gem'), 'prf_gem::gemini-3-flash-preview');
      assert.equal(getCooldownKey('prf_gem', 'gemini-3-flash-preview', 'prf_gem__k2'), 'prf_gem::prf_gem__k2::gemini-3-flash-preview');

      // 2. E2E Quiz 851: Sticky header overlap radio + HTML Page RAG + Round-2 verification catching 0.95 checkbox mistake & checking math
      const context = await browser.newContext();
      const page = await context.newPage();
      state.quiz851Submitted = '';
      let round1Calls = 0;
      let round2VerifySawAllSummaryAndRag = false;

      ModelRouter.execute = async (req: any, opts: any) => {
        const txt = String(req.text || '');
        const payload = JSON.parse(txt);
        assert.ok(typeof opts.roundRobinIndex === 'number', 'quiz-solver must pass monotonic roundRobinIndex');

        if (payload.questionsToVerify) {
          round2VerifySawAllSummaryAndRag =
            Array.isArray(payload.quizContext?.allQuestionsSummary) &&
            String(payload.quizContext?.studyContext || '').includes('P(A|B) = P(AB) / P(B)');
          const fixed = payload.questionsToVerify.map((q: any) => {
            if (q.kind === 'checkbox' && /Né tránh/i.test(q.prompt)) {
              const o0 = q.options.find((o: any) => o.text.includes('Không đưa ra ý kiến'));
              const o2 = q.options.find((o: any) => o.text.includes('Tránh tiếp xúc'));
              return { id: q.id, selected: [o0.id, o2.id], confidence: 0.99, reasoning: 'Loại ý Tuân theo trùng với m2' };
            }
            if (q.kind === 'checkbox' && /Tuân theo/i.test(q.prompt)) {
              return { id: q.id, selected: q.options.map((o: any) => o.id), confidence: 0.99 };
            }
            return { id: q.id, text: '0.75', confidence: 0.99, reasoning: '0.3 / 0.4 = 0.75' };
          });
          return mockRouterRes(JSON.stringify({ answers: fixed }), 'mock-verifier');
        }

        round1Calls++;
        const ans = (payload.questions || []).map((q: any) => {
          if (q.kind === 'checkbox' && /Né tránh/i.test(q.prompt)) {
            // Simulate overconfident 0.95 mistake selecting ALL 3 options (matching exact Bài 13 log bug!)
            return { id: q.id, selected: q.options.map((o: any) => o.id), confidence: 0.95 };
          }
          if (q.kind === 'checkbox' && /Tuân theo/i.test(q.prompt)) {
            return { id: q.id, selected: q.options.map((o: any) => o.id), confidence: 0.95 };
          }
          if (q.kind === 'text') {
            return { id: q.id, text: '0.75', confidence: 0.95 };
          }
          const right = q.options.find((o: any) => o.text.includes('kết quả làm việc'));
          return { id: q.id, selected: [right.id], confidence: 0.95 };
        });
        return mockRouterRes(JSON.stringify({ answers: ans }), 'mock-solver');
      };

      try {
        const ctx = makeCtx({ targetActivity: '851' });
        ctx.context = context;
        ctx.page = page;
        await page.goto(`${baseUrl}/course/view.php?id=85`, { waitUntil: 'domcontentloaded' });
        const qRes = await executeQuizSolve(page, ctx, { targetActivity: '851', autoSubmit: true });
        assert.equal(qRes.success, true, qRes.error || qRes.observationText);
        assert.equal(qRes.data?.questionsFound, 4);
        assert.equal(qRes.data?.questionsFilled, 4);
        assert.equal(qRes.data?.fillFailures, 0, 'Sticky header must NOT cause locator.check timeout');
        assert.equal(qRes.data?.submitted, true);
        assert.equal(round2VerifySawAllSummaryAndRag, true, 'Round-2 verifier must receive allQuestionsSummary + HTML Page RAG');
        assert.ok(round1Calls >= 1);

        const decoded = decodeURIComponent(state.quiz851Submitted);
        assert.ok(decoded.includes('q1_a=1') && decoded.includes('q1_c=1') && !decoded.includes('q1_b=1'), `Round-2 must strip conflicting Tuân theo checkbox from Né tránh: ${decoded}`);
        assert.ok(decoded.includes('q3_ans=0.75'));
        assert.ok(decoded.includes('q4_ans=right'));
      } finally {
        ModelRouter.execute = realExecute;
        await context.close();
      }
    } finally {
      ModelRouter.execute = realExecute;
      resetProfileCooldowns();
    }
  });

  test('UPG-9A: Moodle header search decoy + "Nộp bài ..." next-nav -> summary.php -> modal confirm -> review.php', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    state.quiz861Submitted = '';
    state.quiz861SearchHijacked = false;

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const qs = payload.questions || payload.questionsToVerify || [];
      return mockRouterRes(JSON.stringify({
        answers: qs.map((q: any) => {
          const right = q.options.find((o: any) => /Cộng tác/i.test(o.text)) || q.options[0];
          return { id: q.id, selected: [right.id], confidence: 0.99 };
        })
      }), 'mock-solver');
    };

    try {
      const ctx = makeCtx({ allowReattempt: true });
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/mod/quiz/view.php?id=861`, { waitUntil: 'domcontentloaded' });
      const res = await executeQuizSolve(page, ctx, { allowReattempt: true, autoSubmit: true });
      assert.equal(res.success, true, res.error || res.observationText);
      assert.equal(state.quiz861SearchHijacked, false, 'Must NEVER click header Search submit button');
      assert.equal(res.data?.submitted, true);
      assert.match(String(res.data?.finalUrl || ''), /\/mod\/quiz\/review\.php/);
      assert.match(String(res.data?.scoreObserved || ''), /9\.00/);
      assert.match(state.quiz861Submitted, /finish861=1/);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-9B: Stuck In-Progress attempt fails closed (never lies submitted=true) + 45-resource course shows bottom quizzes', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const qs = payload.questions || payload.questionsToVerify || [];
      return mockRouterRes(JSON.stringify({
        answers: qs.map((q: any) => ({ id: q.id, selected: [q.options[0].id], confidence: 0.99 }))
      }), 'mock-solver');
    };

    try {
      const ctx = makeCtx();
      ctx.context = context;
      ctx.page = page;

      // 1. Stuck attempt.php MUST NOT report submitted=true or success=true
      await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=862`, { waitUntil: 'domcontentloaded' });
      const stuckRes = await executeQuizSolve(page, ctx, { autoSubmit: true });
      assert.equal(stuckRes.success, false, 'Stuck In progress quiz must NOT succeed');
      assert.equal(stuckRes.data?.submitted, false, 'Stuck quiz must keep submitted=false');
      assert.equal(stuckRes.data?.submitFailed, true);
      assert.match(stuckRes.observationText, /IN PROGRESS/i);

      // 2. Course with 45 announcements/pages before 3 quizzes must still deepVerify & list all 3 quizzes clearly
      await page.goto(`${baseUrl}/course/view.php?id=86`, { waitUntil: 'domcontentloaded' });
      const extractRes = await executeAgentTool({ tool: 'browser.extractStructuredData', args: { type: 'activities', deepVerify: true } }, ctx);
      assert.equal(extractRes.success, true);
      assert.ok(extractRes.observationText.includes('Quiz 1 Tuần 9'), extractRes.observationText);
      assert.ok(extractRes.observationText.includes('Quiz 2 Chương 3'), extractRes.observationText);
      assert.ok(extractRes.observationText.includes('Quiz 3 Chương 4'), extractRes.observationText);
      assert.match(extractRes.observationText, /ĐANG MỞ & CHƯA CÓ LẦN NỘP NÀO:.*"Quiz 2 Chương 3/);
      assert.match(extractRes.observationText, /ĐANG LÀM DỞ \(IN PROGRESS - CHƯA NỘP\):.*"Quiz 3 Chương 4/);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-10: Proactive RPM/TPM key rotation, overload breaker, auto-reset sync, auto score-retry >= 8 & reportResult gate', async () => {
    resetProfileCooldowns();
    try {
      // 1. Key deduplication + multi-slot storage
      const dbPath = join(tempDir, 'upg10-profiles.json');
      const vault = new Map<string, string>();
      const baseDb: ModelProfilesDb = {
        default: 'prf_pool',
        fallbacks: [],
        profiles: {
          prf_pool: {
            provider: 'gemini',
            kind: 'gemini',
            model: 'gemini-3-flash-preview',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            displayName: 'Pool 3 Keys',
            keySlots: ['prf_pool']
          }
        }
      };
      vault.set('prf_pool', 'AIzaSyPoolKeyOne0000000001');
      await saveProfilesDb(baseDb, dbPath);

      const dedupRes = await addApiKeysToProfile(
        'prf_pool',
        [
          'AIzaSyPoolKeyOne0000000001',
          'AIzaSyPoolKeyTwo0000000002',
          'AIzaSyPoolKeyThree00000003',
          'AIzaSyPoolKeyTwo0000000002'
        ],
        {
          dbPath,
          setKeyFn: (s, k) => { vault.set(s, k); },
          getKeyFn: (s) => vault.get(s) || null
        }
      );
      assert.deepEqual(dedupRes.addedSlots, ['prf_pool__k2', 'prf_pool__k3']);
      assert.equal(dedupRes.skippedDuplicates, 2);
      assert.equal(dedupRes.totalSlots, 3);

      const dbLoaded = await readProfilesDb(dbPath);
      const mockResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => ({
        kind: 'gemini',
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        model: spec.model || 'gemini-3-flash-preview',
        apiKey: vault.get(spec.keySlot || spec.profileId || 'prf_pool') || '',
        profileId: spec.profileId || 'prf_pool',
        keySlot: spec.keySlot || spec.profileId || 'prf_pool'
      });

      // 2. Proactive TPM rotation BEFORE HTTP 429: heavy token call on slot 1 triggers slot 2 for next call
      const usedSlotsTpm: string[] = [];
      await ModelRouter.execute(
        { system: 's', text: 'heavy-1' },
        {
          db: dbLoaded,
          resolveFn: mockResolve,
          modelOverride: 'gemini-3-flash-preview',
          enableTelemetryRotation: true,
          estimatedTokens: 240_000,
          expandModelPool: false
        },
        async (prov) => {
          usedSlotsTpm.push(prov.keySlot || '');
          return 'ok-1';
        }
      );
      await ModelRouter.execute(
        { system: 's', text: 'heavy-2' },
        {
          db: dbLoaded,
          resolveFn: mockResolve,
          modelOverride: 'gemini-3-flash-preview',
          enableTelemetryRotation: true,
          estimatedTokens: 20_000,
          expandModelPool: false
        },
        async (prov) => {
          usedSlotsTpm.push(prov.keySlot || '');
          return 'ok-2';
        }
      );
      assert.equal(usedSlotsTpm[0], 'prf_pool');
      assert.equal(usedSlotsTpm[1], 'prf_pool__k2', 'Must proactively rotate to key #2 before hitting TPM limit');

      const snap = getKeySlotTelemetrySnapshot();
      const slot1Snap = snap.find(s => s.keySlot === 'prf_pool' && s.model === 'gemini-3-flash-preview');
      assert.ok(slot1Snap && slot1Snap.usedRpm60s === 1 && slot1Snap.usedTokensToday >= 240_000);

      // 3. Auto-reset sync: exhausted slot is skipped, then probe reporting AVAILABLE unlocks it cleanly
      syncCooldownFromProbe('prf_pool', 'gemini-3-flash-preview', 'prf_pool__k3', 'DAILY_EXHAUSTED');
      const planBlocked = await ModelRouter.resolveCandidates({
        db: dbLoaded,
        modelOverride: 'gemini-3-flash-preview',
        enableTelemetryRotation: true,
        expandModelPool: false
      });
      assert.equal(planBlocked.candidates[planBlocked.candidates.length - 1].keySlot, 'prf_pool__k3');
      syncCooldownFromProbe('prf_pool', 'gemini-3-flash-preview', 'prf_pool__k3', 'AVAILABLE');
      const planUnlocked = await ModelRouter.resolveCandidates({
        db: dbLoaded,
        modelOverride: 'gemini-3-flash-preview',
        enableTelemetryRotation: true,
        expandModelPool: false
      });
      assert.notEqual(planUnlocked.candidates[0].keySlot, 'prf_pool', 'Proactively cooled slot1 stays rotated while unlocked k3 is healthy');

      // 4. Model-wide OVERLOAD circuit breaker: 2 OVERLOAD failures on 3.7-flash bypasses 3rd key and switches to healthy model
      resetProfileCooldowns();
      const attemptedPairs: string[] = [];
      const ovRes = await ModelRouter.execute(
        { system: 's', text: 'overload-test' },
        {
          db: dbLoaded,
          resolveFn: mockResolve,
          preferAccuracy: true,
          expandModelPool: true,
          enableTelemetryRotation: true,
          maxRateLimitWaitCycles: 0
        },
        async (prov) => {
          attemptedPairs.push(`${prov.keySlot}/${prov.model}`);
          if (prov.model !== 'gemini-3-flash-preview') {
            const e: any = new Error('HTTP 503 [OVERLOAD]: high demand');
            e.status = 503;
            e.rateLimitScope = 'OVERLOAD';
            throw e;
          }
          return 'ok-healthy';
        }
      );
      assert.equal(ovRes.output, 'ok-healthy');
      assert.equal(ovRes.modelUsed, 'gemini-3-flash-preview');
      const previewHitCountOnSlot1 = attemptedPairs.filter(p => p.includes('gemini-3.5-flash-lite')).length;
      assert.equal(previewHitCountOnSlot1, 0, 'Healthy 3-flash-preview solved before falling down to flash-lite');
      recordKeySlotUsage({ profileId: 'prf_pool', keySlot: 'prf_pool', provider: 'gemini', model: 'gemini-3-flash-preview', promptTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 5, timestamp: Date.now() }, false);

      // 5. Auto Score-Retry Loop: Round 1 scores 6.00 (< 8) -> automatically reads review.php & solves Round 2 to 10.00/10.00!
      const context = await browser.newContext();
      const page = await context.newPage();
      state.quiz881Round = 0;

      ModelRouter.execute = async (req: any) => {
        const payload = JSON.parse(String(req.text || '{}'));
        const qs = payload.questions || payload.questionsToVerify || [];
        const reviewHint = String(payload.quizContext?.previousAttemptReview || '');
        const answers = qs.map((q: any) => {
          if (reviewHint.includes('Hà Nội')) {
            const hn = q.options.find((o: any) => o.text.includes('Hà Nội'));
            return { id: q.id, selected: [hn.id], confidence: 0.99 };
          }
          const hcm = q.options.find((o: any) => o.text.includes('TP.HCM'));
          return { id: q.id, selected: [hcm.id], confidence: 0.95 };
        });
        return mockRouterRes(JSON.stringify({ answers }), 'mock-retry');
      };

      try {
        const ctx = makeCtx({
          userIntent: 'SOLVE_QUIZ',
          allowReattempt: true,
          activityFilter: { maxGradeToReattempt: 8 }
        });
        ctx.context = context;
        ctx.page = page;
        await page.goto(`${baseUrl}/mod/quiz/view.php?id=881`, { waitUntil: 'domcontentloaded' });
        const retryRes = await executeQuizSolve(page, ctx, {
          allowReattempt: true,
          maxGradeToReattempt: 8,
          autoSubmit: true
        });
        assert.equal(retryRes.success, true);
        assert.equal(state.quiz881Round, 2, 'Must automatically retry after scoring 6.00 < 8');
        assert.match(String(retryRes.data?.scoreObserved || ''), /10\.00/);

        // 6. Evidence-Based Completion Gate on agent.reportResult: below-target score downgrades DONE -> NEEDS_REVIEW
        const gateCtx = makeCtx({
          userIntent: 'SOLVE_QUIZ',
          activityFilter: { maxGradeToReattempt: 8 }
        });
        gateCtx.collectedFindings['solvedQuizzes'] = [
          { title: 'Quiz Below Gate', questionsFound: 4, questionsFilled: 4, submitted: true, scoreObserved: 'Grade 6.00 out of 10.00', solvedAtStep: 0 }
        ];
        const gateRes = await executeAgentTool({
          tool: 'agent.reportResult',
          args: { status: 'DONE', summary: 'Điểm số đạt được: Đạt >= 8 điểm' }
        }, gateCtx);
        assert.equal(gateRes.data?.status, 'NEEDS_REVIEW', 'reportResult must downgrade DONE when observed grade < 8');
      } finally {
        ModelRouter.execute = realExecute;
        await context.close();
      }
    } finally {
      ModelRouter.execute = realExecute;
      resetProfileCooldowns();
    }
  });

  test('UPG-11: Prompt course/grade parse, Moodle 4 resource RAG, multi-page review pagination, Vietnamese partial status, single-Q checkbox Round-2 & batch score-retry', async () => {
    const { extractCredentialsAndUrlFromPrompt } = await import('../src/agent/loop.js');
    const parsed = extractCredentialsAndUrlFromPrompt(
      'truy cập lms hust, vào course kỹ năng mềm, làm lại 2 bài trắc nghiệm online 13 và 14, yêu cầu phải từ 8/10 trở lên'
    );
    assert.equal(parsed.targetCourse, 'kỹ năng mềm');
    assert.equal(parsed.allowReattempt, true);
    assert.equal(parsed.solveAll, true);
    assert.deepEqual(parsed.activityFilter?.includeNumbers, [13, 14]);
    assert.equal(parsed.activityFilter?.maxGradeToReattempt, 8);

    const context = await browser.newContext();
    const page = await context.newPage();
    state.quiz891Round = 0;
    state.quiz891LastQ1 = '';
    state.quiz891LastQ2 = '';

    let solverCalls = 0;
    let verifyCalls = 0;
    let sawResourceRag = false;
    let sawPartialStatusNotCorrect = false;
    let sawPage2AriaLabelledReview = false;
    let sawOverviewRetry = false;

    ModelRouter.execute = async (req: any) => {
      const payload = JSON.parse(String(req.text || '{}'));
      const reviewItems = Array.isArray(payload.quizContext?.previousAttemptReview)
        ? payload.quizContext.previousAttemptReview
        : [];
      const q1Rev = reviewItems.find((r: any) => String(r.prompt || '').includes('vấn đề cần quan tâm'));
      const q2Rev = reviewItems.find((r: any) => String(r.prompt || '').includes('Mục đích của đánh giá nhóm'));
      if (q1Rev?.status === 'partial' && String(q1Rev.chosenAnswer || '').includes('Phương pháp đánh giá')) {
        sawPartialStatusNotCorrect = true;
      }
      if (q2Rev && String(q2Rev.chosenAnswer || '').includes('Tạo cơ hội thích nghi')) {
        sawPage2AriaLabelledReview = true;
      }
      if (String(payload.quizContext?.studyContext || '').includes('TAI LIEU ED3220')) {
        sawResourceRag = true;
      }
      if (String(payload.quizContext?.previousAttemptOverview || '').includes('4.00')) {
        sawOverviewRetry = true;
      }

      if (payload.questionsToVerify) {
        verifyCalls++;
        const verified = payload.questionsToVerify.map((vq: any) => {
          // On Round 1 (quiz891Round === 0), verifier still keeps select-all mistake on Q2 to test Auto Score-Retry!
          if (state.quiz891Round === 0) {
            return { id: vq.id, selected: vq.options.map((o: any) => o.id), confidence: 0.96 };
          }
          // On Round 2 retry (quiz891Round === 1), verifier uses RAG + prior review to strip distractor (o3)!
          return { id: vq.id, selected: vq.options.slice(0, 3).map((o: any) => o.id), confidence: 0.99 };
        });
        return mockRouterRes(JSON.stringify({ answers: verified }), 'mock-verify-891');
      }

      solverCalls++;
      const answers = (payload.questions || []).map((q: any) => ({
        id: q.id,
        selected: q.options.map((o: any) => o.id),
        confidence: 0.95
      }));
      return mockRouterRes(JSON.stringify({ answers }), 'mock-solver-891');
    };

    try {
      const ctx = makeCtx({ userIntent: 'SOLVE_QUIZ', allowReattempt: true });
      ctx.context = context;
      ctx.page = page;
      await page.goto(`${baseUrl}/course/view.php?id=89`, { waitUntil: 'domcontentloaded' });
      const batchRes = await executeAgentTool({
        tool: 'quiz.solve',
        args: { allowReattempt: true, solveAll: true, activityRange: '14', maxGradeToReattempt: 8, autoSubmit: true }
      }, ctx);

      assert.equal(batchRes.success, true, batchRes.error || batchRes.observationText);
      assert.equal(sawResourceRag, true, 'Must extract /mod/resource/view.php -> pluginfile.php slide RAG');
      assert.equal(sawPartialStatusNotCorrect, true, 'Must classify Vietnamese "Đúng một phần" as partial, NOT correct');
      assert.equal(sawPage2AriaLabelledReview, true, 'Must paginate review.php page=1 and read aria-labelledby chosen answers');
      assert.equal(sawOverviewRetry, true, 'Must surface prior attempt grade overview into quizContext');
      assert.ok(verifyCalls >= 2, `1-question-per-page checkbox with conf=0.95 on reattempt must trigger Round-2 verify (got ${verifyCalls})`);
      assert.ok(solverCalls >= 4, 'Must execute 2 pages across 2 attempts');
      assert.equal(state.quiz891Round, 2, 'Batch mode maxGradeToReattempt=8 must auto-retry after 4.00/10.00');
      assert.match(String(batchRes.data?.solvedItems?.[0]?.scoreObserved || ''), /^Grade 10\.00/);

      // Also verify reportResult catches tool-arg maxGradeToReattempt even when ctx.config.activityFilter is unset!
      const gateToolCtx = makeCtx({ userIntent: 'SOLVE_QUIZ', allowReattempt: true });
      gateToolCtx.collectedFindings['targetMinGrade'] = 8;
      gateToolCtx.collectedFindings['solvedQuizzes'] = [
        { title: '14.TRẮC NGHIỆM "Đánh giá nhóm"', questionsFound: 4, questionsFilled: 4, submitted: true, scoreObserved: 'Grade 4.00 out of 10.00 (40%)', targetMinGrade: 8, solvedAtStep: 0 }
      ];
      const gateToolRes = await executeAgentTool({
        tool: 'agent.reportResult',
        args: { status: 'DONE', summary: 'Đã làm lại bài 14.' }
      }, gateToolCtx);
      assert.equal(gateToolRes.data?.status, 'NEEDS_REVIEW', 'reportResult must enforce tool-arg maxGradeToReattempt=8 and downgrade 4/10 to NEEDS_REVIEW');
      assert.match(String(gateToolRes.data?.summary || ''), /CHƯA ĐẠT NGƯỠNG ĐIỂM/);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });

  test('UPG-12: Multi-attempt Moodle 4.4 cards report latest/highest score (10.00 not Attempt 1 4.00), filter hidden headings & stop retry at target', async () => {
    const { observeScore } = await import('../src/observations.js');
    const { inspectQuizOrAssignmentStatus } = await import('../src/agent/activity-inspector.js');

    const context = await browser.newContext();
    const page = await context.newPage();
    state.quiz892Round = 1; // View shows Attempt 1 (4.00) AND Attempt 2 (10.00)

    try {
      await page.goto(`${baseUrl}/mod/quiz/view.php?id=892`, { waitUntil: 'domcontentloaded' });

      // 1. Direct DOM observation must read Attempt 2 (10.00), NOT Attempt 1 (4.00) or Marks (1.60/4.00) or hidden 0.00
      const obsScore = await observeScore(page);
      assert.ok(obsScore);
      assert.match(obsScore.text, /^Grade 10\.00 out of 10\.00/);

      const status = await inspectQuizOrAssignmentStatus(page);
      assert.ok(status);
      assert.equal(status.attemptCount, 2);
      assert.equal(status.latestGrade, '10.00 out of 10.00 (100%)');
      assert.match(status.grade || '', /10\.00 out of 10\.00/);

      // 2. browser.observe must omit hidden "Highest grade: 0.00 / 10.00." and hidden modal "Time limit" headings
      const ctxObs = makeCtx({ userIntent: 'SOLVE_QUIZ', allowReattempt: true });
      ctxObs.context = context;
      ctxObs.page = page;
      const obsToolRes = await executeAgentTool({ tool: 'browser.observe', args: { detailLevel: 'detailed' } }, ctxObs);
      assert.equal(obsToolRes.success, true);
      assert.equal(obsToolRes.observationText.includes('Highest grade: 0.00'), false, 'Hidden 0.00 heading must be filtered');
      assert.equal(obsToolRes.observationText.includes('Time limit'), false, 'Hidden modal Time limit heading must be filtered');
      assert.match(obsToolRes.observationText, /10\.00 out of 10\.00/);

      // 3. End-to-end re-attempt from Attempt 1 (4.00) -> Attempt 2 submits & redirects to view.php showing 4.00 + 10.00 -> must read 10.00 & stop cleanly after 1 re-attempt!
      state.quiz892Round = 0;
      ModelRouter.execute = async (req: any) => {
        const payload = JSON.parse(String(req.text || '{}'));
        const qs = payload.questions || payload.questionsToVerify || [];
        return mockRouterRes(JSON.stringify({
          answers: qs.map((q: any) => ({ id: q.id, selected: [q.options[1].id], confidence: 0.99 }))
        }), 'mock-solver-892');
      };

      const ctxSolve = makeCtx({ userIntent: 'SOLVE_QUIZ', allowReattempt: true, activityFilter: { maxGradeToReattempt: 8 } });
      ctxSolve.context = context;
      ctxSolve.page = page;
      await page.goto(`${baseUrl}/mod/quiz/view.php?id=892`, { waitUntil: 'domcontentloaded' });
      const solveRes = await executeQuizSolve(page, ctxSolve, {
        allowReattempt: true,
        maxGradeToReattempt: 8,
        autoSubmit: true
      });
      assert.equal(solveRes.success, true, solveRes.error || solveRes.observationText);
      assert.equal(state.quiz892Round, 1, 'Must stop cleanly once Attempt 2 reads 10.00 >= 8 without burning extra attempts');
      assert.match(String(solveRes.data?.scoreObserved || ''), /^Grade 10\.00 out of 10\.00/);
    } finally {
      ModelRouter.execute = realExecute;
      await context.close();
    }
  });
});

async function readFileMagic(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const b = await readFile(filePath);
  return b.subarray(0, 16).toString('latin1');
}
