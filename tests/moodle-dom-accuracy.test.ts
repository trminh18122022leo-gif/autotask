import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { allFixtures, SLOT, quizPage, attemptUrl } from './fixtures/moodle-fixtures.js';
import { launch, openFixture, openHtml, compareExtraction } from './fixtures/browser-harness.js';

/**
 * Moodle DOM extraction accuracy (Phase 2). Fixtures are hand-written approximations of Moodle markup
 * (see tests/fixtures/moodle-fixtures.ts) and prove scanner behaviour on that DOM shape only.
 */
describe('Moodle DOM extraction (fixtures)', () => {
  let browser: Browser;
  before(async () => { browser = await launch(); });
  after(async () => { await browser?.close(); });

  for (const f of allFixtures()) {
    test(`MDOM: ${f.name}`, async () => {
      const page = await openFixture(browser, f);
      try {
        const qs = await scanQuestions(page);
        const cmp = compareExtraction(f.expected, qs);
        assert.deepEqual(cmp.mismatches, [], `mismatches for "${f.name}": ${JSON.stringify(cmp.mismatches, null, 1)}`);
        assert.deepEqual(cmp.extraQuestions, [], `unexpected extra "questions" (UI treated as question?): ${cmp.extraQuestions.join(' | ')}`);
        assert.equal(qs.length, f.expected.length);
      } finally { await page.context().close(); }
    });
  }

  test('MDOM-UI: search box, jump menu, flag checkbox, clear-choice radio, nav and timer are never questions', async () => {
    const f = allFixtures()[0];
    const page = await openFixture(browser, f);
    try {
      const qs = await scanQuestions(page);
      const names = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-atqa-id]')].map(e => (e as HTMLInputElement).name || e.id));
      for (const bad of ['q', 'courseSearch', 'jump', 'timerfield', 'previous', 'next']) assert.ok(!names.includes(bad), `UI control "${bad}" was marked as a question control`);
      assert.ok(!names.some(n => /flagged|clearchoice/.test(n)), `flag/clear-choice leaked: ${names.join(',')}`);
      assert.equal(qs.length, 1);
    } finally { await page.context().close(); }
  });

  test('MDOM-ID: ids and stableIds are unique across the two pages of a multi-page quiz (no q1 collision)', async () => {
    const p1 = await openHtml(browser, attemptUrl(0), quizPage([SLOT.single({ slot: 1 }).html, SLOT.multi({ slot: 2 }).html], { page: 0 }));
    const p2 = await openHtml(browser, attemptUrl(1), quizPage([SLOT.truefalse(3).html, SLOT.shortanswer(4).html], { page: 1 }));
    try {
      const a = await scanQuestions(p1); const b = await scanQuestions(p2);
      const ids = [...a, ...b].map(q => q.id); const stable = [...a, ...b].map(q => q.stableId);
      assert.equal(new Set(ids).size, ids.length, `id collision across pages: ${ids.join(',')}`);
      assert.equal(new Set(stable).size, stable.length);
      assert.notEqual(a[0].pageKey, b[0].pageKey, 'page identity must differ between pages');
      assert.match(b[0].pageKey!, /attempt=11/); assert.match(b[0].pageKey!, /page=1/);
    } finally { await p1.context().close(); await p2.context().close(); }
  });

  test('MDOM-RND: randomised option order keeps stableId; option identity is the text, never the shuffled index', async () => {
    const results: Record<string, string[]> = {};
    for (const seed of [undefined, 1, 7]) {
      const s = SLOT.single({ shuffle: seed });
      const page = await openHtml(browser, attemptUrl(0), quizPage([s.html]));
      try {
        const [q] = await scanQuestions(page);
        assert.equal(q.stableId, 'question-7001-1');
        results[String(seed)] = q.options.map(o => o.text);
        assert.deepEqual([...q.options.map(o => o.text)].sort(), ['Lyon', 'Marseille', 'Nice', 'Paris']);
      } finally { await page.context().close(); }
    }
    assert.notDeepEqual(results['1'], results['undefined'], 'shuffle seed must actually reorder options for this test to mean anything');
  });
});
