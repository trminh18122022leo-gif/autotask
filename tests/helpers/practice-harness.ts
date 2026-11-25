/** Phase 9A/9B harness: runs the PRODUCTION executeTask() against the team-owned sandbox and collects independent evidence.
 *
 *  Verification levels (per field, strictest last):
 *   DOM_FILLED                 the field holds a non-empty value after the run (says NOTHING about correctness)
 *   DOM_VERIFIED               DOM value after settle == what the model asked for (expected, derived from the model output)
 *   WRITE_ACK_RECEIVED         DOM_VERIFIED + the browser observed only 2xx write responses after filling (an ACK is NOT proof of storage)
 *   SERVER_READBACK_VERIFIED   an independent HTTP GET of the stored draft AND a reloaded page both equal the expected value
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { executeTask } from '../../src/main.js';
import { loadCheckpoint, clearCheckpoint } from '../../src/task-manager.js';
import { ModelRouter } from '../../src/model-center/model-router.js';
import type { AppConfig, Task, TaskResult } from '../../src/types.js';
import { SANDBOX_ITEMS, norm, type SandboxServer } from './practice-sandbox.js';

export const ATTEMPT = 9200;

export function makeConfig(provider: AppConfig['provider'], extra: Partial<AppConfig> = {}): AppConfig {
  return {
    allowedHosts: ['127.0.0.1'], approvedForAIUse: true, parallelTabs: 1, authUrls: [], deadlinePages: [], tasks: [],
    operationMode: 'PRACTICE_ASSISTED', answerSourceMode: 'AI_PRIMARY', maxAttemptsPerModel: 1, provider, ...extra
  };
}
export function makeTask(sb: SandboxServer, id: string, extra: Partial<Task> = {}): Task {
  return { id, url: `${sb.baseUrl}/practice?attempt=${ATTEMPT}`, title: 'Phase 9 sandbox practice', aiPermitted: true, mode: 'PRACTICE_ASSISTED', scopeAttestation: 'PERMITTED_SELF_PRACTICE', ...extra };
}

export type Level = 'NONE' | 'DOM_FILLED' | 'DOM_VERIFIED' | 'WRITE_ACK_RECEIVED' | 'SERVER_READBACK_VERIFIED';
export interface ItemEvidence {
  slot: number; type: string; filled: boolean; correct: boolean | null; requiresHumanReview?: boolean; domValue: string | string[] | null;
  /** Fields the model asked for (name -> value), or null when the model gave no answer for this item. */
  expected: Record<string, string> | null;
  domVerified: boolean; httpReadbackMatches: boolean; reloadMatches: boolean; level: Level;
}
export interface RunEvidence {
  result: TaskResult; dom: Record<string, string>; domAfterReload: Record<string, string>; httpDraft: Record<string, string>;
  items: ItemEvidence[];
  counts: { total: number; expectedFromModel: number; domFilled: number; domVerified: number; writeAckReceived: number; serverReadbackVerified: number; legacyFilledFlag: number };
  writeAcks: { ok: number; failed: number };
  serverMatchesDom: boolean;
  saveStatus: { state: string | null; status: string | null }; submitRequests: number;
  domFilledFields: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Model-output recorder: PASS-THROUGH wrapper around whatever ModelRouter.execute currently is (real or test double).
export interface RecordedCall { questions: any[]; output: string }
export function installRecorder() {
  const inner = ModelRouter.execute;
  const calls: RecordedCall[] = [];
  (ModelRouter as any).execute = async function (req: any, opts: any) {
    const r = await (inner as any).call(ModelRouter, req, opts);
    try { calls.push({ questions: JSON.parse(req.text).questions || [], output: String(r?.output ?? '') }); } catch { /* ignore */ }
    return r;
  };
  return { calls, restore() { (ModelRouter as any).execute = inner; } };
}

const unfence = (s: string) => s.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
/** Derive the exact DOM field values the model asked for, keyed by sandbox slot. */
export function deriveExpected(calls: RecordedCall[]): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>();
  for (const c of calls) {
    let answers: any[] = [];
    try { answers = JSON.parse(unfence(c.output)).answers; if (!Array.isArray(answers)) continue; } catch { continue; }
    for (const a of answers) {
      const q = c.questions.find(x => x.id === a?.id);
      if (!q) continue;
      const slot = Number(String(q.id).replace(/^m/, ''));
      if (!Number.isInteger(slot)) continue;
      const p = `q${ATTEMPT}:${slot}`;
      const f: Record<string, string> = {};
      if (q.kind === 'radio') {
        const idx = q.options.findIndex((o: any) => o.id === a.selected?.[0]);
        if (idx < 0) continue; f[`${p}_answer`] = String(idx);
      } else if (q.kind === 'checkbox') {
        for (const id of a.selected || []) { const idx = q.options.findIndex((o: any) => o.id === id); if (idx >= 0) f[`${p}_c${idx}`] = '1'; }
        if (!Object.keys(f).length) continue;
      } else if (typeof a.text === 'string') { f[`${p}_answer`] = a.text; } else continue;
      out.set(slot, f);
    }
  }
  return out;
}

/** Exact comparison of one item: every expected field present with the same value and NO extra field of that item set. */
export function itemMatches(slot: number, expected: Record<string, string> | undefined | null, snap: Record<string, string>): boolean {
  if (!expected) return false;
  const p = `q${ATTEMPT}:${slot}_`;
  const actual: Record<string, string> = {};
  for (const [k, v] of Object.entries(snap)) if (k.startsWith(p) && v !== '') actual[k] = v;
  const ek = Object.keys(expected).sort(), ak = Object.keys(actual).sort();
  return JSON.stringify(ek) === JSON.stringify(ak) && ek.every(k => expected[k] === actual[k]);
}

/** Independent DOM snapshot (the sandbox page's own form serializer; not the agent's fill return value). */
export async function domSnapshot(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as any).eval('snapshot()'));
}

export function scoreDom(dom: Record<string, string>): Omit<ItemEvidence, 'expected' | 'domVerified' | 'httpReadbackMatches' | 'reloadMatches' | 'level'>[] {
  return SANDBOX_ITEMS.map(it => {
    const p = `q${ATTEMPT}:${it.slot}`;
    if (it.type === 'single' || it.type === 'truefalse') {
      const v = dom[`${p}_answer`];
      return { slot: it.slot, type: it.type, filled: v !== undefined, correct: v === undefined ? false : it.gold.choice!.length === 1 && Number(v) === it.gold.choice![0], domValue: v ?? null };
    }
    if (it.type === 'multi') {
      const picked = it.options!.map((_, i) => i).filter(i => dom[`${p}_c${i}`] === '1');
      const ok = picked.length === it.gold.choice!.length && picked.every(i => it.gold.choice!.includes(i));
      return { slot: it.slot, type: it.type, filled: picked.length > 0, correct: ok, domValue: picked.map(String) };
    }
    const v = dom[`${p}_answer`] ?? '';
    if (it.type === 'essay') {
      const hits = it.gold.rubric!.filter(k => v.toLowerCase().includes(k)).length;
      return { slot: it.slot, type: it.type, filled: v.trim().length > 0, correct: v.trim() ? hits >= 2 : false, requiresHumanReview: true, domValue: v };
    }
    return { slot: it.slot, type: it.type, filled: v.trim().length > 0, correct: it.gold.accepted!.includes(norm(v)), domValue: v };
  });
}

async function httpReadDraft(sb: SandboxServer): Promise<Record<string, string>> {
  // Independent of the browser, the agent and the sandbox's in-memory map: a plain Node HTTP request.
  const r = await fetch(`${sb.baseUrl}/api/sandbox/draft?attempt=${ATTEMPT}`);
  return (await r.json()) as Record<string, string>;
}

export async function runPractice(sb: SandboxServer, browser: Browser, config: AppConfig, taskId: string, opts: { taskExtra?: Partial<Task>; setup?: (ctx: BrowserContext) => Promise<void>; recorder?: ReturnType<typeof installRecorder> } = {}): Promise<RunEvidence> {
  await clearCheckpoint(taskId).catch(() => {});
  const ctx = await browser.newContext();
  if (opts.setup) await opts.setup(ctx);
  const writeAcks = { ok: 0, failed: 0 };
  ctx.on('response', r => {
    const req = r.request();
    if (req.method() === 'POST' && req.url().includes('/api/sandbox/autosave')) (r.status() < 400 ? writeAcks.ok++ : writeAcks.failed++);
  });
  ctx.on('requestfailed', r => { if (r.method() === 'POST' && r.url().includes('/api/sandbox/autosave')) writeAcks.failed++; });
  const rec = opts.recorder ?? installRecorder();
  const ownRecorder = !opts.recorder;
  let result: TaskResult;
  const task = makeTask(sb, taskId, opts.taskExtra);
  try { result = await executeTask(ctx, task, { ...config, tasks: [task] }); }
  finally { if (ownRecorder) rec.restore(); }

  let dom: Record<string, string> = {}; let domAfterReload: Record<string, string> = {};
  let saveStatus = { state: null as string | null, status: null as string | null };
  if (result.page && !result.page.isClosed()) {
    await result.page.waitForTimeout(400); // let delayed page scripts (and debounced autosave) settle
    dom = await domSnapshot(result.page).catch(() => ({}));
    saveStatus = await result.page.evaluate(() => { const s = document.getElementById('save-status'); return { state: s?.dataset.state ?? null, status: s?.dataset.status ?? null }; }).catch(() => saveStatus);
  }
  const httpDraft = await httpReadDraft(sb).catch(() => ({}));
  if (result.page && !result.page.isClosed() && result.status !== 'ERROR') {
    // Reload: a server-restored draft is the only thing that can survive this.
    await result.page.reload({ waitUntil: 'load' }).catch(() => {});
    domAfterReload = await domSnapshot(result.page).catch(() => ({}));
  }
  const expected = deriveExpected(rec.calls);
  const scored = scoreDom(dom);
  const ackClean = writeAcks.ok > 0 && writeAcks.failed === 0;
  const items: ItemEvidence[] = scored.map(s => {
    const exp = expected.get(s.slot) ?? null;
    const domVerified = itemMatches(s.slot, exp, dom);
    const httpReadbackMatches = itemMatches(s.slot, exp, httpDraft);
    const reloadMatches = itemMatches(s.slot, exp, domAfterReload);
    const level: Level = !s.filled ? 'NONE'
      : !domVerified ? 'DOM_FILLED'
      : httpReadbackMatches && reloadMatches ? 'SERVER_READBACK_VERIFIED'
      : ackClean ? 'WRITE_ACK_RECEIVED' : 'DOM_VERIFIED';
    return { ...s, expected: exp, domVerified, httpReadbackMatches, reloadMatches, level };
  });
  const cp = await loadCheckpoint(taskId).catch(() => null); void cp;
  const norm1 = (o: Record<string, string>) => JSON.stringify(Object.entries(o).filter(([, v]) => v !== '').sort());
  const evidence: RunEvidence = {
    result, dom, domAfterReload, httpDraft, items, writeAcks,
    counts: {
      total: items.length, expectedFromModel: expected.size,
      domFilled: items.filter(i => i.filled).length,
      domVerified: items.filter(i => i.domVerified).length,
      writeAckReceived: items.filter(i => i.domVerified && ackClean).length,
      serverReadbackVerified: items.filter(i => i.domVerified && i.httpReadbackMatches && i.reloadMatches).length,
      legacyFilledFlag: items.filter(i => i.filled).length
    },
    serverMatchesDom: norm1(httpDraft) === norm1(dom),
    saveStatus, submitRequests: sb.counters.submitRequests,
    domFilledFields: items.filter(i => i.filled).length
  };
  await clearCheckpoint(taskId).catch(() => {});
  return evidence;
}
