/** Phase 9A: team-owned, ungraded self-practice sandbox with a controllable draft backend.
 *  Never talks to any real LMS. All gold keys here are authored by the dev team (not by any model).
 *  Markup follows Moodle quiz-attempt conventions (div.que) so the production scanner path is exercised. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type SandboxType = 'single' | 'multi' | 'truefalse' | 'text' | 'numeric' | 'formula' | 'essay';
export interface SandboxItem {
  slot: number; type: SandboxType; prompt: string; options?: string[];
  /** Gold: option indexes for choice items, accepted strings (normalised) for text/numeric, rubric keywords for essay. */
  gold: { choice?: number[]; accepted?: string[]; rubric?: string[] };
}

export const SANDBOX_ITEMS: SandboxItem[] = [
  { slot: 1, type: 'single', prompt: 'Which HTTP status code means "Not Found"?', options: ['200', '301', '404', '500'], gold: { choice: [2] } },
  { slot: 2, type: 'single', prompt: 'Which data structure is First-In First-Out?', options: ['Stack', 'Queue', 'Binary heap'], gold: { choice: [1] } },
  { slot: 3, type: 'multi', prompt: 'Select all prime numbers.', options: ['11', '15', '17', '21'], gold: { choice: [0, 2] } },
  { slot: 4, type: 'multi', prompt: 'Select all transport-layer protocols.', options: ['TCP', 'UDP', 'HTTP', 'ARP'], gold: { choice: [0, 1] } },
  { slot: 5, type: 'truefalse', prompt: 'Binary search on a sorted array of n items has worst-case time O(log n).', options: ['True', 'False'], gold: { choice: [0] } },
  { slot: 6, type: 'truefalse', prompt: 'A TCP connection is established with a two-way handshake.', options: ['True', 'False'], gold: { choice: [1] } },
  { slot: 7, type: 'text', prompt: 'What is the chemical symbol for Iron?', gold: { accepted: ['fe'] } },
  { slot: 8, type: 'text', prompt: 'Which default TCP port does HTTPS use?', gold: { accepted: ['443'] } },
  { slot: 9, type: 'numeric', prompt: 'Compute 15 * 12.', gold: { accepted: ['180'] } },
  { slot: 10, type: 'formula', prompt: 'Evaluate the derivative of f(x) = 3x^2 + 4x - 5 at x = 2.', gold: { accepted: ['16'] } },
  { slot: 11, type: 'formula', prompt: 'Find the positive root of \\(x^2 - 9 = 0\\).', gold: { accepted: ['3'] } },
  { slot: 12, type: 'essay', prompt: 'In 2-4 sentences explain why caching improves web performance.', gold: { rubric: ['latency', 'repeat', 'server', 'faster', 'load', 'network'] } }
];

export interface SandboxFaults {
  /** Delay (ms) before the practice page HTML is sent. */
  pageDelayMs: number;
  /** Autosave returns HTTP 500. */
  autosave500: boolean;
  /** Autosave returns 200 ACK but does NOT persist (silent drop). */
  autosaveSilentDrop: boolean;
  /** Autosave returns 401 (session expired). */
  sessionExpired: boolean;
  /** Page script rewrites the DOM (renames controls) shortly after load: simulates changed fields. */
  mutateFieldsAfterLoad: boolean;
  /** Page script resets every text input to '' on input (silent DOM reset trap). */
  textResetTrap: boolean;
  /** After a text input fires `change`, the page rewrites its value ~120 ms later (drift AFTER the agent's immediate readback). */
  changeRewrite: boolean;
}

export interface SandboxServer {
  baseUrl: string; port: number;
  drafts: Map<string, Record<string, string | string[]>>;
  counters: { pageLoads: number; autosaveRequests: number; autosavePersisted: number; submitRequests: number; draftReads: number; unknownGets: string[]; unexpectedMethods: string[] };
  faults: SandboxFaults;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_FAULTS = (): SandboxFaults => ({ pageDelayMs: 0, autosave500: false, autosaveSilentDrop: false, sessionExpired: false, mutateFieldsAfterLoad: false, textResetTrap: false, changeRewrite: false });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
type Draft = Record<string, string>;

function renderItem(it: SandboxItem, attempt: number, draft: Draft = {}): string {
  const name = `q${attempt}:${it.slot}`;
  let body = '';
  let cls = 'multichoice';
  if (it.type === 'single' || it.type === 'truefalse') {
    cls = it.type === 'truefalse' ? 'truefalse' : 'multichoice';
    body = `<div class="ablock"><div class="answer">${it.options!.map((o, i) => `<div><input type="radio" name="${name}_answer" id="q${it.slot}o${i}" value="${i}"${draft[`${name}_answer`] === String(i) ? ' checked' : ''}><label for="q${it.slot}o${i}">${esc(o)}</label></div>`).join('')}</div></div>`;
  } else if (it.type === 'multi') {
    body = `<div class="ablock"><div class="answer">${it.options!.map((o, i) => `<div><input type="checkbox" name="${name}_c${i}" id="q${it.slot}o${i}" value="1"${draft[`${name}_c${i}`] === '1' ? ' checked' : ''}><label for="q${it.slot}o${i}">${esc(o)}</label></div>`).join('')}</div></div>`;
  } else if (it.type === 'essay') {
    cls = 'essay';
    body = `<div class="ablock"><textarea name="${name}_answer" aria-label="Answer" rows="5" cols="60">${esc(draft[`${name}_answer`] ?? '')}</textarea></div>`;
  } else {
    cls = it.type === 'text' ? 'shortanswer' : 'numerical';
    body = `<div class="ablock"><input type="text" name="${name}_answer" aria-label="Answer" value="${attr(draft[`${name}_answer`] ?? '')}"></div>`;
  }
  return `<div id="question-${attempt}-${it.slot}" class="que ${cls}"><div class="formulation"><div class="qtext"><p>${esc(it.prompt)}</p></div>${body}</div></div>`;
}

export function renderPracticePage(attempt: number, faults: SandboxFaults, draft: Draft = {}): string {
  const rewrite = faults.changeRewrite
    ? `document.addEventListener('change',e=>{if(e.target.matches('input[type=text]')){const el=e.target;setTimeout(()=>{el.value=el.value+'?';},120);}});` : '';
  const mut = faults.mutateFieldsAfterLoad
    ? `setTimeout(()=>{document.querySelectorAll('input[type=text],textarea').forEach(el=>{el.setAttribute('name','renamed_'+Math.random().toString(36).slice(2));el.replaceWith(el.cloneNode(true));});},150);` : '';
  const trap = faults.textResetTrap ? `document.addEventListener('input',e=>{if(e.target.matches('input[type=text]'))e.target.value='';});` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="Moodle 4.3"><title>Team Sandbox Practice (ungraded)</title></head>
<body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz moodle" data-sandbox="phase9a">
<h1>Team-owned sandbox practice - ungraded</h1><div id="save-status" aria-live="polite">not saved</div>
<form id="responseform" method="post" action="/sandbox/submit-not-used" onsubmit="return false">
${SANDBOX_ITEMS.map(it => renderItem(it, attempt, draft)).join('\n')}
<button type="button" id="operator-submit" data-operator-only="true">Finish attempt (operator only)</button>
</form>
<script>
const form=document.getElementById('responseform');const st=document.getElementById('save-status');
function snapshot(){const o={};form.querySelectorAll('input,textarea').forEach(el=>{if(!el.name)return;
 if(el.type==='radio'){if(el.checked)o[el.name]=el.value;}
 else if(el.type==='checkbox'){if(el.checked)o[el.name]='1';}
 else o[el.name]=el.value;});return o;}
let timer=null;
async function autosave(){try{const r=await fetch('/api/sandbox/autosave',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attempt:${attempt},answers:snapshot()})});
 st.textContent=r.ok?'saved '+new Date().toISOString():'save failed '+r.status;st.dataset.state=r.ok?'saved':'failed';st.dataset.status=String(r.status);}catch(e){st.textContent='save failed network';st.dataset.state='failed';st.dataset.status='network';}}
form.addEventListener('change',()=>{clearTimeout(timer);timer=setTimeout(autosave,50);});
document.getElementById('operator-submit').addEventListener('click',()=>{fetch('/api/sandbox/submit',{method:'POST',body:'{}'});});
${trap}${mut}${rewrite}
</script></body></html>`;
}

export async function startPracticeSandbox(): Promise<SandboxServer> {
  const faults = DEFAULT_FAULTS();
  const drafts = new Map<string, Record<string, string | string[]>>();
  const counters = { pageLoads: 0, autosaveRequests: 0, autosavePersisted: 0, submitRequests: 0, draftReads: 0, unknownGets: [] as string[], unexpectedMethods: [] as string[] };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const readBody = () => new Promise<string>(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    if (u.pathname === '/practice' && req.method === 'GET') {
      counters.pageLoads++;
      if (faults.pageDelayMs) await new Promise(r => setTimeout(r, faults.pageDelayMs));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderPracticePage(Number(u.searchParams.get('attempt') || 9200), faults, (drafts.get(u.searchParams.get('attempt') || '9200') || {}) as Record<string, string>));
    }
    if (u.pathname === '/api/sandbox/autosave' && req.method === 'POST') {
      counters.autosaveRequests++;
      const body = JSON.parse((await readBody()) || '{}');
      if (faults.sessionExpired) { res.writeHead(401); return res.end('{"error":"session expired"}'); }
      if (faults.autosave500) { res.writeHead(500); return res.end('{"error":"server error"}'); }
      if (faults.autosaveSilentDrop) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      drafts.set(String(body.attempt), body.answers || {});
      counters.autosavePersisted++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (u.pathname === '/api/sandbox/draft' && req.method === 'GET') {
      counters.draftReads++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(drafts.get(u.searchParams.get('attempt') || '9200') || {}));
    }
    if (u.pathname === '/api/sandbox/submit') { counters.submitRequests++; res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.method !== 'GET') counters.unexpectedMethods.push(`${req.method} ${u.pathname}`); else counters.unknownGets.push(u.pathname);
    res.writeHead(404); res.end('not found');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, port, drafts, counters, faults,
    reset() { Object.assign(faults, DEFAULT_FAULTS()); drafts.clear(); counters.pageLoads = counters.autosaveRequests = counters.autosavePersisted = counters.submitRequests = counters.draftReads = 0; counters.unexpectedMethods.length = 0; counters.unknownGets.length = 0; },
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); })
  };
}

/** Normalise a text answer for gold comparison. */
export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
