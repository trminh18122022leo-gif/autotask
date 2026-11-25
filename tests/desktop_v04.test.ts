import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderJobs,runExclusiveQueue,QueueStore} from '../src/desktop-queue.js';
import {safeEndpoint} from '../src/providers.js';
import {validateDecision} from '../src/desktop.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('model endpoint requires safe HTTPS without embedded secrets',()=>{
 assert.throws(()=>safeEndpoint('http://example.com/chat'));
 assert.throws(()=>safeEndpoint('https://password:secret@example.com/chat'));
 assert.equal(safeEndpoint('https://api.example.com/v1/chat/completions').hostname,'api.example.com');
});
test('job ordering by priority then deadline',()=>{
 const jobs=[{taskId:'later',priority:1,deadline:'2027-01-01'},{taskId:'high',priority:2},{taskId:'earlier',priority:1,deadline:'2026-11-01'}];
 assert.deepEqual(orderJobs(jobs).map(j=>j.taskId),['high','earlier','later']);
});
test('physical input queue never overlaps concurrent workers',async()=>{
 let active=0,max=0;const done:string[]=[];
 await runExclusiveQueue([{taskId:'a'},{taskId:'b'},{taskId:'c'}],async job=>{
  active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,8));done.push(job.taskId);active--;
 });
 assert.equal(max,1);assert.deepEqual(done,['a','b','c']);
});
test('restart never blindly replays an interrupted in-flight job',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'autotask-test-'));
 try {
  const store=new QueueStore(join(dir,'queue.json'));
  const s=await store.init([{taskId:'started'},{taskId:'later'}],false);
  await store.change(s,'started','RUNNING',2);
  const resumed=await store.init([{taskId:'started'},{taskId:'later'}],true);
  assert.equal(resumed.jobs[0].status,'NEEDS_REVIEW');assert.equal(resumed.jobs[1].status,'PENDING');
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('vision grounding rejects out of frame or unsupported action',()=>{
 const a=JSON.stringify({action:{kind:'click_visual',bbox:[.1,.2,.25,.3],label:'Settings',confidence:.94}});
 assert.equal(validateDecision(a).action.kind,'click_visual');
 assert.throws(()=>validateDecision(JSON.stringify({action:{kind:'click_visual',bbox:[.1,.2,1.3,.3],label:'Settings',confidence:.94}})));
 assert.throws(()=>validateDecision('{"action":{"kind":"run_shell"}}'));
});
