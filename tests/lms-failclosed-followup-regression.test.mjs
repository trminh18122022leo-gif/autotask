/**
 * Independent negative security regressions — local temporary ledger only.
 * Run from a freshly extracted AutoTask AI ZIP root:
 *   node scripts/offline-build.cjs
 *   node --test /absolute/path/to/AUTOTASK_AI_V116_FAILCLOSED_FOLLOWUP_REGRESSIONS.test.mjs
 * Never touches a real LMS or the user's .private directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'dist/src/quiz-start-policy.js')).href;
const {claimDurableGrant, readDurableGrants, setDurableLedgerPath, resetStartGrantLedger} = await import(moduleUrl);
function sandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-lock-audit-'));
  const ledger = path.join(dir,'grants.json');
  resetStartGrantLedger(); setDurableLedgerPath(ledger);
  try { return fn({dir,ledger}); }
  finally { setDurableLedgerPath(null); resetStartGrantLedger(); fs.rmSync(dir,{recursive:true,force:true}); }
}

test('LOCK-01: never steal an old lock still owned by a live process', () => sandbox(({ledger}) => {
  const lock = ledger + '.lock';
  fs.writeFileSync(lock, JSON.stringify({pid:process.pid,time:Date.now()-10000}));
  const old = new Date(Date.now()-10000);
  fs.utimesSync(lock,old,old);
  const res = claimDurableGrant('audit-lock-live-process','audit-task');
  assert.equal(res.success, false, `Live-owner lock was removed and a grant issued: ${JSON.stringify(res)}`);
  assert.equal(fs.existsSync(lock), true, 'A lock held by a live process was deleted');
}));

test('SCHEMA-01: reject a grant record missing its declared identity fields', () => sandbox(({ledger}) => {
  fs.writeFileSync(ledger, JSON.stringify({'audit-key':{taskId:'audit-task',consumedAt:new Date().toISOString()}}));
  const res = readDurableGrants();
  assert.equal(res.status,'ERROR',`Incomplete record accepted as ${res.status}`);
}));

const { evaluateQuizStartPolicy } = await import(moduleUrl);
async function policyWithLiveApproval(ledger) {
  const url='https://lms.hust.edu.vn/mod/quiz/view.php?id=55';
  const task={id:'audit-interactive',url,title:'Ungraded practice',aiPermitted:true,confirmStartNewAttempt:false};
  const page={url:()=>url,title:async()=>task.title};
  const inspection={hasContinueAttemptControl:false,hasNewAttemptControl:true,hasStartAttemptForm:true,exhaustedAttempts:false,scope:'PRACTICE_VERIFIED',scopeEvidence:'test fixture verified ungraded practice',newAttemptLabel:'Attempt quiz now'};
  const config={allowedHosts:['lms.hust.edu.vn'],approvedForAIUse:true,operationMode:'PRACTICE_ASSISTED',parallelTabs:1,tasks:[],provider:{kind:'openai-compatible',model:'test'},confirmAttemptStart:async()=>true};
  return evaluateQuizStartPolicy({page,task,config,platform:'moodle',inspection});
}

test('CALLBACK-01: corrupt ledger MUST block even if interactive callback approved',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autotask-cb-audit-'));
  const ledger=path.join(dir,'ledger.json');
  try {
    fs.writeFileSync(ledger,'{CORRUPTED'); resetStartGrantLedger();setDurableLedgerPath(ledger);
    const got=await policyWithLiveApproval(ledger);
    assert.notEqual(got.action,'START_NEW_ATTEMPT',`Interactive approval bypassed corrupt ledger: ${JSON.stringify(got)}`);
  } finally {setDurableLedgerPath(null);resetStartGrantLedger();fs.rmSync(dir,{recursive:true,force:true});}
});

test('CALLBACK-02: failed ledger write MUST block even if interactive callback approved',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autotask-cb-audit-'));
  const ledger=path.join(dir,'ledger.json');
  try {
    fs.mkdirSync(ledger); resetStartGrantLedger();setDurableLedgerPath(ledger);
    const got=await policyWithLiveApproval(ledger);
    assert.notEqual(got.action,'START_NEW_ATTEMPT',`Interactive approval bypassed write failure: ${JSON.stringify(got)}`);
  } finally {setDurableLedgerPath(null);resetStartGrantLedger();fs.rmSync(dir,{recursive:true,force:true});}
});
