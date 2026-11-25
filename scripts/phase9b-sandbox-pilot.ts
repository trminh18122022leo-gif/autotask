/** Phase 9B: REAL-AI practice-assisted pilot on the team-owned sandbox, with layered verification and network provenance.
 *  - No mock model. ModelRouter.execute is wrapped by pass-through spies (timing/metadata only).
 *  - globalThis.fetch is wrapped to log ONLY origin+pathname+status+latency of non-loopback calls (never headers, query or body),
 *    so the telemetry proves the model call left the machine without exposing any key.
 *  - The N repeats use the SAME 12 items: they measure run-to-run stability, NOT independent benchmarks (effective n = 11 objective items). */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { readProfilesDb } from '../src/model-center/routing.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { startPracticeSandbox } from '../tests/helpers/practice-sandbox.js';
import { makeConfig, runPractice } from '../tests/helpers/practice-harness.js';
import { redactSecrets } from '../src/security/redact.js';

const runs = Number(process.argv[2] || 3);
const db = await readProfilesDb();
const profileId = db.default; const prof = db.profiles[profileId];
const provider = { kind: prof.provider as any, profileId, model: prof.model, allowVision: false };

const net: { origin: string; path: string; status: number | string; ms: number }[] = [];
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const t = Date.now();
  try { const r = await origFetch(input, init); if (!loopback) net.push({ origin: url.origin, path: url.pathname.replace(/\/models\/[^:]+/, '/models/<model>'), status: r.status, ms: Date.now() - t }); return r; }
  catch (e: any) { if (!loopback) net.push({ origin: url.origin, path: url.pathname, status: `ERR:${e?.cause?.code ?? e?.name ?? 'fetch'}`, ms: Date.now() - t }); throw e; }
}) as typeof fetch;

const calls: any[] = [];
const orig = ModelRouter.execute.bind(ModelRouter);
(ModelRouter as any).execute = async (...args: any[]) => {
  const t = Date.now();
  try { const r: any = await (orig as any)(...args); calls.push({ ms: Date.now() - t, ok: true, finalProfile: r?.finalProfile, attempts: r?.attempts, fallbackCount: r?.fallbackCount, outChars: String(r?.output ?? '').length }); return r; }
  catch (e) { calls.push({ ms: Date.now() - t, ok: false, err: redactSecrets(e instanceof Error ? e.message : String(e)) }); throw e; }
};

const sb = await startPracticeSandbox();
const browser = await chromium.launch({ headless: true });
const out: any = {
  phase: '9B', startedAt: new Date().toISOString(), profileId, provider: prof.provider, model: prof.model,
  evidenceNote: 'Real model via Model Center profile; network provenance in runs[].network. Repeats use the same 12 items (not independent benchmarks).',
  runs: []
};
try {
  for (let i = 0; i < runs; i++) {
    sb.reset(); calls.length = 0; net.length = 0;
    const ev = await runPractice(sb, browser, makeConfig(provider), `phase9b_real_ai_${Date.now()}_${i}`);
    out.runs.push({
      run: i + 1, status: ev.result.status, questionsFound: ev.result.questionsFound, questionsFilled: ev.result.questionsFilled,
      persistence: ev.result.persistence ?? null, counts: ev.counts, writeAcks: ev.writeAcks,
      objective: { n: ev.items.filter(x => x.type !== 'essay').length, correctVsGold: ev.items.filter(x => x.type !== 'essay' && x.correct).length },
      essay: { rubricHeuristicPass: ev.items.find(x => x.type === 'essay')?.correct ?? null, requiresHumanReview: true },
      items: ev.items.map(x => ({ slot: x.slot, type: x.type, level: x.level, domVerified: x.domVerified, httpReadbackMatches: x.httpReadbackMatches, reloadMatches: x.reloadMatches, correctVsGold: x.correct })),
      httpDraftFieldCount: Object.keys(ev.httpDraft).length, domAfterReloadFilled: Object.values(ev.domAfterReload).filter(v => v !== '').length,
      sandbox: { draftReads: sb.counters.draftReads, autosaveRequests: sb.counters.autosaveRequests, submitRequests: sb.counters.submitRequests, unexpectedMethods: [...sb.counters.unexpectedMethods] },
      warnings: ev.result.warnings.map(w => redactSecrets(w).slice(0, 160)),
      modelCalls: [...calls], network: [...net]
    });
    if (ev.result.page && !ev.result.page.isClosed()) await ev.result.page.context().close();
  }
} finally { await browser.close(); await sb.close(); globalThis.fetch = origFetch; }
out.finishedAt = new Date().toISOString();
mkdirSync('reports', { recursive: true });
writeFileSync('reports/phase9b_sandbox_telemetry.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.runs.map((r: any) => ({ run: r.run, status: r.status, counts: r.counts, persistence: r.persistence, objective: r.objective, calls: r.modelCalls.map((c: any) => `${c.ms}ms ok=${c.ok}`), net: r.network })), null, 2));
