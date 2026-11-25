/** Isolated Test Suite: Tiered Routing (Light/Balanced/Pro Math), Safe Python Math Verifier, Long Reading + PPTX RAG, Direct Audio Listening Transcription */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { executeQuizSolve, selectRelevantStudyChunks, mapModelAnswersToQuestions } from '../src/agent/quiz-solver.js';
import { parseAnswersListFromRaw } from '../src/agent/quiz-answer-parser.js';
import { promoteAndPrepareMultimediaQuestions, synthesizeSpeechWav } from '../src/agent/multimedia-interactive.js';
import { verifyMathExpressionsWithPython, doesCandidateMatchVerifiedNumber, isHardMathPrompt } from '../src/agent/math-verifier.js';
import { extractLocalDocumentText } from '../src/documents.js';
import { extractCredentialsAndUrlFromPrompt } from '../src/agent/loop.js';
import { buildSystemPrompt } from '../src/agent/planner.js';
import { ModelRouter, resetProfileCooldowns } from '../src/model-center/model-router.js';
import { scanQuestions } from '../src/scanner.js';
import type { AgentContext } from '../src/agent/types.js';

let server: Server;
let baseUrl = '';
let browser: Browser;
let tempDir = '';
const realExecute = ModelRouter.execute.bind(ModelRouter);

const LONG_READING_MARKER = 'UNIQUE_IELTS_PARAGRAPH_END_MARKER_4921';
const LONG_PASSAGE_BODY = `${'Academic research on urban microclimates indicates significant temperature variation across canopy densities. '.repeat(72)} Therefore, the conclusive finding is ${LONG_READING_MARKER}.`;

let lastMathSubmission = '';
let lastReadingSubmission = '';
let lastConsensusMathSubmission = '';

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'autotask-v13-tiering-'));
  const synth = await synthesizeSpeechWav('Platform 9B express train', join(tempDir, 'listening.wav'), true);
  const wavBuf = Buffer.from(synth.base64Wav, 'base64');

  server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const path = reqUrl.pathname;

    if (path === '/media/listening.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wavBuf);
      return;
    }

    if (path === '/quiz/listening-no-track') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>IELTS Listening No Track</title></head><body>
        <form id="quizform">
          <div class="que multichoice" id="question-l-1">
            <div class="qtext">Listen to the announcement and choose the departure platform:</div>
            <audio controls src="/media/listening.wav"></audio>
            <div class="answer">
              <label><input type="radio" name="ql1" value="a">Platform 3</label>
              <label><input type="radio" name="ql1" value="b">Platform 9B</label>
            </div>
          </div>
          <div class="que shortanswer" id="question-l-2">
            <div class="qtext">Write down the ticket price mentioned in the audio:</div>
            <audio controls src="/media/listening.wav"></audio>
            <input type="text" name="ql2" value="">
          </div>
        </form>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9101') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Xác suất thống kê ĐH</title></head><body>
        <h1>Kiểm tra Xác suất Thống kê (Đại học)</h1>
        <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9101">
          <div class="que multichoice" id="question-9101-1">
            <div class="qtext">Trong một hộp có 5 bi đỏ và 7 bi xanh. Lấy ngẫu nhiên đồng thời 3 bi. Tính xác suất để lấy được đúng 2 bi đỏ và 1 bi xanh?</div>
            <div class="answer">
              <label><input type="radio" name="q9101_1" value="opt1">1/4</label>
              <label><input type="radio" name="q9101_1" value="opt2">7/22</label>
              <label><input type="radio" name="q9101_1" value="opt3">5/14</label>
            </div>
          </div>
          <button type="submit">Finish attempt</button>
        </form>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/processattempt.php' && reqUrl.searchParams.get('id') === '9101' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      lastMathSubmission = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><div>Grade 10.00 out of 10.00</div><div>Finished</div></body></html>');
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9102') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>IELTS Academic Reading</title></head><body>
        <h1>IELTS Reading Passage 1</h1>
        <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9102">
          <div class="que description" id="question-9102-0">
            <div class="qtext">${LONG_PASSAGE_BODY}</div>
          </div>
          <div class="que shortanswer" id="question-9102-1">
            <div class="qtext">What is the exact conclusive marker code at the end of the passage?</div>
            <input type="text" name="q9102_1" value="">
          </div>
          <button type="submit">Finish attempt</button>
        </form>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/processattempt.php' && reqUrl.searchParams.get('id') === '9102' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      lastReadingSubmission = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><div>Grade 10.00 out of 10.00</div><div>Finished</div></body></html>');
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9103') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Toán Ma Trận & Đạo Hàm ĐH</title></head><body>
        <h1>Kiểm tra Toán Giải tích & Đại số</h1>
        <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9103">
          <div class="que multichoice" id="question-9103-1">
            <div class="qtext">
              <table><tr><th>Thành phần</th><th>Giá trị</th></tr><tr><td>A</td><td>1/2 + 1/3</td></tr></table>
              Tính giá trị tổng phân số trên?
            </div>
            <div class="answer">
              <label><input type="radio" name="q9103_1" value="opt1">1/2</label>
              <label><input type="radio" name="q9103_1" value="opt2">5/6</label>
              <label><input type="radio" name="q9103_1" value="opt3">2/3</label>
            </div>
          </div>
          <div class="que multichoice" id="question-9103-2">
            <div class="qtext">Tìm giá trị đạo hàm của hàm f(x) = x<sup>2</sup> + 3x tại x = 2?</div>
            <div class="answer">
              <label><input type="radio" name="q9103_2" value="m2_a">7</label>
              <label><input type="radio" name="q9103_2" value="m2_b">5</label>
            </div>
          </div>
          <button type="submit">Finish attempt</button>
        </form>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/processattempt.php' && reqUrl.searchParams.get('id') === '9103' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      lastConsensusMathSubmission = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><div>Grade 10.00 out of 10.00</div><div>Finished</div></body></html>');
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9104') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Đề ôn tập Giải tích Moodle 4</title></head><body>
        <aside class="drawer" data-region="drawer"><h2>Blocks</h2></aside>
        <nav class="navbar"><h2>Navigation</h2></nav>
        <div id="region-main"><main>
          <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9104">
            <div class="que multichoice" id="question-9104-1">
              <div class="qtext">Thủ đô của Việt Nam là gì?</div>
              <div class="answer">
                <label><input type="radio" name="q9104_1" value="hn">Hà Nội</label>
                <label><input type="radio" name="q9104_1" value="hcm">TP.HCM</label>
              </div>
            </div>
            <button type="submit">Finish attempt</button>
          </form>
        </main></div>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9105') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Moodle 4 Quiz Generic Title</title></head><body>
        <aside class="drawer" data-region="drawer"><h2>Blocks</h2></aside>
        <header id="page-header"><div class="page-header-headings"><h1>Đề thi Giải tích Chương 3</h1></div></header>
        <div id="region-main"><main>
          <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9105">
            <div class="que multichoice" id="question-9105-1">
              <div class="qtext">Hành tinh nào gần Mặt Trời nhất?</div>
              <div class="answer">
                <label><input type="radio" name="q9105_1" value="m">Sao Thủy</label>
                <label><input type="radio" name="q9105_1" value="e">Trái Đất</label>
              </div>
            </div>
            <button type="submit">Finish attempt</button>
          </form>
        </main></div>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/attempt.php' && reqUrl.searchParams.get('id') === '9106') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Tối ưu hóa Tự luận</title></head><body>
        <h1>Đề thi Tối ưu hóa</h1>
        <form id="responseform" method="POST" action="/mod/quiz/processattempt.php?id=9106">
          <div class="que essay" id="question-9106-1">
            <div class="qtext">Nêu định nghĩa hàm tựa lồi trên tập C. Tổng của hai hàm tựa lồi có là hàm tựa lồi không?</div>
            <textarea name="q9106_1"></textarea>
          </div>
          <button type="submit">Finish attempt</button>
        </form>
      </body></html>`);
      return;
    }

    if (path === '/mod/quiz/processattempt.php' && ['9104', '9105', '9106'].includes(reqUrl.searchParams.get('id') || '') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const postRaw = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><div>Grade 10.00 out of 10.00</div><div id="posted-raw">${postRaw}</div><div>Finished</div></body></html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  ModelRouter.execute = realExecute;
  if (browser) await browser.close();
  if (server) server.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

function makeCtx(): AgentContext {
  return {
    browser,
    context: {} as any,
    page: {} as any,
    activeUrl: baseUrl,
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
      disablePlaybooks: true
    },
    collectedFindings: {}
  };
}

test('B1-SEC: AST-sandboxed Python Math Verifier computes exact combinatorics/fractions and blocks OS/exec/dunder attacks', async () => {
  const results = await verifyMathExpressionsWithPython([
    { id: 'prob1', code: 'Fraction(comb(5, 2) * comb(7, 1), comb(12, 3))' },
    { id: 'calc1', code: 'round(sum(x**2 for x in range(1, 6)) / 5, 4)' },
    { id: 'atk_import', code: '__import__("os").system("echo pwned")' },
    { id: 'atk_open', code: 'open(".private/secrets.json").read()' },
    { id: 'atk_dunder', code: '().__class__.__bases__[0].__subclasses__()' }
  ]);

  const p1 = results.get('prob1');
  assert.ok(p1 && p1.ok, `Expected prob1 ok, got ${JSON.stringify(p1)}`);
  assert.equal(p1.fraction, '7/22');
  assert.ok(Math.abs((p1.numeric || 0) - 7 / 22) < 1e-6);

  const c1 = results.get('calc1');
  assert.ok(c1 && c1.ok);
  assert.equal(c1.numeric, 11);

  assert.equal(results.get('atk_import')?.ok, false);
  assert.equal(results.get('atk_open')?.ok, false);
  assert.equal(results.get('atk_dunder')?.ok, false);

  assert.equal(doesCandidateMatchVerifiedNumber('Đáp án: 7/22', 7 / 22), true);
  assert.equal(doesCandidateMatchVerifiedNumber('Đáp án: 1/4', 7 / 22), false);
});

test('B1-E2E: Hard math quiz routes with taskTier="hard_math", runs pythonCheck, and auto-corrects Round-1 calculation mistake in Round-2', async () => {
  resetProfileCooldowns();
  const context = await browser.newContext();
  const page = await context.newPage();
  const observedTiers: Array<string | undefined> = [];
  let verifySawPython722 = false;

  ModelRouter.execute = async (req: any, opts: any) => {
    observedTiers.push(opts?.taskTier);
    const payload = JSON.parse(String(req.text || '{}'));
    if (payload.questionsToVerify) {
      const qv = payload.questionsToVerify[0];
      assert.ok(qv.pythonVerifiedResult, 'Round-2 verifier must receive pythonVerifiedResult');
      if (String(qv.pythonVerifiedResult.fraction) === '7/22') {
        verifySawPython722 = true;
      }
      const rightOpt = qv.options.find((o: any) => o.text.includes('7/22'));
      return {
        output: JSON.stringify({
          answers: [{ id: qv.id, selected: [rightOpt.id], reasoning: 'Corrected using Python fraction 7/22', confidence: 0.99 }]
        }),
        initialProfile: 'g',
        finalProfile: 'g',
        modelUsed: 'gemini-2.5-pro',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }

    const q = payload.questions[0];
    // Simulate Round-1 model making arithmetic error (choosing 1/4 despite setting up right pythonCheck!) with high confidence 0.99!
    const wrongOpt = q.options.find((o: any) => o.text.includes('1/4'));
    return {
      output: JSON.stringify({
        answers: [{
          id: q.id,
          selected: [wrongOpt.id],
          pythonCheck: 'Fraction(comb(5, 2) * comb(7, 1), comb(12, 3))',
          reasoning: 'Tổ hợp sai nhẩm 1/4',
          confidence: 0.99
        }]
      }),
      initialProfile: 'g',
      finalProfile: 'g',
      modelUsed: 'gemini-2.5-pro',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx = makeCtx();
    ctx.context = context;
    ctx.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9101`, { waitUntil: 'domcontentloaded' });
    const res = await executeQuizSolve(page, ctx, { autoSubmit: true });

    assert.equal(res.success, true);
    assert.ok(observedTiers.length >= 2, `Expected Round 1 + Round 2 verify, got ${observedTiers.length}; data=${JSON.stringify(res.data)}`);
    assert.ok(observedTiers.every(t => t === 'hard_math'), `Math quiz must route with hard_math tier, got ${observedTiers.join(', ')}`);
    assert.equal(verifySawPython722, true, 'Round-2 must receive Python verified fraction 7/22 even when Round-1 claimed confidence 0.99');
    assert.ok(lastMathSubmission.includes('opt2'), `Submitted radio value should be corrected opt2 (7/22), got: ${lastMathSubmission}`);
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});

test('B2: Extracts .pptx slides + speaker notes, ranks relevant RAG chunks by keyword overlap, and preserves >7000-char IELTS reading passage', async () => {
  // 1. Build a real .pptx OOXML ZIP via Python stdlib
  const pptxPath = join(tempDir, 'lecture-calc.pptx');
  const buildScript = `
import zipfile
path = ${JSON.stringify(pptxPath)}
with zipfile.ZipFile(path, 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>')
    z.writestr('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Giới thiệu môn Giải tích 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
    z.writestr('ppt/slides/slide2.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Định lý Lagrange f(b) - f(a) = f prime(c)(b-a)</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
    z.writestr('ppt/notesSlides/notesSlide2.xml', '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Nhớ điều kiện hàm khả vi trên khoảng mở</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>')
`;
  const pyRes = spawnSync(process.env.AUTOTASK_PYTHON || 'python', ['-c', buildScript], { encoding: 'utf8' });
  assert.equal(pyRes.status, 0, pyRes.stderr);

  const pptxText = await extractLocalDocumentText(pptxPath, 8000);
  assert.ok(pptxText.includes('[Slide 1]'), 'Must label slide 1');
  assert.ok(pptxText.includes('Định lý Lagrange'), 'Must extract slide 2 text');
  assert.ok(pptxText.includes('Notes: Nhớ điều kiện hàm khả vi'), 'Must extract slide 2 speaker notes');

  // 2. Keyword-ranked RAG must retrieve relevant chunk near the end of an 18000-char study doc
  const fillerChunks = Array.from({ length: 18 }, (_, i) => `[Slide ${i + 1}] Khái niệm tổng quan chương ${i + 1}: ` + 'Lý thuyết chung không liên quan Bayes. '.repeat(22));
  const targetChunk = '[Slide 19] Công thức Bayes: P(A|B) = P(B|A)*P(A) / P(B). Ký hiệu chuẩn làm tròn 4 chữ số thập phân.';
  const bigDoc = [...fillerChunks, targetChunk].join('\n\n');
  assert.ok(bigDoc.length > 14000);
  const selected = selectRelevantStudyChunks(bigDoc, 'Áp dụng công thức Bayes tính P(A|B) làm tròn chữ số thập phân', 3200);
  assert.ok(selected && selected.includes('Công thức Bayes'), 'RAG selector must pull relevant tail slide instead of blindly slicing prefix');

  // 3. Long >7000-char Reading passage preserved end-to-end
  const context = await browser.newContext();
  const page = await context.newPage();
  let capturedPassages: string[] = [];

  ModelRouter.execute = async (req: any, opts: any) => {
    const payload = JSON.parse(String(req.text || '{}'));
    capturedPassages = payload.quizContext?.sharedPassages || [];
    const textJoined = capturedPassages.join(' ');
    const foundMarker = textJoined.includes(LONG_READING_MARKER) ? LONG_READING_MARKER : 'TRUNCATED';
    const qs = payload.questions || payload.questionsToVerify || [];
    return {
      output: JSON.stringify({
        answers: qs.map((q: any) => ({ id: q.id, text: foundMarker, confidence: 0.98 }))
      }),
      initialProfile: 'g',
      finalProfile: 'g',
      modelUsed: 'gemini-3-flash-preview',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx = makeCtx();
    ctx.context = context;
    ctx.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9102`, { waitUntil: 'domcontentloaded' });
    const solveRes = await executeQuizSolve(page, ctx, { autoSubmit: true });
    assert.equal(solveRes.success, true);
    assert.ok(capturedPassages[0] && capturedPassages[0].length > 6500, 'Long IELTS passage (>6500 chars) must not be sliced at 1200');
    assert.ok(decodeURIComponent(lastReadingSubmission).includes(LONG_READING_MARKER));
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});

test('B3: Direct <audio> multimodal transcription downloads once for shared URL, respects host allowlist, and injects Listening transcript', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let transcribeCallCount = 0;

  try {
    await page.goto(`${baseUrl}/quiz/listening-no-track`, { waitUntil: 'domcontentloaded' });
    const rawQs = await scanQuestions(page);
    const prepared = await promoteAndPrepareMultimediaQuestions(page, rawQs, {
      allowedHosts: ['127.0.0.1'],
      transcribeAudioFn: async ({ mimeType, base64 }) => {
        transcribeCallCount++;
        assert.equal(mimeType, 'audio/wav');
        assert.ok(base64.length > 50);
        return 'The express train departs from Platform 9B and ticket costs 42 dollars.';
      }
    });

    assert.equal(transcribeCallCount, 1, 'Identical audio URL across 2 listening questions must transcribe ONCE via cache');
    assert.equal(prepared.length, 2);
    assert.ok(prepared[0].prompt.includes('[Transcript / Phụ đề Audio-Video]: The express train departs from Platform 9B'));
    assert.ok(prepared[1].prompt.includes('ticket costs 42 dollars'));

    // Security: disallowed external audio URL must never be fetched
    const untrustedPage = await context.newPage();
    await untrustedPage.setContent(`
      <div class="que multichoice" id="q-ext">
        <div class="qtext">Pick answer</div>
        <audio controls src="https://evil-tracker.example.invalid/steal.mp3"></audio>
        <div class="answer"><label><input type="radio" name="qx" value="1">A</label></div>
      </div>
    `);
    let externalFetchCalled = false;
    const rawExt = await scanQuestions(untrustedPage);
    await promoteAndPrepareMultimediaQuestions(untrustedPage, rawExt, {
      allowedHosts: ['127.0.0.1'],
      transcribeAudioFn: async () => {
        externalFetchCalled = true;
        return 'should not fetch';
      }
    });
    assert.equal(externalFetchCalled, false, 'Audio downloader must refuse unapproved external origin');
    await untrustedPage.close();
  } finally {
    await context.close();
  }
});

test('B4-PARITY: Math/table/sup questions split 1-by-1 with screenshots + deep reasoning, force Round-2 Python check with consensus, and reconcile self-contradiction', async () => {
  resetProfileCooldowns();
  const context = await browser.newContext();
  const page = await context.newPage();
  lastConsensusMathSubmission = '';

  const round1Payloads: Array<{ batchLen: number; hasImg: boolean; effort?: string; maxTokens?: number; tier?: string }> = [];
  const round2Calls: Array<{ qId: string; hasImg: boolean; distinctFrom?: any; hadPyResult: boolean }> = [];
  let sawRound3Reconciliation = false;

  ModelRouter.execute = async (req: any, opts: any) => {
    const payload = JSON.parse(String(req.text || '{}'));
    if (payload.questionsToVerify) {
      const qv = payload.questionsToVerify[0];
      const hadPyResult = Boolean(qv.pythonVerifiedResult);
      round2Calls.push({
        qId: qv.id,
        hasImg: Boolean(req.imageBase64 && req.imageBase64.length > 50),
        distinctFrom: opts?.preferDistinctModelFrom,
        hadPyResult
      });

      if (hadPyResult && String(qv.pythonVerifiedResult.fraction) === '5/6') {
        sawRound3Reconciliation = true;
        const rightOpt = qv.options.find((o: any) => o.text.includes('5/6'));
        return {
          output: JSON.stringify({
            answers: [{ id: qv.id, selected: [rightOpt.id], reasoning: 'Reconciled with Python 5/6', confidence: 0.99 }]
          }),
          initialProfile: 'oai',
          finalProfile: 'oai',
          providerUsed: 'openai',
          modelUsed: 'gpt-5',
          attempts: 1,
          fallbackCount: 0,
          history: []
        };
      }

      if (qv.prompt.includes('1/2 + 1/3')) {
        // Simulate Round 2 supplying pythonCheck yet still leaving wrong provisional choice 1/2 -> triggers Round-3 Python reconciliation
        const wrongOpt = qv.options.find((o: any) => o.text === '1/2');
        return {
          output: JSON.stringify({
            answers: [{
              id: qv.id,
              selected: [wrongOpt.id],
              pythonCheck: 'Fraction(1, 2) + Fraction(1, 3)',
              reasoning: 'Emit pythonCheck for post-Round-2 check',
              confidence: 0.96
            }]
          }),
          initialProfile: 'oai',
          finalProfile: 'oai',
          providerUsed: 'openai',
          modelUsed: 'gpt-5',
          attempts: 1,
          fallbackCount: 0,
          history: []
        };
      }

      const right2 = qv.options.find((o: any) => o.text === '7');
      return {
        output: JSON.stringify({
          answers: [{ id: qv.id, selected: [right2.id], reasoning: '2*2 + 3 = 7 verified', confidence: 0.99 }]
        }),
        initialProfile: 'oai',
        finalProfile: 'oai',
        providerUsed: 'openai',
        modelUsed: 'gpt-5',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }

    const q = payload.questions[0];
    round1Payloads.push({
      batchLen: payload.questions.length,
      hasImg: Boolean(req.imageBase64 && req.imageBase64.length > 50),
      effort: req.reasoningEffort,
      maxTokens: req.maxTokens,
      tier: opts?.taskTier
    });

    if (q.prompt.includes('1/2 + 1/3')) {
      // Q1 wrongly claims 0.99 WITHOUT pythonCheck -> must STILL enter Round 2!
      const wrongOpt = q.options.find((o: any) => o.text === '1/2');
      return {
        output: JSON.stringify({
          answers: [{ id: q.id, selected: [wrongOpt.id], reasoning: 'No python check', confidence: 0.99 }]
        }),
        initialProfile: 'gem',
        finalProfile: 'gem',
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }

    const opt7 = q.options.find((o: any) => o.text === '7');
    return {
      output: JSON.stringify({
        answers: [{ id: q.id, selected: [opt7.id], pythonCheck: '2*2 + 3', reasoning: 'f\'(x)=2x+3 -> 7', confidence: 0.96 }]
      }),
      initialProfile: 'gem',
      finalProfile: 'gem',
      providerUsed: 'gemini',
      modelUsed: 'gemini-2.5-pro',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx = makeCtx();
    ctx.context = context;
    ctx.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9103`, { waitUntil: 'domcontentloaded' });
    const res = await executeQuizSolve(page, ctx, { autoSubmit: true });

    assert.equal(res.success, true);
    assert.equal(round1Payloads.length, 2, 'Two rich-math/table/sup questions must run in separate 1-by-1 batches');
    assert.ok(round1Payloads.every(r => r.batchLen === 1 && r.hasImg && r.effort === 'high' && r.maxTokens === 16384 && r.tier === 'hard_math'));
    assert.ok(round2Calls.length >= 2, 'Q1 (0.99 without pythonCheck) + Q2 must be verified individually in Round 2 with screenshots');
    assert.ok(round2Calls.some(c => c.hasImg && c.distinctFrom?.provider === 'gemini' && c.distinctFrom?.model === 'gemini-2.5-pro'));
    assert.equal(sawRound3Reconciliation, true, 'Post-Round-2 Python mismatch (5/6 vs 1/2) must trigger Round-3 reconciliation');
    assert.ok(lastConsensusMathSubmission.includes('opt2'), `Submitted radio must be reconciled 5/6 (opt2), got: ${lastConsensusMathSubmission}`);
    assert.ok(lastConsensusMathSubmission.includes('m2_a'), `Q2 submitted radio must be m2_a (7), got: ${lastConsensusMathSubmission}`);
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});

test('B4-VISION-FALLBACK: Round-2 retries gracefully with text+LaTeX when imageBase64 verifier route throws', async () => {
  resetProfileCooldowns();
  const context = await browser.newContext();
  const page = await context.newPage();
  let verifyAttemptWithImg = 0;
  let verifyAttemptTextFallback = 0;

  ModelRouter.execute = async (req: any, opts: any) => {
    const payload = JSON.parse(String(req.text || '{}'));
    if (payload.questionsToVerify) {
      if (opts?.requiresVision && req.imageBase64) {
        verifyAttemptWithImg++;
        throw new Error('Mock vision capability unavailable on verifier');
      }
      verifyAttemptTextFallback++;
      const qv = payload.questionsToVerify[0];
      const rightOpt = qv.options.find((o: any) => o.text === '5/6') || qv.options[0];
      return {
        output: JSON.stringify({
          answers: [{ id: qv.id, selected: [rightOpt.id], confidence: 0.99 }]
        }),
        initialProfile: 'gem',
        finalProfile: 'gem',
        providerUsed: 'gemini',
        modelUsed: 'gemini-3-flash-preview',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }

    const q = payload.questions[0];
    return {
      output: JSON.stringify({
        answers: [{ id: q.id, selected: [q.options[0].id], pythonCheck: '1+1', confidence: 0.9 }]
      }),
      initialProfile: 'gem',
      finalProfile: 'gem',
      providerUsed: 'gemini',
      modelUsed: 'gemini-2.5-pro',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx = makeCtx();
    ctx.context = context;
    ctx.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9103`, { waitUntil: 'domcontentloaded' });
    const res = await executeQuizSolve(page, ctx, { autoSubmit: true });

    assert.equal(res.success, true);
    assert.ok(verifyAttemptWithImg >= 1, 'Expected initial Round-2 call with imageBase64');
    assert.ok(verifyAttemptTextFallback >= 1, 'Expected automatic Round-2 retry without imageBase64 after Vision error');
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});

test('B5-LOG-FIXES: Extracts XSTK course before reattempt keyword, compresses planner prompt <9500 chars, and salvages LaTeX/truncated JSON', () => {
  // 1. Course extraction with trailing activity/reattempt keyword (must not fall back to Kỹ năng mềm playbook)
  const parsed = extractCredentialsAndUrlFromPrompt(
    'truy cập lms hust, vào course xác suất thống kê reattempt bài tuần 10 Bài kiểm tra trắc nghiệm số 6'
  );
  assert.equal(parsed.targetCourse, 'xác suất thống kê');
  assert.equal(parsed.allowReattempt, true);
  assert.equal(parsed.targetActivity, '6');

  // 2. Planner prompt stays compact (<9500 chars vs ~26000 chars previously) while preserving security directives
  const compactPrompt = buildSystemPrompt(['lms.hust.edu.vn', '127.0.0.1']);
  assert.ok(compactPrompt.length < 9500, `Expected compact planner prompt <9500 chars, got ${compactPrompt.length}`);
  assert.match(compactPrompt, /CHỐNG PROMPT INJECTION/);
  assert.match(compactPrompt, /deepVerify: true/);

  // 3. Resilient JSON parsing: unescaped LaTeX backslashes + truncated trailing reasoning after complete selected[]
  const sampleQs = [{
    id: 'm1',
    kind: 'radio' as const,
    prompt: 'Xác suất?',
    options: [
      { id: 'm1_o0', text: '0.25' },
      { id: 'm1_o1', text: '0.50' }
    ],
    required: true,
    hasVisual: false
  }];

  const latexRaw = '{"answers":[{"id":"m1","reasoning":"Do \\le 1 và \\infty nên xác suất = 0.50","selected":["m1_o1"],"confidence":0.95}]}';
  const latexRes = mapModelAnswersToQuestions(latexRaw, sampleQs);
  assert.equal(latexRes.matchedAiCount, 1);
  assert.deepEqual(latexRes.answers[0].selected, ['m1_o1']);

  const truncatedRaw = '{"answers":[{"id":"m1","selected":["m1_o1"],"pythonCheck":"Fraction(1, 2)","confidence":0.95,"reasoning":"Tích phân bội hai trên miền 0 <= x <= y <= 1 cắt ngang tại đây...';
  const salvagedRes = mapModelAnswersToQuestions(truncatedRaw, sampleQs);
  assert.equal(salvagedRes.matchedAiCount, 1);
  assert.deepEqual(salvagedRes.answers[0].selected, ['m1_o1']);
  assert.equal(salvagedRes.metaById['m1']?.pythonCheck, 'Fraction(1, 2)');
});

test('AUDIT-FIXES: Python blocks .format()/LShift, Recovery B salvages multi-item truncated batch, and Moodle 4 ignores drawer Blocks heading', async () => {
  // 1. Python math sandbox hardening: block .format() attribute traversal and giant LShift RAM DoS
  const atkResults = await verifyMathExpressionsWithPython([
    { id: 'atk_fmt', code: '"{0.__class__}".format(1)' },
    { id: 'atk_lshift', code: '1 << 10000000' }
  ]);
  assert.equal(atkResults.get('atk_fmt')?.ok, false, 'Python sandbox must reject .format() calls');
  assert.ok(atkResults.get('atk_fmt')?.error, 'Blocked .format() should emit error details');
  assert.equal(atkResults.get('atk_lshift')?.ok, false, 'Python sandbox must reject giant left-shift constants');
  assert.ok(atkResults.get('atk_lshift')?.error, 'Blocked LShift should emit error details');

  // 2. Multi-item truncated batch salvage: 2 complete objects + 1 trailing partially truncated item with closed selected[]
  const truncatedBatchRaw =
    '{"answers":[{"id":"q1","selected":["q1_o1"],"reasoning":"ok"},' +
    '{"id":"q2","selected":["q2_o2"],"pythonCheck":"2+2","reasoning":"good"},' +
    '{"id":"q3","selected":["q3_o0"],"confidence":0.91,"reasoning":"Tích phân bị cắt cụt giữa chừng...';
  const parsedBatch = parseAnswersListFromRaw(truncatedBatchRaw);
  assert.equal(parsedBatch.parsedList.length, 3, `Expected 3 salvaged items from truncated batch, got ${parsedBatch.parsedList.length}`);
  assert.deepEqual(parsedBatch.parsedList.map((x: any) => x.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(parsedBatch.parsedList[2].selected, ['q3_o0']);

  // 3. Moodle 4 drawer <h2>Blocks</h2> must be ignored in favor of entryTitle or real page-header heading
  resetProfileCooldowns();
  const context = await browser.newContext();
  const page = await context.newPage();
  const seenPromptTitles: string[] = [];

  ModelRouter.execute = async (req: any) => {
    const payload = JSON.parse(String(req.text || '{}'));
    const qt = payload.quizContext?.quizTitle ?? payload.quizTitle;
    if (typeof qt === 'string') seenPromptTitles.push(qt);
    const qs = payload.questions || payload.questionsToVerify || [];
    const answers = qs.map((q: any) => ({
      id: q.id,
      selected: [q.options[0].id],
      confidence: 0.96
    }));
    return {
      output: JSON.stringify({ answers }),
      initialProfile: 'g',
      finalProfile: 'g',
      modelUsed: 'gemini-3-flash-preview',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx1 = makeCtx();
    ctx1.context = context;
    ctx1.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9104`, { waitUntil: 'domcontentloaded' });
    const res1 = await executeQuizSolve(page, ctx1, { autoSubmit: true });
    assert.equal(res1.success, true);
    assert.equal(seenPromptTitles[0], 'Đề ôn tập Giải tích Moodle 4');
    assert.notEqual(res1.data?.quizTitle, 'Blocks');

    const ctx2 = makeCtx();
    ctx2.context = context;
    ctx2.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9105`, { waitUntil: 'domcontentloaded' });
    const res2 = await executeQuizSolve(page, ctx2, { autoSubmit: true });
    assert.equal(res2.success, true);
    assert.equal(seenPromptTitles[seenPromptTitles.length - 1], 'Đề thi Giải tích Chương 3');
    assert.notEqual(res2.data?.quizTitle, 'Blocks');
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});

test('MATH-OPTIMIZATION: Broad math classifier, SciPy linprog & SymPy hessian in sandbox, LaTeX control-char repair, truncated essay recovery & Round-2 shrinkage guard', async () => {
  // 1. Optimization/proof topics must all classify as hard_math
  assert.equal(isHardMathPrompt('Nêu định nghĩa hàm tựa lồi trên tập C. Tổng của hai hàm tựa lồi có là hàm tựa lồi không?'), true);
  assert.equal(isHardMathPrompt('Viết bài toán đối ngẫu của bài toán quy hoạch tuyến tính trên.'), true);
  assert.equal(isHardMathPrompt('Phát biểu và viết bài toán nới lỏng cho bài toán balo 0-1.'), true);
  assert.equal(isHardMathPrompt('Phát biểu và chứng minh điều kiện để bài toán vận tải có nghiệm tối ưu.'), true);
  assert.equal(isHardMathPrompt('Bài toán max f(x) = (x1-1)^2 + (x2-2)^2 + x2^4 có phải bài toán tối ưu lồi không?'), true);
  assert.equal(isHardMathPrompt('What is the capital city of France?'), false);

  // 2. SciPy linprog (no desktop/secrets.py shadowing) & SymPy hessian + trailing print() still resolves `result`
  const pyOpt = await verifyMathExpressionsWithPython([
    {
      id: 'lp_dual',
      code: 'from scipy.optimize import linprog\nr = linprog(c=[-6, 2, -4], A_ub=[[2, -4, 2], [1, -2, 3]], b_ub=[8, 7], bounds=[(0, None), (None, 0), (0, None)], method="highs")\nprint("primal:", [round(float(v), 4) for v in r.x])\nresult = round(float(-r.fun), 4)'
    },
    {
      id: 'cvx_hessian',
      code: 'x1, x2 = symbols("x1 x2")\nf = (x1 - 1)**2 + (x2 - 2)**2 + x2**4\nH = hessian(f, (x1, x2))\nresult = max(((a - 1)**2 + (b - 2)**2 + b**4 for a, b in [(0, 0), (4, 0), (0, 6)]))\nprint("H_diag:", H[0, 0], H[1, 1])'
    }
  ]);
  assert.equal(pyOpt.get('lp_dual')?.ok, true, `Expected SciPy linprog ok, got ${JSON.stringify(pyOpt.get('lp_dual'))}`);
  assert.equal(pyOpt.get('lp_dual')?.numeric, 24);
  assert.equal(pyOpt.get('cvx_hessian')?.ok, true, `Expected SymPy hessian ok, got ${JSON.stringify(pyOpt.get('cvx_hessian'))}`);
  assert.equal(pyOpt.get('cvx_hessian')?.numeric, 1313);

  // 3. Repair JSON-eaten LaTeX control chars & recover truncated unclosed long essay
  const sampleEssayQs = [{
    id: 'eq1',
    kind: 'textarea' as const,
    prompt: 'Giải bài toán đối ngẫu',
    options: [],
    required: true,
    hasVisual: false
  }];
  // Simulate JSON string containing unescaped \f (\forall, \frac), \b (\binom), \t (\times), \n (\neq)
  const mangledJson = '{"answers":[{"id":"eq1","text":"Ta co \\forall x \\neq 0 thi \\frac{1}{2} \\times \\binom{5}{2} = 5","confidence":0.95}]}';
  const repaired = mapModelAnswersToQuestions(mangledJson, sampleEssayQs);
  assert.equal(repaired.matchedAiCount, 1);
  assert.ok(repaired.answers[0].text?.includes('\\forall'), `Expected repaired \\forall, got ${repaired.answers[0].text}`);
  assert.ok(repaired.answers[0].text?.includes('\\frac{1}{2}'), `Expected repaired \\frac, got ${repaired.answers[0].text}`);
  assert.ok(repaired.answers[0].text?.includes('\\times'), `Expected repaired \\times, got ${repaired.answers[0].text}`);
  assert.ok(repaired.answers[0].text?.includes('\\binom{5}{2}'), `Expected repaired \\binom, got ${repaired.answers[0].text}`);
  assert.ok(repaired.answers[0].text?.includes('\\neq'), `Expected repaired \\neq, got ${repaired.answers[0].text}`);

  const truncatedEssayRaw =
    '{"answers":[{"id":"eq1","confidence":0.94,"text":"Cho tap loi C trong khong gian R^n. Ham f goi la tua loi neu voi moi x, y thuoc C va lambda trong [0,1] ta co f(lambda*x + (1-lambda)*y) <= max(f(x), f(y))';
  const recoveredEssay = parseAnswersListFromRaw(truncatedEssayRaw);
  assert.equal(recoveredEssay.parsedList.length, 1);
  assert.match(recoveredEssay.parsedList[0].text, /^Cho tap loi C/);

  // 4. Round-2 must classify quasiconvex essay as hard_math and NEVER shrink a long Round-1 essay with a short confirmation
  resetProfileCooldowns();
  const context = await browser.newContext();
  const page = await context.newPage();
  const fullEssay = `${'Định nghĩa: Hàm f trên tập lồi C được gọi là tựa lồi nếu mọi tập mức dưới đều lồi. Tổng hai hàm tựa lồi KHÔNG nhất thiết tựa lồi. Phản ví dụ: f(x)=x^3, g(x)=-x đều đơn điệu nên tựa lồi, nhưng h(x)=x^3-x có h(-1)=0, h(0.5)=-0.375, tại trung điểm -0.25 ta có h(-0.25)=0.234 > 0. '}FULL_QUASICONVEX_PROOF_MARKER`;
  const seenTiers: Array<string | undefined> = [];

  ModelRouter.execute = async (req: any, opts: any) => {
    seenTiers.push(opts?.taskTier);
    const payload = JSON.parse(String(req.text || '{}'));
    if (payload.questionsToVerify) {
      const qv = payload.questionsToVerify[0];
      return {
        output: JSON.stringify({
          answers: [{ id: qv.id, text: 'Đáp án vòng 1 đúng.', reasoning: 'Kiểm chứng hợp lệ.', confidence: 0.99 }]
        }),
        initialProfile: 'g',
        finalProfile: 'g',
        modelUsed: 'gemini-3.6-flash',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }
    const q = payload.questions[0];
    return {
      output: JSON.stringify({
        answers: [{ id: q.id, text: fullEssay, reasoning: 'Đã chứng minh kèm phản ví dụ.', confidence: 0.94 }]
      }),
      initialProfile: 'g',
      finalProfile: 'g',
      modelUsed: 'gemini-3-flash-preview',
      attempts: 1,
      fallbackCount: 0,
      history: []
    };
  };

  try {
    const ctx = makeCtx();
    ctx.context = context;
    ctx.page = page;
    await page.goto(`${baseUrl}/mod/quiz/attempt.php?id=9106`, { waitUntil: 'domcontentloaded' });
    const res = await executeQuizSolve(page, ctx, { autoSubmit: true });
    assert.equal(res.success, true);
    assert.ok(seenTiers.length >= 2 && seenTiers.every(t => t === 'hard_math'), `Expected Round 1+2 both hard_math, got ${seenTiers.join(',')}`);
    const postedRaw = await page.locator('#posted-raw').textContent();
    assert.ok(postedRaw && decodeURIComponent(postedRaw).includes('FULL_QUASICONVEX_PROOF_MARKER'), 'Round-2 confirmation must not shrink long Round-1 essay');
  } finally {
    ModelRouter.execute = realExecute;
    await context.close();
  }
});
