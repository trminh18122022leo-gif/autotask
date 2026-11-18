import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { solveQuestions } from '../src/ai.js';
import type { AppConfig, Question } from '../src/types.js';

test.describe('Phase 2 — Image, Math and Vision E2E Suite', () => {
  let browser: Browser;
  let page: Page;

  test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  });

  test.after(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    page = await browser.newPage();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('MATH-01: MathML subset conversion accurately transforms complex expressions into TeX', async () => {
    const html = `
      <html><body>
        <div class="que multichoice" id="question-901-1">
          <div class="formulation">
            <div class="qtext">
              Compute:
              <math>
                <mfrac>
                  <mrow><mn>3</mn><mi>x</mi></mrow>
                  <mrow><mn>4</mn><mi>y</mi></mrow>
                </mfrac>
              </math>
              plus
              <math>
                <msubsup>
                  <mi>x</mi>
                  <mn>1</mn>
                  <mn>2</mn>
                </msubsup>
              </math>
              and
              <math>
                <mroot>
                  <mi>y</mi>
                  <mn>3</mn>
                </mroot>
              </math>
            </div>
            <div class="answer">
              <div><input type="radio" name="q901:1_answer" id="q901_1_a" value="0"><label for="q901_1_a">Option A</label></div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    const prompt = questions[0].prompt;
    assert.ok(prompt.includes('\\frac{3x}{4y}'), `Prompt should contain fraction: ${prompt}`);
    assert.ok(prompt.includes('{x}_{1}^{2}'), `Prompt should contain sub/sup: ${prompt}`);
    assert.ok(prompt.includes('\\sqrt[3]{y}'), `Prompt should contain n-th root: ${prompt}`);
  });

  test('MATH-02: MathJax and KaTeX annotation extraction recovers raw TeX', async () => {
    const html = `
      <html><body>
        <div class="que multichoice" id="question-902-1">
          <div class="formulation">
            <div class="qtext">
              Evaluate
              <span class="MathJax">
                <annotation encoding="application/x-tex">\\int_0^\\infty e^{-x^2} dx</annotation>
              </span>
              and KaTeX
              <span class="katex">
                <annotation encoding="application/x-tex">\\sum_{k=1}^n k</annotation>
              </span>
            </div>
            <div class="answer">
              <div><input type="radio" name="q902:1_answer" id="q902_1_a" value="0"><label for="q902_1_a">Done</label></div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    assert.ok(questions[0].prompt.includes('\\int_0^\\infty e^{-x^2} dx'));
    assert.ok(questions[0].prompt.includes('\\sum_{k=1}^n k'));
  });

  test('MATH-03: Raw LaTeX expressions in question prompt are preserved and cleanly extracted', async () => {
    const html = `
      <html><body>
        <div class="que shortanswer" id="question-903-1">
          <div class="formulation">
            <div class="qtext">Find \( x \) such that \[ x^2 + 5x + 6 = 0 \] and $$ f(x) = 0 $$</div>
            <input type="text" name="q903:1_answer" value="">
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    assert.ok(questions[0].prompt.includes('x^2 + 5x + 6 = 0'));
  });

  test('MATH-04: Unreadable MathML without annotation sets mathUnreadable and forces hasVisual=true', async () => {
    const html = `
      <html><body>
        <div class="que multichoice" id="question-904-1">
          <div class="formulation">
            <div class="qtext">
              Exotic formula:
              <math>
                <unknownCustomTag>xyz</unknownCustomTag>
              </math>
            </div>
            <div class="answer">
              <div><input type="radio" name="q904:1_answer" id="q904_1_a" value="0"><label for="q904_1_a">A</label></div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].hasVisual, true, 'Unreadable MathML must flag hasVisual=true for vision capture');
  });

  test('MEDIA-01: Scopes images in question vs options into distinct MediaRef entries', async () => {
    const html = `
      <html><body>
        <div class="que multichoice" id="question-905-1">
          <div class="formulation">
            <div class="qtext">
              Identify diagram:
              <img src="/assets/diagram.png" alt="Question Diagram">
            </div>
            <div class="answer">
              <div>
                <input type="radio" name="q905:1_answer" id="q905_1_a" value="0">
                <label for="q905_1_a"><img src="/assets/optA.png" alt="Option A Graphic"> Option A</label>
              </div>
              <div>
                <input type="radio" name="q905:1_answer" id="q905_1_b" value="1">
                <label for="q905_1_b">Plain Text Option B</label>
              </div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.hasVisual, true);
    assert.ok(q.media && q.media.some(m => m.scope === 'question' && m.src === '/assets/diagram.png'));
    const optA = q.options.find(o => o.text.includes('Option A'));
    assert.ok(optA);
    assert.ok(optA.media && optA.media.some(m => m.scope === 'option' && m.src === '/assets/optA.png'));
  });

  test('MEDIA-02: Canvas and SVG elements are recognized as visual elements', async () => {
    const html = `
      <html><body>
        <div class="que shortanswer" id="question-906-1">
          <div class="formulation">
            <div class="qtext">
              Chart graph:
              <canvas id="chartCanvas" width="200" height="100"></canvas>
              <svg role="img" width="100" height="100"><circle cx="50" cy="50" r="40" /></svg>
            </div>
            <input type="text" name="q906:1_answer" value="">
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].hasVisual, true);
    assert.ok(questions[0].media?.some(m => m.type === 'canvas'));
    assert.ok(questions[0].media?.some(m => m.type === 'svg'));
  });

  test('VISION-01: Fails closed when question has visual elements but AI provider has no vision enabled', async () => {
    const html = `
      <html><body>
        <div class="que multichoice" id="question-907-1">
          <div class="formulation">
            <div class="qtext">Look at picture: <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Tiny Dot"></div>
            <div class="answer">
              <div><input type="radio" name="q907:1_answer" id="q907_1_a" value="0"><label for="q907_1_a">Dot</label></div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions[0].hasVisual, true);

    const nonVisionConfig: AppConfig = {
      allowedHosts: ['localhost'],
      provider: {
        providerId: 'generic-test',
        modelId: 'text-only-model',
        allowVision: false
      } as any
    } as unknown as AppConfig;

    await assert.rejects(
      solveQuestions(page, questions, nonVisionConfig),
      /VISUAL_UNAVAILABLE: A verified vision-capable AI model must be explicitly enabled/
    );
  });

  test('VISION-02: Isolated screenshot captures strictly the question container, preventing LMS chrome leakage', async () => {
    const html = `
      <html>
        <head>
          <style>
            #header-lms { height: 100px; background: red; }
            #mod_quiz_navblock { width: 250px; background: blue; }
            .que { margin: 20px; padding: 20px; background: white; border: 1px solid black; }
          </style>
        </head>
        <body>
          <div id="header-lms">CONFIDENTIAL STUDENT PRIVATE SESSION HEADER</div>
          <div id="mod_quiz_navblock">Nav list with secret user info</div>
          <div class="que multichoice" id="question-908-1">
            <div class="formulation">
              <div class="qtext">Visual Question <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="></div>
              <div class="answer">
                <div><input type="radio" name="q908:1_answer" id="q908_1_a" value="0"><label for="q908_1_a">Answer</label></div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    await page.setContent(html);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 1);

    // Verify locator targeting
    const blockId = questions[0].stableId?.split('#')[0];
    assert.equal(blockId, 'question-908-1');
    const scope = page.locator(`[id="${blockId}"]`);
    assert.equal(await scope.count(), 1);

    // The scope bounding box does not include #header-lms or #mod_quiz_navblock
    const scopeBox = await scope.boundingBox();
    const headerBox = await page.locator('#header-lms').boundingBox();
    assert.ok(scopeBox && headerBox);
    assert.ok(scopeBox.y > headerBox.y + headerBox.height, 'Question scope must be completely below LMS header chrome');
  });

  test('E2E-IMAGE-MATH: Handles multi-question page with delayed image rendering and formula updates', async () => {
    const html = `
      <html>
        <body>
          <div class="que shortanswer" id="question-909-1">
            <div class="formulation">
              <div class="qtext">Q1: <math><mfrac><mn>10</mn><mn>2</mn></mfrac></math></div>
              <input type="text" name="q909:1_answer">
            </div>
          </div>
          <div class="que shortanswer" id="question-909-2">
            <div class="formulation">
              <div class="qtext" id="q2-text">Q2: Loading image...</div>
              <input type="text" name="q909:2_answer">
            </div>
          </div>
        </body>
      </html>
    `;
    await page.setContent(html);

    // Simulate async image load after 100ms
    await page.evaluate(() => {
      setTimeout(() => {
        const el = document.getElementById('q2-text');
        if (el) el.innerHTML = 'Q2: <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Loaded"> Image loaded';
      }, 100);
    });

    await page.waitForTimeout(200);
    const questions = await scanQuestions(page);
    assert.equal(questions.length, 2);
    assert.ok(questions[0].prompt.includes('\\frac{10}{2}'));
    assert.equal(questions[1].hasVisual, true);
  });
});
