import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { detectPlatform } from '../src/platforms.js';
import { discoverActivities } from '../src/discovery.js';
import { observeFamiTopics, observeScore } from '../src/observations.js';
import { scanQuestions } from '../src/scanner.js';
import { executeTask } from '../src/main.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { loadCheckpoint, clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig, Question } from '../src/types.js';

let browser: Browser;

async function createFamiContext(routes: Record<string, string>): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (routes[url]) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: routes[url] });
    }
    return route.abort();
  });
  return ctx;
}

const FAMI_ROUTES: Record<string, string> = {
  // 1. Trang lớp học (Classroom page)
  'https://fami.hust.edu.vn/sohoa/phong-hoc': `<!DOCTYPE html><html lang="vi"><head><title>FAMI - Phòng học Số hóa</title></head><body>
    <header class="navbar"><form role="search"><input type="search" placeholder="Tìm lớp học..."></form></header>
    <main>
      <h1>Lớp học: Giải tích I (MI1111 - 154321)</h1>
      <div class="due-date">Hạn nộp: 15/11/2026 23:59</div>
      <ul>
        <li><a href="https://fami.hust.edu.vn/sohoa/tai-lieu/chu-de-1">Tài liệu học tập Chủ đề 1</a></li>
        <li><a href="https://fami.hust.edu.vn/sohoa/luyen-tap/101">Bài luyện tập Chủ đề 1</a></li>
        <li><a href="https://fami.hust.edu.vn/sohoa/thi-lt">Danh sách kiểm tra lý thuyết</a></li>
        <li><a href="https://external.unapproved.org/leak">Liên kết ngoài</a></li>
      </ul>
    </main></body></html>`,

  // 2. Danh sách chủ đề (Topic inventory table)
  'https://fami.hust.edu.vn/sohoa/thi-lt': `<!DOCTYPE html><html lang="vi"><head><title>FAMI - Danh sách chủ đề</title></head><body>
    <table>
      <thead><tr><th>Lớp</th><th>Mã HP</th><th>Tên chủ đề</th><th>Mô tả</th><th>Đọc</th><th>Thi</th><th>Số câu</th><th>Điểm tối đa</th><th>Điểm</th><th>Thao tác</th></tr></thead>
      <tbody>
        <tr><td>154321</td><td>MI1111</td><td>CĐ1 - Giới hạn dãy số</td><td>Lý thuyết tuần 1</td><td>15</td><td>10</td><td>5</td><td>10</td><td></td><td>Vào đọc bài</td></tr>
        <tr><td>154321</td><td>MI1111</td><td>CĐ2 - Hàm số liên tục</td><td>Lý thuyết tuần 2</td><td>15</td><td>10</td><td>5</td><td>10</td><td>9,00/10</td><td>Đã hoàn thành</td></tr>
      </tbody>
    </table></body></html>`,

  // 3. Tài liệu học tập (Study materials - read-only, 0 questions)
  'https://fami.hust.edu.vn/sohoa/tai-lieu/chu-de-1': `<!DOCTYPE html><html lang="vi"><head><title>Tài liệu Chủ đề 1</title></head><body>
    <nav role="navigation"><a href="/sohoa/phong-hoc">Quay lại lớp học</a></nav>
    <article><h2>Bài giảng: Giới hạn của dãy số thực</h2><p>Định nghĩa dãy hội tụ và tiêu chuẩn Cauchy.</p></article>
  </body></html>`,

  // 4. Bài luyện tập được cho phép (Permitted practice exercise)
  'https://fami.hust.edu.vn/sohoa/luyen-tap/101': `<!DOCTYPE html><html lang="vi"><head><title>Bài luyện tập CĐ1</title></head><body>
    <div class="question" data-question="f1">
      <h3>Câu 1: Giới hạn của dãy 1/n khi n tiến ra vô cùng bằng bao nhiêu?</h3>
      <label><input type="radio" name="q_lim" value="0">0</label>
      <label><input type="radio" name="q_lim" value="1">1</label>
      <label><input type="radio" name="q_lim" value="inf">Dương vô cùng</label>
    </div>
    <div class="question" data-question="f2">
      <h3>Câu 2: Dãy hội tụ thì luôn:</h3>
      <select name="q_bound" aria-label="Tính chất dãy hội tụ">
        <option value="">Chọn đáp án...</option>
        <option value="bounded">Bị chặn</option>
        <option value="unbounded">Không bị chặn</option>
      </select>
    </div>
    <button type="button">Nộp bài</button>
  </body></html>`,

  // 5. Cổng thời gian đọc 15 phút (15-minute reading gate)
  'https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5514': `<!DOCTYPE html><html lang="vi"><head><title>Cổng thời gian đọc FAMI</title></head><body>
    <div class="alert-warning">
      Bạn đọc quá nhanh. Hãy xem lại tài liệu trước khi có thể bắt đầu thi. Thời gian đọc còn lại: 15 phút.
    </div></body></html>`,

  // 6. Bài chưa mở (Scheduled / not-yet-open gate)
  'https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5599': `<!DOCTYPE html><html lang="vi"><head><title>Bài chưa mở</title></head><body>
    <div class="generalbox">Bài kiểm tra chưa mở. Chưa đến thời gian làm bài theo lịch của giảng viên.</div>
  </body></html>`,

  // 7. Đồng hồ bài kiểm tra (Active quiz timer - informational, never manipulated)
  'https://fami.hust.edu.vn/sohoa/luyen-tap/102': `<!DOCTYPE html><html lang="vi"><head><title>Bài luyện tập có đồng hồ</title></head><body>
    <div class="timer-banner">Thời gian còn lại: 09:30</div>
    <div class="question" data-question="t1">
      <h3>Câu 1: Đạo hàm của x^2 là:</h3>
      <input type="text" name="deriv" aria-label="Đạo hàm của x^2">
    </div>
    <button type="button">Nộp bài</button>
  </body></html>`,

  // 8a. Kết quả đã công bố (Published single-attempt result)
  'https://fami.hust.edu.vn/sohoa/ket-qua/5502': `<!DOCTYPE html><html lang="vi"><head><title>Kết quả bài kiểm tra</title></head><body>
    <h2>Kết quả Chủ đề 2</h2>
    <p>Điểm đạt: 9,00/10</p>
    <p>Bạn đã hoàn thành bài kiểm tra này. Không còn lượt làm bài.</p>
  </body></html>`,

  // 8b. Màn hình đăng nhập / SSO FAMI (Authentication barrier)
  'https://fami.hust.edu.vn/login': `<!DOCTYPE html><html lang="vi"><head><title>Đăng nhập FAMI Số hóa</title></head><body>
    <form action="/login" method="post">
      <h2>Đăng nhập hệ thống Số hóa HUST</h2>
      <input type="text" name="email" placeholder="Mã số SV / Email">
      <input type="password" name="password" placeholder="Mật khẩu">
      <button type="submit">Đăng nhập</button>
    </form></body></html>`
};

describe('Phase 5 — HUST Số hóa / FAMI Compatibility & Access-Gate Integrity', () => {
  const origExecute = ModelRouter.execute;
  const famiConfig: AppConfig = {
    allowedHosts: ['fami.hust.edu.vn'],
    approvedForAIUse: true,
    operationMode: 'PRACTICE_ASSISTED',
    parallelTabs: 1,
    authUrls: [],
    deadlinePages: [],
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
  };

  before(async () => {
    browser = await chromium.launch({ headless: true });
    ModelRouter.execute = (async (req: any) => {
      const parsed = JSON.parse(req.text) as { questions: Question[] };
      const answers = parsed.questions.map(q => {
        if (['radio', 'checkbox', 'select'].includes(q.kind)) {
          const best = q.options.find(o => o.text === '0' || /Bị chặn/i.test(o.text)) || q.options[0];
          return { id: q.id, selected: [best.id], confidence: 0.92 };
        }
        return { id: q.id, text: '2x', confidence: 0.95 };
      });
      return { output: JSON.stringify({ answers }), initialProfile: 'fami-test', finalProfile: 'fami-test', attempts: 1, fallbackCount: 0, history: [] };
    }) as typeof ModelRouter.execute;
  });

  after(async () => {
    ModelRouter.execute = origExecute;
    await browser?.close();
  });

  test('FAMI-01: Classroom page & Topic list discovery are read-only, extract deadlines & topic rows, and stay inside fami.hust.edu.vn', async () => {
    const ctx = await createFamiContext(FAMI_ROUTES);
    try {
      const page = await ctx.newPage();
      await page.goto('https://fami.hust.edu.vn/sohoa/thi-lt');
      assert.equal(await detectPlatform(page, famiConfig.allowedHosts), 'fami');

      const topics = await observeFamiTopics(page);
      assert.equal(topics.length, 2);
      assert.equal(topics[0].topic, 'CĐ1 - Giới hạn dãy số');
      assert.equal(topics[0].readingMinutes, 15);
      assert.equal(topics[0].examMinutes, 10);
      assert.equal(topics[0].questionCount, 5);
      assert.equal(topics[1].topic, 'CĐ2 - Hàm số liên tục');
      await page.close();

      const report = await discoverActivities(ctx, ['https://fami.hust.edu.vn/sohoa/phong-hoc'], ['fami.hust.edu.vn'], 5, '+07:00');
      assert.ok(report.activities.some(a => a.url === 'https://fami.hust.edu.vn/sohoa/luyen-tap/101' && a.kind === 'quiz'));
      assert.ok(report.activities.every(a => new URL(a.url).hostname === 'fami.hust.edu.vn'));
      assert.equal(report.deadlines.length, 1);
      assert.ok(report.deadlines[0].dueAt.startsWith('2026-11-15'));
    } finally {
      await ctx.close();
    }
  });

  test('FAMI-02: Study materials page extracts 0 false questions and is never falsely marked READY_FOR_REVIEW', async () => {
    const ctx = await createFamiContext(FAMI_ROUTES);
    const taskId = 'fami-doc-1';
    await clearCheckpoint(taskId);
    try {
      const p = await ctx.newPage();
      await p.goto('https://fami.hust.edu.vn/sohoa/tai-lieu/chu-de-1');
      assert.deepEqual(await scanQuestions(p), []);
      await p.close();

      const res = await executeTask(ctx, { id: taskId, url: 'https://fami.hust.edu.vn/sohoa/tai-lieu/chu-de-1', aiPermitted: true }, famiConfig);
      assert.equal(res.questionsFound, 0);
      assert.equal(res.questionsFilled, 0);
      assert.notEqual(res.status, 'READY_FOR_REVIEW');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('FAMI-03: Permitted practice exercise fills answers (excluding Vietnamese select placeholder) and stops before Nộp bài', async () => {
    const ctx = await createFamiContext(FAMI_ROUTES);
    const taskId = 'fami-practice-101';
    await clearCheckpoint(taskId);
    try {
      const res = await executeTask(ctx, { id: taskId, url: 'https://fami.hust.edu.vn/sohoa/luyen-tap/101', aiPermitted: true }, famiConfig);
      assert.equal(res.questionsFound, 2);
      assert.equal(res.questionsFilled, 2);
      assert.equal(res.status, 'READY_FOR_REVIEW');
      assert.equal(await res.page!.locator('input[name="q_lim"][value="0"]').isChecked(), true);
      assert.equal(await res.page!.locator('select[name="q_bound"]').inputValue(), 'bounded');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('FAMI-04: 15-minute reading gate and Not-Yet-Open gate yield WAITING_FOR_ACCESS without bypass or synthetic reading', async () => {
    const ctx = await createFamiContext(FAMI_ROUTES);
    try {
      await clearCheckpoint('fami-gate-read');
      const resRead = await executeTask(
        ctx,
        { id: 'fami-gate-read', url: 'https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5514', aiPermitted: true },
        famiConfig
      );
      assert.equal(resRead.status, 'WAITING_FOR_ACCESS');
      assert.equal(resRead.accessGate?.kind, 'FAMI_READING');
      assert.equal(resRead.accessGate?.remainingSeconds, 900);
      assert.equal(resRead.questionsFilled, 0);

      const cp = await loadCheckpoint('fami-gate-read');
      assert.equal(cp?.status, 'WAITING_FOR_ACCESS');

      await clearCheckpoint('fami-gate-closed');
      const resClosed = await executeTask(
        ctx,
        { id: 'fami-gate-closed', url: 'https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5599', aiPermitted: true },
        famiConfig
      );
      assert.equal(resClosed.status, 'WAITING_FOR_ACCESS');
      assert.equal(resClosed.accessGate?.kind, 'NOT_YET_OPEN');
      assert.equal(resClosed.questionsFilled, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint('fami-gate-read');
      await clearCheckpoint('fami-gate-closed');
    }
  });

  test('FAMI-05: Active quiz timer is reported informationally without clock tampering; published results -> NEEDS_REVIEW; login -> WAITING_FOR_AUTH', async () => {
    const ctx = await createFamiContext(FAMI_ROUTES);
    try {
      // Active quiz timer on permitted practice
      await clearCheckpoint('fami-timer-1');
      const resTimer = await executeTask(
        ctx,
        { id: 'fami-timer-1', url: 'https://fami.hust.edu.vn/sohoa/luyen-tap/102', aiPermitted: true },
        famiConfig
      );
      assert.equal(resTimer.status, 'READY_FOR_REVIEW');
      assert.equal(resTimer.questionsFilled, 1);
      assert.ok(resTimer.warnings.some(w => w.includes('QUIZ_TIMER') && w.includes('đồng hồ của website tiếp tục chạy')));

      // Published results screen (no remaining attempts)
      await clearCheckpoint('fami-score-1');
      const resScore = await executeTask(
        ctx,
        { id: 'fami-score-1', url: 'https://fami.hust.edu.vn/sohoa/ket-qua/5502', aiPermitted: true },
        famiConfig
      );
      assert.equal(resScore.status, 'NEEDS_REVIEW');
      assert.equal(resScore.scoreObserved, 'Điểm đạt: 9,00/10');
      assert.equal(resScore.questionsFilled, 0);
      assert.ok(observeScore);

      // Login screen -> WAITING_FOR_AUTH with 0 scanned questions
      await clearCheckpoint('fami-auth-1');
      const resAuth = await executeTask(
        ctx,
        { id: 'fami-auth-1', url: 'https://fami.hust.edu.vn/login', aiPermitted: true },
        famiConfig
      );
      assert.equal(resAuth.status, 'WAITING_FOR_AUTH');
      assert.equal(resAuth.questionsFound, 0);
      assert.equal(resAuth.questionsFilled, 0);
    } finally {
      await ctx.close();
      await clearCheckpoint('fami-timer-1');
      await clearCheckpoint('fami-score-1');
      await clearCheckpoint('fami-auth-1');
    }
  });
});
