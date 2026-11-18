/** Shared helpers: serve fixture HTML under its real-looking URL via Playwright routing (no network). */
import { chromium, type Browser, type Page } from 'playwright';
import type { Question } from '../../src/types.js';
import type { ExpectedQuestion, MoodleFixture } from './moodle-fixtures.js';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function launch(): Promise<Browser> {
  const exe = process.env.AUTOTASK_CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch({ headless: true, ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {}) });
}

/** Serve `html` at `url`; every other request under the same origin returns a 1x1 PNG or 404, never the network. */
export async function openHtml(browser: Browser, url: string, html: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const origin = new URL(url).origin;
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === origin && u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    if (u.origin === origin && /pluginfile|theme|\.png$/i.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
    return route.abort();
  });
  await page.goto(url);
  return page;
}
export const openFixture = (browser: Browser, f: MoodleFixture) => openHtml(browser, f.url, f.html);

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
export interface Mismatch { stableId: string; field: string; expected: unknown; actual: unknown }
export interface Comparison { mismatches: Mismatch[]; matchedQuestions: number; expectedQuestions: number; extraQuestions: string[]; optionTotal: number; optionCorrect: number; typeTotal: number; typeCorrect: number; promptTotal: number; promptCorrect: number }

/** Field-by-field comparison keyed by stableId. */
export function compareExtraction(expected: ExpectedQuestion[], actual: Question[]): Comparison {
  const byStable = new Map(actual.map(q => [q.stableId ?? '', q] as const));
  const out: Comparison = { mismatches: [], matchedQuestions: 0, expectedQuestions: expected.length, extraQuestions: [], optionTotal: 0, optionCorrect: 0, typeTotal: 0, typeCorrect: 0, promptTotal: 0, promptCorrect: 0 };
  const seen = new Set<string>();
  for (const e of expected) {
    const a = byStable.get(e.stableId);
    if (!a) { out.mismatches.push({ stableId: e.stableId, field: 'present', expected: true, actual: false }); continue; }
    seen.add(e.stableId);
    const bad = (field: string, exp: unknown, act: unknown) => out.mismatches.push({ stableId: e.stableId, field, expected: exp, actual: act });
    let allOk = true;
    const check = (field: string, exp: unknown, act: unknown) => { if (JSON.stringify(exp) !== JSON.stringify(act)) { bad(field, exp, act); allOk = false; return false; } return true; };
    check('id', e.id, a.id);
    out.typeTotal++; if (check('kind', e.kind, a.kind) && check('sourceType', e.sourceType, a.sourceType)) out.typeCorrect++;
    out.promptTotal++; if (check('prompt', norm(e.prompt), norm(a.prompt))) out.promptCorrect++;
    check('required', e.required, a.required);
    if (e.options) {
      const expTexts = e.options.map(o => norm(o.text));
      const actTexts = a.options.map(o => norm(o.text));
      out.optionTotal += expTexts.length;
      if (JSON.stringify(expTexts) === JSON.stringify(actTexts)) out.optionCorrect += expTexts.length;
      else { bad('options', expTexts, actTexts); allOk = false; }
      e.options.forEach((o, i) => { if (o.media) check(`option[${i}].media`, [...o.media].sort(), [...new Set((a.options[i]?.media || []).map(m => m.type))].sort()); });
    } else if (a.options.length && e.kind !== 'unsupported') { bad('options', [], a.options.map(o => o.text)); allOk = false; }
    if (e.media) check('media', [...e.media].sort(), [...new Set((a.media || []).filter(m => m.scope === 'question').map(m => m.type))].sort());
    if (e.unsupported) check('unsupportedReason', true, Boolean(a.unsupportedReason));
    if (allOk) out.matchedQuestions++;
  }
  for (const a of actual) if (!seen.has(a.stableId ?? '')) out.extraQuestions.push(`${a.id}:${a.kind}:${a.prompt.slice(0, 50)}`);
  return out;
}
