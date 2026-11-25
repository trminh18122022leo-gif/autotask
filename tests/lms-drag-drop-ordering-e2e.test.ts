import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { prepareAdvancedPracticeQuestions, fillDragDrop, fillOrdering } from '../src/lms/advanced-adapters.js';
import type { Task, Question, Answer } from '../src/types.js';

test.describe('Phase 3 & 4 — Drag & Drop and Ordering E2E Suite', () => {
  let browser: Browser;
  let page: Page;

  const practiceTask: Task = {
    id: 'practice-dnd-order',
    url: 'http://localhost/mod/quiz/attempt.php?attempt=101',
    aiPermitted: true,
    mode: 'PRACTICE_ASSISTED',
    scopeAttestation: 'PERMITTED_SELF_PRACTICE',
    advancedLmsAdapters: {
      ordering: true,
      dragdrop: true
    }
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

  test('DND-01: ddwtos (Drag and drop into text gaps) successfully scans and fills', async () => {
    const html = `
      <html><body>
        <div class="que ddwtos" id="question-1001-1">
          <div class="qtext">The capital of France is [[1]] and Germany is [[2]].</div>
          <div class="formulation">
            <input type="hidden" name="q1001:1_p1" value="">
            <input type="hidden" name="q1001:1_p2" value="">
            <div class="draghome"><span class="drag" draggable="true">Berlin</span></div>
            <div class="draghome"><span class="drag" draggable="true">Paris</span></div>
            <div class="dropzone drop place1" data-place="1" data-dropzone="1" aria-label="Drop 1">&nbsp;</div>
            <div class="dropzone drop place2" data-place="2" data-dropzone="2" aria-label="Drop 2">&nbsp;</div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    // Mock drag-drop interaction handlers in browser
    await page.evaluate(() => {
      const p1 = document.querySelector('input[name="q1001:1_p1"]') as HTMLInputElement;
      const p2 = document.querySelector('input[name="q1001:1_p2"]') as HTMLInputElement;
      const drop1 = document.querySelector('.drop.place1') as HTMLElement;
      const drop2 = document.querySelector('.drop.place2') as HTMLElement;

      [drop1, drop2].forEach(el => {
        el.addEventListener('dragover', (e) => e.preventDefault());
      });
      drop1.addEventListener('drop', (e) => {
        drop1.setAttribute('data-atqa-filled', 'm1_o1'); // Paris
        p1.value = 'Paris';
      });
      drop2.addEventListener('drop', (e) => {
        drop2.setAttribute('data-atqa-filled', 'm1_o0'); // Berlin
        p2.value = 'Berlin';
      });
    });

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'dragdrop');
    assert.equal(q.options.length, 2);
    assert.equal(q.zones?.length, 2);

    const answer: Answer = {
      id: q.id,
      placements: [
        { itemId: 'm1_o1', zoneId: 'm1_z0' }, // Paris -> Drop 1
        { itemId: 'm1_o0', zoneId: 'm1_z1' }  // Berlin -> Drop 2
      ]
    };

    await fillDragDrop(page, q, answer);

    // Read back DOM state
    const p1Val = await page.locator('input[name="q1001:1_p1"]').inputValue();
    const p2Val = await page.locator('input[name="q1001:1_p2"]').inputValue();
    assert.equal(p1Val, 'Paris');
    assert.equal(p2Val, 'Berlin');
  });

  test('DND-02: ddimageortext (Drag items onto image) identifies image labels and target zones', async () => {
    const html = `
      <html><body>
        <div class="que ddimageortext" id="question-1002-1">
          <div class="qtext">Place labels on the map</div>
          <div class="formulation">
            <input type="hidden" name="q1002:1_hidden" value="initial">
            <div class="draghomes">
              <div class="draghome"><img src="/img/pinA.png" alt="Pin Alpha" draggable="true"></div>
              <div class="draghome"><img src="/img/pinB.png" alt="Pin Beta" draggable="true"></div>
            </div>
            <div class="droparea">
              <div class="dropzone" data-place="North" aria-label="North Zone">&nbsp;</div>
              <div class="dropzone" data-place="South" aria-label="South Zone">&nbsp;</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'dragdrop');
    assert.equal(q.options.length, 2);
    assert.equal(q.options[0].text, 'Pin Alpha');
    assert.equal(q.options[1].text, 'Pin Beta');
    assert.equal(q.zones?.length, 2);
  });

  test('DND-03: ddmarker (Draggable markers to target coordinates)', async () => {
    const html = `
      <html><body>
        <div class="que ddmarker" id="question-1003-1">
          <div class="qtext">Drop markers on cities</div>
          <div class="formulation">
            <input type="hidden" name="q1003:1_state" value="empty">
            <div class="draghomes">
              <span class="marker draghome" draggable="true">Hanoi</span>
              <span class="marker draghome" draggable="true">Saigon</span>
            </div>
            <div class="droparea">
              <div class="dropzone" data-place="Capital" aria-label="Capital Target">&nbsp;</div>
              <div class="dropzone" data-place="Port" aria-label="Port Target">&nbsp;</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const questions = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(questions.length, 1);
    const q = questions[0];
    assert.equal(q.kind, 'dragdrop');
    assert.equal(q.options[0].text, 'Hanoi');
    assert.equal(q.options[1].text, 'Saigon');
  });

  test('DND-04: Fails closed when drag operation does not produce verified DOM or hidden input change', async () => {
    const html = `
      <html><body>
        <div class="que ddwtos" id="question-1004-1">
          <div class="qtext">Stubborn drag drop</div>
          <div class="formulation">
            <input type="hidden" name="q1004:1_stubborn" value="static">
            <div class="draghome"><span class="drag" draggable="true">Item A</span></div>
            <div class="dropzone drop" data-place="1" aria-label="Drop 1">&nbsp;</div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(q.kind, 'dragdrop');

    const answer: Answer = {
      id: q.id,
      placements: [{ itemId: 'm1_o0', zoneId: 'm1_z0' }]
    };

    // The page has NO drop listener; hidden input stays "static" and no DOM child is placed
    await assert.rejects(
      fillDragDrop(page, q, answer),
      /Drag\/drop was not confirmed; plugin state unchanged/
    );
  });

  test('DND-05: Rejects ambiguous/duplicate draggable item labels', async () => {
    const html = `
      <html><body>
        <div class="que ddwtos" id="question-1005-1">
          <div class="qtext">Ambiguous labels</div>
          <div class="formulation">
            <div class="draghome"><span class="drag" draggable="true">Duplicate Item</span></div>
            <div class="draghome"><span class="drag" draggable="true">Duplicate Item</span></div>
            <div class="dropzone drop" data-place="1" aria-label="Drop 1">&nbsp;</div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(q.kind, 'unsupported', 'Ambiguous drag items with duplicate labels must remain unsupported');
  });

  test('ORDER-01: qtype_ordering accurately extracts initial item sequence', async () => {
    const html = `
      <html><body>
        <div class="que ordering" id="question-2001-1">
          <div class="qtext">Order the steps of compilation:</div>
          <div class="formulation">
            <div class="sortablelist">
              <div class="sortableitem" draggable="true">1. Lexical Analysis</div>
              <div class="sortableitem" draggable="true">2. Parsing</div>
              <div class="sortableitem" draggable="true">3. Code Generation</div>
              <div class="sortableitem" draggable="true">4. Optimization</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(q.kind, 'ordering');
    assert.equal(q.options.length, 4);
    assert.equal(q.options[0].text, '1. Lexical Analysis');
    assert.equal(q.options[3].text, '4. Optimization');
  });

  test('ORDER-02: qtype_ordering executes desired permutation and verifies readback', async () => {
    const html = `
      <html><body>
        <div class="que ordering" id="question-2002-1">
          <div class="qtext">Sort alphabetically:</div>
          <div class="formulation">
            <div class="sortablelist" id="slist">
              <div class="sortableitem" draggable="true">Charlie</div>
              <div class="sortableitem" draggable="true">Alice</div>
              <div class="sortableitem" draggable="true">Bob</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    // Add drag-reordering simulation on page
    await page.evaluate(() => {
      const container = document.getElementById('slist')!;
      container.addEventListener('dragover', (e) => e.preventDefault());
      container.addEventListener('drop', (e) => {
        // Rearrange DOM based on drag choice
        const items = [...container.querySelectorAll('.sortableitem')];
        // Sort to Alice, Bob, Charlie
        items.sort((a, b) => (a.textContent || '').localeCompare(b.textContent || ''));
        items.forEach(it => container.appendChild(it));
      });
    });

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);
    assert.equal(q.kind, 'ordering');

    // Desired: Alice (m1_o1), Bob (m1_o2), Charlie (m1_o0)
    const desiredOrder = ['m1_o1', 'm1_o2', 'm1_o0'];
    const answer: Answer = {
      id: q.id,
      selected: desiredOrder
    };

    await fillOrdering(page, q, answer);

    // Verify DOM order
    const finalOrder = await page.locator('#slist [data-atqa-choice]').evaluateAll(ns => ns.map(n => n.getAttribute('data-atqa-choice')));
    assert.deepEqual(finalOrder, desiredOrder);
  });

  test('ORDER-03: Rejects invalid ordering permutation (missing item or duplicate)', async () => {
    const html = `
      <html><body>
        <div class="que ordering" id="question-2003-1">
          <div class="qtext">Order items</div>
          <div class="formulation">
            <div class="sortablelist">
              <div class="sortableitem" draggable="true">A</div>
              <div class="sortableitem" draggable="true">B</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);

    // Duplicate item in selected
    await assert.rejects(
      fillOrdering(page, q, { id: q.id, selected: ['m1_o0', 'm1_o0'] }),
      /Ordering requires an exact permutation/
    );

    // Missing item in selected
    await assert.rejects(
      fillOrdering(page, q, { id: q.id, selected: ['m1_o0'] }),
      /Ordering requires an exact permutation/
    );
  });

  test('ORDER-04: Fails closed when DOM order does not change after dragTo', async () => {
    const html = `
      <html><body>
        <div class="que ordering" id="question-2004-1">
          <div class="qtext">Immutable ordering list</div>
          <div class="formulation">
            <div class="sortablelist">
              <div class="sortableitem" draggable="true">A</div>
              <div class="sortableitem" draggable="true">B</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned = await scanQuestions(page);
    const [q] = await prepareAdvancedPracticeQuestions(page, scanned, practiceTask);

    // No drop listener on page -> DOM order never changes
    await assert.rejects(
      fillOrdering(page, q, { id: q.id, selected: ['m1_o1', 'm1_o0'] }),
      /Ordering was not confirmed by DOM readback/
    );
  });

  test('ORDER-05: Maintains ordering consistency across re-render and page state check', async () => {
    const html = `
      <html><body>
        <div class="que ordering" id="question-2005-1">
          <div class="qtext">Re-render check</div>
          <div class="formulation">
            <div class="sortablelist" id="slist5">
              <div class="sortableitem" draggable="true">First</div>
              <div class="sortableitem" draggable="true">Second</div>
            </div>
          </div>
        </div>
      </body></html>
    `;
    await page.setContent(html);

    const scanned1 = await scanQuestions(page);
    const [q1] = await prepareAdvancedPracticeQuestions(page, scanned1, practiceTask);
    assert.equal(q1.options[0].text, 'First');
    assert.equal(q1.options[1].text, 'Second');

    // Re-render DOM
    await page.evaluate(() => {
      const container = document.getElementById('slist5')!;
      container.innerHTML = `
        <div class="sortableitem" draggable="true">First</div>
        <div class="sortableitem" draggable="true">Second</div>
      `;
    });

    const scanned2 = await scanQuestions(page);
    const [q2] = await prepareAdvancedPracticeQuestions(page, scanned2, practiceTask);
    assert.equal(q2.options[0].text, 'First');
    assert.equal(q2.options[1].text, 'Second');
  });
});
