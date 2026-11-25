/** Phase 8G Audit Cleanup — Reproduction Test for False Positive Question on Moodle Dashboard
 *
 * Verifies:
 * 1. Moodle Dashboard (https://lms.hust.edu.vn/my/) with course filter dropdowns and search inputs
 *    must yield 0 questions (questionsFound: 0).
 * 2. Moodle Course View (https://lms.hust.edu.vn/course/view.php) without div.que blocks yields 0 questions.
 * 3. Moodle Quiz Attempt with div.que question blocks continues to extract all real questions accurately.
 * 4. hasQuestions returns false on Moodle Dashboard.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { hasQuestions } from '../src/interaction.js';

describe('Phase 8G — Moodle Dashboard False Positive Elimination', () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
  });

  test('FALSE-POS-01: Moodle Dashboard with course filter select and search input yields 0 questions', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Mock HTML resembling Moodle 4.x / HUST LMS Dashboard (/my/)
    const dashboardHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <title>Dashboard | LMS HUST</title>
  <meta name="generator" content="Moodle 4.1">
</head>
<body id="page-my-index" class="format-site path-my chrome dir-ltr lang-vi yui-skin-sam yui3-skin-sam pagelayout-mydashboard">
  <header role="banner" class="navbar fixed-top navbar-light bg-white navbar-expand moodle-has-zindex">
    <div class="primary-navigation">Navigation Bar</div>
  </header>
  <div id="page" class="container-fluid">
    <div id="page-content" class="row">
      <section id="region-main" class="col-12">
        <div class="block-myoverview block card mb-3" data-block="myoverview">
          <div class="card-body p-3">
            <h5 class="card-title d-inline">Khóa học của tôi</h5>
            <!-- Course Filter and Sorting Controls on Moodle Dashboard -->
            <div data-region="courses-view" class="courses-view-course-classification">
              <div class="row mb-2">
                <div class="col-md-6">
                  <label for="filter-category" class="sr-only">Lọc theo danh mục</label>
                  <select id="filter-category" class="custom-select" data-action="filter-category">
                    <option value="all" selected>Tất cả khóa học</option>
                    <option value="inprogress">Đang diễn ra</option>
                    <option value="past">Đã kết thúc</option>
                  </select>
                </div>
                <div class="col-md-6">
                  <input type="text" class="form-control" placeholder="Tìm kiếm khóa học" data-action="search-input">
                </div>
              </div>
              <div class="dashboard-card-deck">
                <div class="card dashboard-card" data-course-id="101">
                  <div class="card-body course-info-container">
                    <h3 class="coursename"><span class="multiline">BL-ED3220 - Kỹ năng mềm</span></h3>
                  </div>
                </div>
                <div class="card dashboard-card" data-course-id="102">
                  <div class="card-body course-info-container">
                    <h3 class="coursename"><span class="multiline">BL-MI2020 - Xác suất thống kê</span></h3>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</body>
</html>`;

    // Use route to simulate official Moodle Dashboard URL
    await page.route('https://lms.hust.edu.vn/my/', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: dashboardHtml
      });
    });

    try {
      await page.goto('https://lms.hust.edu.vn/my/', { waitUntil: 'domcontentloaded' });

      // Scan questions on Dashboard
      const questions = await scanQuestions(page);
      assert.equal(questions.length, 0, `Dashboard must have 0 questions, but found ${questions.length}: ${JSON.stringify(questions)}`);

      // Verify hasQuestions returns false
      const hasQ = await hasQuestions(page, ['lms.hust.edu.vn']);
      assert.equal(hasQ, false, 'hasQuestions must return false on Moodle Dashboard');
    } finally {
      await ctx.close();
    }
  });

  test('FALSE-POS-02: Moodle quiz attempt with real div.que blocks continues to extract questions correctly', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const quizAttemptHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>Quiz Attempt | LMS HUST</title></head>
<body id="page-mod-quiz-attempt" class="path-mod-quiz">
  <div id="q1" class="que multichoice deferredfeedback notyetanswered">
    <div class="info"><h3 class="no">Question 1</h3></div>
    <div class="content">
      <div class="formulation clearfix">
        <h4 class="accesshide">Question text</h4>
        <div class="qtext"><p>What is 2 + 2?</p></div>
        <div class="answer">
          <div class="r0"><input type="radio" name="q1:1_answer" value="0" id="q1_a0"><label for="q1_a0">3</label></div>
          <div class="r1"><input type="radio" name="q1:1_answer" value="1" id="q1_a1"><label for="q1_a1">4</label></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

    await page.route('https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=50&page=0', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: quizAttemptHtml
      });
    });

    try {
      await page.goto('https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=50&page=0', { waitUntil: 'domcontentloaded' });
      const questions = await scanQuestions(page);
      assert.equal(questions.length, 1, 'Must find exactly 1 real question in div.que block');
      assert.equal(questions[0].kind, 'radio');
      assert.ok(questions[0].prompt.includes('What is 2 + 2?'));
    } finally {
      await ctx.close();
    }
  });
});
