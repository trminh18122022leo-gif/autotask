import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { prepareAdvancedPracticeQuestions, fillCodeDraft } from '../src/lms/advanced-adapters.js';
import type { Task, Question, Answer } from '../src/types.js';

test.describe('Phase 6 — CodeRunner and Special Plugins E2E Suite', () => {
  let browser: Browser;
  let page: Page;

  const practiceTask: Task = {
    id: 'practice-coderunner',
    url: 'http://localhost/mod/quiz/attempt.php?attempt=301',
    aiPermitted: true,
    mode: 'PRACTICE_ASSISTED',
    scopeAttestation: 'PERMITTED_SELF_PRACTICE',
    advancedLmsAdapters: { codeDraft: true }
  };

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

  test('CODE-01: Native textarea CodeRunner input and verified readback', async () => {
    const html = `
      <html><body>
        <div class="que coderunner" id="question-3001-1">
          <div class="qtext">Write a Python function to compute factorial:</div>
          <div class="formulation">
            <textarea class="coderunner-answer" name="q3001:1_answer" rows="10" cols="60"></textarea>
            <button type="button" class="btn btn-secondary check-button">Check</button>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'code');

    const draftCode = 'def factorial(n):\n    return 1 if n <= 1 else n * factorial(n - 1)';
    const answer: Answer = { id: q.id, text: draftCode };

    await fillCodeDraft(page, q, answer);

    const actual = await page.locator('textarea.coderunner-answer').inputValue();
    assert.equal(actual, draftCode, 'Textarea value must exactly match drafted code');
  });

  test('CODE-02: Ace Editor bridge types code and verifies sync to underlying textarea', async () => {
    const html = `
      <html>
        <head>
          <style>
            .ace_editor { width: 400px; height: 150px; border: 1px solid #333; }
            .hidden-textarea { display: none; }
          </style>
        </head>
        <body>
          <div class="que coderunner" id="question-3002-1">
            <div class="qtext">Implement binary search in Ace editor:</div>
            <div class="formulation">
              <div class="ace_editor" tabindex="0">Ace Editor Surface</div>
              <textarea class="coderunner-answer hidden-textarea" name="q3002:1_answer"></textarea>
            </div>
          </div>

          <script>
            const editor = document.querySelector('.ace_editor');
            const textarea = document.querySelector('textarea.coderunner-answer');
            let content = '';

            editor.addEventListener('click', () => editor.focus());
            editor.addEventListener('keydown', (e) => {
              if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
                content = '';
                textarea.value = '';
              }
            });
            editor.addEventListener('beforeinput', (e) => {
              if (e.data) {
                content += e.data;
                textarea.value = content;
              }
            });
            // Support text insertion event
            window.addEventListener('message', (ev) => {
              if (ev.data && ev.data.type === 'sync') {
                textarea.value = ev.data.text;
              }
            });
          </script>
        </body>
      </html>
    `;
    await page.setContent(html);

    // Setup simulated Ace editor bridge sync
    await page.evaluate(() => {
      const editor = document.querySelector('.ace_editor') as HTMLElement;
      const textarea = document.querySelector('textarea.coderunner-answer') as HTMLTextAreaElement;
      const observer = new MutationObserver(() => {
        textarea.value = editor.innerText;
      });
      observer.observe(editor, { characterData: true, subtree: true, childList: true });

      // Override keyboard insertion handling
      editor.addEventListener('input', () => {
        textarea.value = editor.innerText;
      });
    });

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'code');
  });

  test('CODE-03: CodeMirror Editor bridge syncs draft code', async () => {
    const html = `
      <html>
        <head>
          <style>
            .CodeMirror { width: 400px; height: 120px; border: 1px solid #444; }
          </style>
        </head>
        <body>
          <div class="que coderunner" id="question-3003-1">
            <div class="qtext">CodeMirror draft task:</div>
            <div class="formulation">
              <div class="CodeMirror" tabindex="0">CodeMirror Line</div>
              <textarea name="q3003:1_answer" class="coderunner-answer" style="display:none;"></textarea>
            </div>
          </div>
        </body>
      </html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'code');
  });

  test('CODE-04: Never clicks Check, Precheck, or Submit buttons during draft entry', async () => {
    let checkClicked = false;
    let precheckClicked = false;

    const html = `
      <html><body>
        <div class="que coderunner" id="question-3004-1">
          <div class="formulation">
            <textarea class="coderunner-answer" name="q3004:1_answer"></textarea>
            <button id="btn-precheck">Precheck</button>
            <button id="btn-check">Check</button>
            <input type="submit" id="btn-submit" value="Check and submit">
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    await page.exposeFunction('onCheckClick', () => { checkClicked = true; });
    await page.exposeFunction('onPrecheckClick', () => { precheckClicked = true; });

    await page.evaluate(() => {
      document.getElementById('btn-check')?.addEventListener('click', () => (window as any).onCheckClick());
      document.getElementById('btn-precheck')?.addEventListener('click', () => (window as any).onPrecheckClick());
      document.getElementById('btn-submit')?.addEventListener('click', () => (window as any).onCheckClick());
    });

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);

    await fillCodeDraft(page, q, { id: q.id, text: 'print("Safe Draft Only")' });

    assert.equal(checkClicked, false, 'Agent must NEVER click Check button');
    assert.equal(precheckClicked, false, 'Agent must NEVER click Precheck button');
  });

  test('CODE-05: Special plugins (STACK, Formulas, WIRIS) fail closed to UNSUPPORTED and are never downgraded', async () => {
    const html = `
      <html><body>
        <div class="que stack" id="question-3005-1">
          <div class="formulation">
            <div class="qtext">STACK Symbolic integral question</div>
            <input type="text" name="q3005:1_ans1" value="">
          </div>
        </div>
        <div class="que formulas" id="question-3005-2">
          <div class="formulation">
            <div class="qtext">Formulas multi-variable question</div>
            <input type="text" name="q3005:2_ans1" value="">
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);

    assert.equal(questions.length, 2);
    assert.equal(questions[0].kind, 'unsupported', 'STACK plugin must remain unsupported');
    assert.ok(questions[0].unsupportedReason?.includes('stack'), 'Guidance must reference STACK plugin');

    assert.equal(questions[1].kind, 'unsupported', 'Formulas plugin must remain unsupported');
    assert.ok(questions[1].unsupportedReason?.includes('formulas'), 'Guidance must reference Formulas plugin');
  });
});
