import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAdvancedPracticeQuestions,practiceAttachmentAnswer,validatePracticeAttachment,fillCodeDraft,fillOrdering,fillDragDrop} from '../src/lms/advanced-adapters.js';
import {checkAnswers} from '../src/ai.js';
import type {Question,Task} from '../src/types.js';

const base=(type:string,id='m1'):Question=>({id,kind:'unsupported',prompt:'Synthetic permitted practice',options:[],required:false,hasVisual:false,stableId:'question-7001-1',sourceType:'moodle:'+type,unsupportedReason:'Unsupported by default'});
const task:Task={id:'practice-one',url:'http://127.0.0.1:4000/mod/quiz/attempt.php?attempt=77',aiPermitted:true,mode:'PRACTICE_ASSISTED',scopeAttestation:'PERMITTED_SELF_PRACTICE',advancedLmsAdapters:{ordering:true,dragdrop:true,codeDraft:true,fileManager:true}};
function browserLike(mode:string){
 const assignments:any[]=[];
 const browser={evaluate:async (_fn:any,args:any)=>{
  assignments.push(args);
  if(mode==='missing')return null;
  if(args.mode==='code')return {mode:'code',items:[],zones:[]};
  if(args.mode==='ordering')return {mode:'ordering',items:[{id:args.qid+'_o0',text:'one'},{id:args.qid+'_o1',text:'two'}],zones:[]};
  if(args.mode==='dragdrop')return {mode:'dragdrop',items:[{id:args.qid+'_o0',text:'Paris'}],zones:[{id:args.qid+'_z0',text:'France'}]};
  if(args.mode==='file')return {mode:'file',items:[],zones:[]};
  return null;
 }};
 return {browser:browser as any,assignments};
}
test('ADV-01: all adapters fail closed by default and for non-practice tasks',async()=>{
 const {browser,assignments}=browserLike('ok');
 assert.deepEqual(await prepareAdvancedPracticeQuestions(browser,[base('ordering')],{...task,advancedLmsAdapters:undefined}),[base('ordering')]);
 assert.deepEqual(await prepareAdvancedPracticeQuestions(browser,[base('ordering')],{...task,mode:'READ_ONLY'}),[base('ordering')]);
 assert.deepEqual(await prepareAdvancedPracticeQuestions(browser,[base('ordering')],{...task,scopeAttestation:undefined}),[base('ordering')]);
 assert.equal(assignments.length,0);
});
test('ADV-02: ordering exposes a unique sequence of scanned items, not guessed index choices',async()=>{
 const {browser}=browserLike('ok');
 const [q]=await prepareAdvancedPracticeQuestions(browser,[base('ordering')],task);
 assert.equal(q.kind,'ordering'); assert.equal(q.options.length,2);
 assert.deepEqual(checkAnswers({answers:[{id:q.id,selected:[q.options[1].id,q.options[0].id]}]},[q])[0].selected,['m1_o1','m1_o0']);
 assert.throws(()=>checkAnswers({answers:[{id:q.id,selected:['m1_o0','m1_o0']}]},[q]),/permutation/);
});
test('ADV-03: dragdrop validates item and target IDs and forbids invented targets',async()=>{
 const {browser}=browserLike('ok');
 const [q]=await prepareAdvancedPracticeQuestions(browser,[base('ddwtos')],task);
 assert.equal(q.kind,'dragdrop');assert.deepEqual(q.zones?.map(x=>x.id),['m1_z0']);
 assert.equal(checkAnswers({answers:[{id:q.id,placements:[{itemId:'m1_o0',zoneId:'m1_z0'}]}]},[q]).length,1);
 assert.throws(()=>checkAnswers({answers:[{id:q.id,placements:[{itemId:'m1_o0',zoneId:'m1_z9'}]}]},[q]),/Invalid drag\/drop/);
});
test('ADV-04: CodeRunner becomes a DRAFT field only when explicitly opted in and editor is recognized',async()=>{
 const {browser}=browserLike('ok');
 const [q]=await prepareAdvancedPracticeQuestions(browser,[base('coderunner')],task);
 assert.equal(q.kind,'code');assert.equal(checkAnswers({answers:[{id:q.id,text:'print(2)'}]},[q]).length,1);
 const missing=browserLike('missing');
 assert.equal((await prepareAdvancedPracticeQuestions(missing.browser,[base('coderunner')],task))[0].kind,'unsupported');
});
test('ADV-05: Moodle file manager only receives explicit user-selected path and never AI-generated local path',async()=>{
 const q={...base('essay','m1_att'),stableId:'question-7001-1#attachment'};
 const {browser}=browserLike('ok');
 assert.equal((await prepareAdvancedPracticeQuestions(browser,[q],task))[0].kind,'unsupported');
 const [promoted]=await prepareAdvancedPracticeQuestions(browser,[q],{...task,attachmentFiles:{'m1_att':'/tmp/report.pdf'}});
 assert.equal(promoted.kind,'moodle-file');assert.equal(practiceAttachmentAnswer(promoted,{...task,attachmentFiles:{'m1_att':'/tmp/report.pdf'}})?.localFilePath,'/tmp/report.pdf');
 assert.throws(()=>checkAnswers({answers:[{id:promoted.id,localFilePath:'/tmp/stolen.pdf'}]},[promoted]),/Model is not permitted/);
});
test('ADV-06: validates attachment size, type, no symlink and only a user-selected local file',async()=>{
 const d=mkdtempSync(join(tmpdir(),'autotask-adapter-'));
 try{const file=join(d,'report.pdf');writeFileSync(file,'fake local PDF fixture');assert.equal(await validatePracticeAttachment(file),file);
 await assert.rejects(validatePracticeAttachment(join(d,'../not-exist.pdf')));
 writeFileSync(join(d,'payload.exe'),'not permitted');await assert.rejects(validatePracticeAttachment(join(d,'payload.exe')),/not permitted/);
 }finally{rmSync(d,{force:true,recursive:true});}
});
test('ADV-07: ordering action verifies DOM order after dragTo, refusing silent plugin failure',async()=>{
 const q:Question={...base('ordering'),kind:'ordering',options:[{id:'m1_o0',text:'One'},{id:'m1_o1',text:'Two'}]};
 let order=['m1_o0','m1_o1'];let active=false;
 const root:any={count:async()=>1,locator:(sel:string)=>{
  if(sel==='[data-atqa-choice]')return {evaluateAll:async()=>[...order]};
  const id=sel.match(/data-atqa-choice="(.*?)"/)?.[1];
  return {dragTo:async(dest:any)=>{if(active){order=['m1_o1','m1_o0'];}}};
 }};
 const target:any={locator:()=>root};
 await assert.rejects(fillOrdering(target,q,{id:'m1',selected:['m1_o1','m1_o0']}),/not confirmed/);
 active=true;await fillOrdering(target,q,{id:'m1',selected:['m1_o1','m1_o0']});assert.deepEqual(order,['m1_o1','m1_o0']);
});
test('ADV-08: dragdrop action refuses unverified DOM mutation even when dragTo does not throw',async()=>{
 const q:Question={...base('ddwtos'),kind:'dragdrop',options:[{id:'m1_o0',text:'Paris'}],zones:[{id:'m1_z0',text:'France'}]};
 const root:any={count:async()=>1,locator:(sel:string)=>{
  if(sel.includes('input[type="hidden"]'))return {evaluateAll:async()=>['q1=empty']};
  if(sel.includes('data-atqa-zone'))return {count:async()=>1,evaluate:async()=>false};
  return {count:async()=>1,dragTo:async()=>{}};
 }};
 await assert.rejects(fillDragDrop({locator:()=>root} as any,q,{id:'m1',placements:[{itemId:'m1_o0',zoneId:'m1_z0'}]}),/not confirmed/);
});
