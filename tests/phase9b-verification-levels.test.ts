/** Phase 9B - verification-level acceptance on the team-owned sandbox.
 *  Model = LABELLED TEST DOUBLE (oracle stub) unless a test says otherwise; never counted as real-AI evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { ModelRouter } from '../src/model-center/model-router.js';
import { startPracticeSandbox, SANDBOX_ITEMS, type SandboxServer } from './helpers/practice-sandbox.js';
import { makeConfig, runPractice, itemMatches, deriveExpected, ATTEMPT } from './helpers/practice-harness.js';

const PROVIDER = { kind: 'openai-compatible' as const, profileId: 'test-double', model: 'test-double' };
const realExecute = ModelRouter.execute;
let sb: SandboxServer; let browser: Browser;

function oracle(requestText: string) {
  const { questions } = JSON.parse(requestText) as { questions: any[] };
  return questions.map(q => {
    const it = SANDBOX_ITEMS.find(i => q.prompt.includes(i.prompt.slice(0, 20)))!;
    if (q.kind === 'radio' || q.kind === 'checkbox') return { id: q.id, selected: it.gold.choice!.map(i => q.options[i].id), confidence: 0.9 };
    if (q.kind === 'textarea') return { id: q.id, text: 'Caching stores repeat responses closer to the user, cutting network latency and server load.', confidence: 0.8 };
    return { id: q.id, text: it.gold.accepted![0], confidence: 0.9 };
  });
}
const useOracle = () => { (ModelRouter as any).execute = async (req: any) => ({ output: JSON.stringify({ answers: oracle(req.text) }), initialProfile: 'test-double', finalProfile: 'test-double', attempts: 1, fallbackCount: 0, history: [] }); };

test.before(async () => { sb = await startPracticeSandbox(); browser = await chromium.launch({ headless: true }); });
test.after(async () => { (ModelRouter as any).execute = realExecute; await browser.close(); await sb.close(); });
test.beforeEach(() => { sb.reset(); (ModelRouter as any).execute = realExecute; });

test.describe('P9B-A: per-field comparison (pure)', () => {
  const p = `q${ATTEMPT}:7_answer`;
  test('P9B-01: DOM value different from the model-expected value is NOT verified', () => {
    assert.equal(itemMatches(7, { [p]: 'Fe' }, { [p]: 'Fe' }), true);
    assert.equal(itemMatches(7, { [p]: 'Fe' }, { [p]: 'FE' }), false, 'case drift');
    assert.equal(itemMatches(7, { [p]: 'Fe' }, { [p]: 'Fe?' }), false, 'appended char');
    assert.equal(itemMatches(7, { [p]: 'Fe' }, {}), false, 'empty DOM');
    assert.equal(itemMatches(7, null, { [p]: 'Fe' }), false, 'filled without any model expectation is never verified');
  });
  test('P9B-02: checkbox must match the exact set (extra or missing box fails)', () => {
    const c = (i: number) => `q${ATTEMPT}:3_c${i}`;
    const exp = { [c(0)]: '1', [c(2)]: '1' };
    assert.equal(itemMatches(3, exp, { [c(0)]: '1', [c(2)]: '1' }), true);
    assert.equal(itemMatches(3, exp, { [c(0)]: '1', [c(1)]: '1', [c(2)]: '1' }), false);
    assert.equal(itemMatches(3, exp, { [c(0)]: '1' }), false);
  });
  test('P9B-03: deriveExpected maps model option ids to sandbox DOM fields', () => {
    const calls = [{ questions: [{ id: 'm1', kind: 'radio', options: [{ id: 'm1_o0' }, { id: 'm1_o1' }, { id: 'm1_o2' }] }, { id: 'm3', kind: 'checkbox', options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
      output: '```json\n{"answers":[{"id":"m1","selected":["m1_o2"]},{"id":"m3","selected":["a","c"]}]}\n```' }];
    const e = deriveExpected(calls);
    assert.deepEqual(e.get(1), { [`q${ATTEMPT}:1_answer`]: '2' });
    assert.deepEqual(e.get(3), { [`q${ATTEMPT}:3_c0`]: '1', [`q${ATTEMPT}:3_c2`]: '1' });
  });
});

test.describe('P9B-B: verification levels end-to-end (production executeTask)', () => {
  test('P9B-04: healthy run -> every field reaches SERVER_READBACK_VERIFIED (independent HTTP GET + reload)', async () => {
    useOracle();
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9b_healthy');
    assert.equal(ev.counts.total, 12);
    assert.equal(ev.counts.domFilled, 12);
    assert.equal(ev.counts.domVerified, 12);
    assert.equal(ev.counts.writeAckReceived, 12);
    assert.equal(ev.counts.serverReadbackVerified, 12);
    assert.ok(ev.items.every(i => i.level === 'SERVER_READBACK_VERIFIED'));
    assert.ok(sb.counters.draftReads >= 1, 'draft was read through a separate HTTP request');
    assert.equal(Object.keys(ev.httpDraft).length, 14);
    assert.equal(ev.submitRequests, 0);
    await ev.result.page!.context().close();
  });

  test('P9B-05: HTTP 200 ACK but server wrote nothing -> DOM_VERIFIED/WRITE_ACK_RECEIVED yes, SERVER_READBACK_VERIFIED no, reload empty', async () => {
    sb.faults.autosaveSilentDrop = true; useOracle();
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9b_silentdrop');
    assert.ok(ev.writeAcks.ok > 0 && ev.writeAcks.failed === 0, 'browser saw only 2xx ACKs');
    assert.equal(ev.counts.domVerified, 12);
    assert.equal(ev.counts.writeAckReceived, 12, 'ACK-level only');
    assert.equal(ev.counts.serverReadbackVerified, 0, 'nothing is actually stored');
    assert.deepEqual(ev.httpDraft, {});
    assert.equal(Object.values(ev.domAfterReload).filter(v => v !== '').length, 0, 'reload shows an empty form');
    assert.equal(ev.result.status, 'READY_FOR_REVIEW', 'client cannot tell; READY must therefore not mean saved');
    assert.equal(ev.result.persistence?.serverReadbackVerified, 'NOT_PERFORMED');
    await ev.result.page!.context().close();
  });

  for (const [label, set, expectStatus] of [
    ['HTTP 500', (f: SandboxServer['faults']) => { f.autosave500 = true; }, 'PARTIAL'],
    ['session expired (401)', (f: SandboxServer['faults']) => { f.sessionExpired = true; }, 'WAITING_FOR_AUTH']
  ] as const) {
    test(`P9B-06: ${label} -> no WRITE_ACK_RECEIVED level, persistence reports WRITE_FAILED`, async () => {
      set(sb.faults); useOracle();
      const ev = await runPractice(sb, browser, makeConfig(PROVIDER), `p9b_${label.replace(/\W+/g, '_')}`);
      assert.equal(ev.counts.domVerified, 12);
      assert.equal(ev.counts.writeAckReceived, 0);
      assert.equal(ev.counts.serverReadbackVerified, 0);
      assert.ok(ev.items.every(i => i.level === 'DOM_VERIFIED'));
      assert.equal(ev.result.status, expectStatus);
      assert.equal(ev.result.persistence?.serverWriteAcks, 'WRITE_FAILED');
      await ev.result.page!.context().close();
    });
  }

  test('P9B-07 (regression): DOM changed AFTER the agent\'s own readback -> DOM_DRIFT detected, run not READY, legacy filled-count would over-report', async () => {
    sb.faults.changeRewrite = true; useOracle();
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9b_drift');
    assert.equal(ev.counts.legacyFilledFlag, 12, 'filled=true for all fields (the old, misleading metric)');
    assert.equal(ev.counts.domVerified, 7, 'only the 7 untouched fields still equal the model answer');
    assert.equal(ev.items.filter(i => i.level === 'DOM_FILLED').length, 5);
    assert.notEqual(ev.result.status, 'READY_FOR_REVIEW');
    assert.ok(ev.result.warnings.some(w => w.includes('[DOM_DRIFT]')));
    assert.equal(ev.result.persistence?.domVerified, 7);
    assert.equal(ev.submitRequests, 0);
    await ev.result.page!.context().close();
  });

  test('P9B-08: healthy run exposes machine-readable persistence levels and never claims server readback', async () => {
    useOracle();
    const ev = await runPractice(sb, browser, makeConfig(PROVIDER), 'p9b_levels');
    assert.equal(ev.result.status, 'READY_FOR_REVIEW');
    assert.deepEqual(ev.result.persistence, { domFilled: 12, domVerified: 12, serverWriteAcks: 'WRITE_ACK_RECEIVED', serverWriteFailures: 0, serverReadbackVerified: 'NOT_PERFORMED' });
    await ev.result.page!.context().close();
  });
});
