/** Phase 9A - failure-mode regression suite for PRACTICE_ASSISTED on the team-owned sandbox.
 *  The model here is a LABELLED TEST DOUBLE (ModelRouter.execute stub) used ONLY to inject failure shapes
 *  deterministically. It is NOT evidence of real-AI accuracy (see scripts/phase9a-sandbox-pilot.ts for that). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ModelRouter } from '../src/model-center/model-router.js';
import { startPracticeSandbox, SANDBOX_ITEMS, type SandboxServer } from './helpers/practice-sandbox.js';
import { makeConfig, runPractice, ATTEMPT } from './helpers/practice-harness.js';
import { scanQuestions } from '../src/scanner.js';

const PROVIDER = { kind: 'openai-compatible' as const, profileId: 'test-double', model: 'test-double' };
const realExecute = ModelRouter.execute;
let sb: SandboxServer; let browser: Browser;
let calls = 0;

/** Oracle double: answers from the dev-team gold keys, matching by prompt text. */
function oracleAnswers(requestText: string) {
  const { questions } = JSON.parse(requestText) as { questions: any[] };
  return questions.map(q => {
    const it = SANDBOX_ITEMS.find(i => q.prompt.includes(i.prompt.slice(0, 20)))!;
    if (q.kind === 'radio' || q.kind === 'checkbox') return { id: q.id, selected: it.gold.choice!.map(i => q.options[i].id), confidence: 0.9 };
    if (q.kind === 'textarea') return { id: q.id, text: 'Caching stores repeat responses closer to the user, cutting network latency and server load so pages load faster.', confidence: 0.8 };
    return { id: q.id, text: it.gold.accepted![0], confidence: 0.9 };
  });
}
const wrap = (output: string) => ({ output, initialProfile: 'test-double', finalProfile: 'test-double', attempts: 1, fallbackCount: 0, history: [] });
function stub(fn: (text: string) => Promise<string> | string) {
  (ModelRouter as any).execute = async (req: any) => { calls++; return wrap(await fn(req.text)); };
}

test.before(async () => { sb = await startPracticeSandbox(); browser = await chromium.launch({ headless: true }); });
test.after(async () => { (ModelRouter as any).execute = realExecute; await browser.close(); await sb.close(); });
test.beforeEach(() => { sb.reset(); calls = 0; (ModelRouter as any).execute = realExecute; });

const neverSubmitted = () => { assert.equal(sb.counters.submitRequests, 0, 'operator-only submit must never be triggered'); assert.deepEqual(sb.counters.unexpectedMethods, []); };

test.describe('Phase 9A sandbox practice workflow', () => {
  test('P9A-01: scanner recognises all 12 sandbox items and their types', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(`${sb.baseUrl}/practice?attempt=${ATTEMPT}`);
    const qs = await scanQuestions(page);
    assert.deepEqual(qs.map(q => q.kind), ['radio', 'radio', 'checkbox', 'checkbox', 'radio', 'radio', 'text', 'text', 'text', 'text', 'text', 'textarea']);
    assert.equal(qs[2].options.length, 4);
    await ctx.close();
  });

  test('P9A-02: happy path - fill, independent DOM readback, autosave persisted on sandbox server, never submitted', async () => {
    stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_happy');
    assert.equal(ev.result.questionsFound, 12);
    assert.equal(ev.result.questionsFilled, 12);
    assert.equal(ev.result.status, 'READY_FOR_REVIEW');
    assert.equal(ev.domFilledFields, 12);
    assert.equal(ev.items.filter(i => i.type !== 'essay' && !i.correct).length, 0);
    assert.ok(sb.counters.autosavePersisted >= 1, 'autosave reached sandbox backend');
    assert.equal(ev.serverMatchesDom, true, 'server draft equals independent DOM snapshot');
    neverSubmitted();
    await ev.result.page!.context().close();
  });

  test('P9A-03: model network loss -> nothing filled, nothing saved, no false READY', async () => {
    stub(() => { throw new Error('Toàn bộ 1 lần gọi qua 1 model đều thất bại. Lỗi cuối: fetch failed'); });
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_netloss');
    assert.equal(ev.result.questionsFilled, 0);
    assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
    assert.ok(ev.result.warnings.some(w => w.includes('AI_NEEDS_REVIEW')));
    assert.equal(ev.domFilledFields, 0);
    assert.equal(sb.counters.autosaveRequests, 0);
    neverSubmitted();
    await ev.result.page!.context().close();
  });

  for (const [name, payload] of [
    ['non-JSON prose', 'Sure! The answers are 404 and Queue.'],
    ['wrong shape (answers not an array)', '{"answers":"none"}'],
    ['hallucinated question ids', '{"answers":[{"id":"zz99","text":"x"}]}'],
    ['invalid option id', '{"answers":[{"id":"m1","selected":["nope"]}]}'],
    ['confidence out of range', '{"answers":[{"id":"m7","text":"Fe","confidence":7}]}']
  ] as const) {
    test(`P9A-04: malformed model output (${name}) is rejected; DOM untouched`, async () => {
      stub(() => payload);
      const ev = await runPractice(sb, browser, makeConfig(PROVIDER), `p9a_malformed_${name.replace(/\W+/g, '_')}`);
      assert.equal(ev.result.questionsFilled, 0);
      assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
      assert.equal(ev.domFilledFields, 0);
      neverSubmitted();
      await ev.result.page!.context().close();
    });
  }

  test('P9A-05: slow page (2.5 s) still completes and verifies', async () => {
    sb.faults.pageDelayMs = 2500;
    stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_slow');
    assert.equal(ev.result.questionsFilled, 12);
    assert.equal(ev.result.status, 'READY_FOR_REVIEW');
    neverSubmitted();
    await ev.result.page!.context().close();
  });

  test('P9A-06: fields changed between scan and fill (removed from DOM) -> reported, not READY, others unaffected', async () => {
    let ctxRef: BrowserContext | undefined;
    stub(async t => {
      const page = ctxRef!.pages()[0];
      await page.evaluate(() => document.querySelectorAll('input[type=text]').forEach(e => e.removeAttribute('data-atqa-id')));
      return JSON.stringify({ answers: oracleAnswers(t) });
    });
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_fieldchanged', { setup: async c => { ctxRef = c; } });
    assert.equal(ev.result.questionsFound, 12);
    assert.equal(ev.result.questionsFilled, 7, '5 text/numeric fields vanished; 7 choice/essay fields filled');
    assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
    assert.ok(ev.result.warnings.some(w => w.includes('Không điền được')));
    neverSubmitted();
    await ev.result.page!.context().close();
  });

  test('P9A-07: silent DOM reset trap on text fields -> readback mismatch is detected, field not counted as filled', async () => {
    sb.faults.textResetTrap = true;
    stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_resettrap');
    assert.equal(ev.result.questionsFilled, 7);
    assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
    neverSubmitted();
    await ev.result.page!.context().close();
  });

  test('P9A-08: browser offline at load -> ERROR/PARTIAL without calling the model or writing anything', async () => {
    stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_offline', { setup: async c => { await c.setOffline(true); } });
    assert.equal(calls, 0);
    assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
    assert.equal(sb.counters.autosaveRequests, 0);
    neverSubmitted();
  });
});

test.describe('Phase 9A server persistence is never assumed from the DOM', () => {
  for (const [label, set] of [
    ['autosave HTTP 500', (f: SandboxServer['faults']) => { f.autosave500 = true; }],
    ['session expired (HTTP 401)', (f: SandboxServer['faults']) => { f.sessionExpired = true; }],
    ['autosave ACK 200 but silently dropped', (f: SandboxServer['faults']) => { f.autosaveSilentDrop = true; }]
  ] as const) {
    test(`P9A-09: ${label} -> run must not claim server-saved state`, async () => {
      set(sb.faults);
      stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
      const ev = await runPractice(sb, browser, makeConfig(PROVIDER), `p9a_persist_${label.replace(/\W+/g, '_')}`);
      assert.equal(ev.domFilledFields, 12, 'DOM fill itself succeeded');
      assert.equal(sb.counters.autosavePersisted, 0, 'sandbox backend persisted nothing');
      assert.equal(ev.serverMatchesDom, false, 'independent server readback disagrees with DOM');
      // Contract: READY_FOR_REVIEW means "DOM filled, awaiting operator", never "saved on server".
      assert.ok(
        ev.result.warnings.some(w => /DOM|server|máy chủ|chưa lưu|autosave|nháp/i.test(w)),
        'result must warn that server persistence was not confirmed'
      );
      if (label.startsWith('autosave HTTP 500')) {
        assert.ok(ev.result.warnings.some(w => w.includes('[SAVE_NOT_CONFIRMED]')));
        assert.equal(ev.result.status, 'PARTIAL');
      } else if (label.startsWith('session expired')) {
        assert.ok(ev.result.warnings.some(w => w.includes('[SAVE_NOT_CONFIRMED]')));
        assert.equal(ev.result.status, 'WAITING_FOR_AUTH');
      } else {
        // 200 ACK without persistence is undetectable by the client: only the standing notice can (and must) be present.
        assert.ok(ev.result.warnings.some(w => w.includes('[PERSISTENCE_UNVERIFIED]')));
      }
      neverSubmitted();
      await ev.result.page!.context().close();
    });
  }

  test('P9A-10: healthy autosave -> no SAVE_NOT_CONFIRMED, still carries the standing persistence-unverified notice', async () => {
    stub(t => JSON.stringify({ answers: oracleAnswers(t) }));
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9a_healthy_notice');
    assert.ok(!ev.result.warnings.some(w => w.includes('[SAVE_NOT_CONFIRMED]')));
    assert.ok(ev.result.warnings.some(w => w.includes('[PERSISTENCE_UNVERIFIED]')));
    assert.equal(ev.result.status, 'READY_FOR_REVIEW');
    await ev.result.page!.context().close();
  });
});
