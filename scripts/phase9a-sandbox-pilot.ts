/** Phase 9A: REAL-AI practice-assisted pilot against the team-owned sandbox (no LMS access, no mock model).
 *  ModelRouter.execute is wrapped by a pure pass-through SPY that only records timing/metadata (never keys). */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { readProfilesDb } from '../src/model-center/routing.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { startPracticeSandbox } from '../tests/helpers/practice-sandbox.js';
import { makeConfig, runPractice } from '../tests/helpers/practice-harness.js';
import { scanQuestions } from '../src/scanner.js';
import { redactSecrets } from '../src/security/redact.js';

const runs = Number(process.argv[2] || 1);
const db = await readProfilesDb();
const profileId = db.default;
const prof = db.profiles[profileId];
const provider = { kind: prof.provider as any, profileId, model: prof.model, allowVision: false };

const calls: { ms: number; ok: boolean; err?: string; outChars?: number; profile?: string; attempts?: number; fallbackCount?: number }[] = [];
const orig = ModelRouter.execute.bind(ModelRouter);
(ModelRouter as any).execute = async (...args: any[]) => {
  const t = Date.now();
  try {
    const r: any = await (orig as any)(...args);
    calls.push({ ms: Date.now() - t, ok: true, outChars: String(r?.output ?? '').length, profile: r?.finalProfile, attempts: r?.attempts, fallbackCount: r?.fallbackCount });
    return r;
  } catch (e) { calls.push({ ms: Date.now() - t, ok: false, err: redactSecrets(e instanceof Error ? e.message : String(e)) }); throw e; }
};

const sb = await startPracticeSandbox();
const browser = await chromium.launch({ headless: true });
const out: any = { startedAt: new Date().toISOString(), profileId, provider: prof.provider, model: prof.model, runs: [] };
try {
  // Recognition on a fresh page first (independent of the agent run).
  const ctx0 = await browser.newContext(); const p0 = await ctx0.newPage();
  await p0.goto(`${sb.baseUrl}/practice?attempt=9200`);
  const qs = await scanQuestions(p0);
  out.recognition = { found: qs.length, expected: 12, kinds: qs.map(q => `${q.id}:${q.kind}`) };
  await ctx0.close();

  for (let i = 0; i < runs; i++) {
    sb.reset(); calls.length = 0;
    const ev = await runPractice(sb, browser, makeConfig(provider), `phase9a_real_ai_${Date.now()}_${i}`);
    out.runs.push({
      run: i + 1, status: ev.result.status, questionsFound: ev.result.questionsFound, questionsFilled: ev.result.questionsFilled,
      warnings: ev.result.warnings.map(w => redactSecrets(w)),
      domFilledFields: ev.domFilledFields, items: ev.items,
      objective: { n: ev.items.filter(x => x.type !== 'essay').length, correct: ev.items.filter(x => x.type !== 'essay' && x.correct).length },
      essay: ev.items.filter(x => x.type === 'essay').map(x => ({ rubricHeuristicPass: x.correct, requiresHumanReview: true, chars: String(x.domValue).length })),
      serverDraftFields: Object.keys(ev.serverDraft).length, serverMatchesDom: ev.serverMatchesDom, saveStatus: ev.saveStatus,
      autosaveRequests: sb.counters.autosaveRequests, autosavePersisted: sb.counters.autosavePersisted,
      submitRequests: sb.counters.submitRequests, unexpectedMethods: [...sb.counters.unexpectedMethods],
      modelCalls: [...calls]
    });
    if (ev.result.page && !ev.result.page.isClosed()) await ev.result.page.context().close();
  }
} finally { await browser.close(); await sb.close(); }
out.finishedAt = new Date().toISOString();
mkdirSync('reports', { recursive: true });
writeFileSync('reports/phase9a_sandbox_telemetry.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ recognition: out.recognition, runs: out.runs.map((r: any) => ({ run: r.run, status: r.status, found: r.questionsFound, filled: r.questionsFilled, domFilled: r.domFilledFields, objective: r.objective, serverFields: r.serverDraftFields, serverMatchesDom: r.serverMatchesDom, submit: r.submitRequests, modelCalls: r.modelCalls, warnings: r.warnings })) }, null, 2));

