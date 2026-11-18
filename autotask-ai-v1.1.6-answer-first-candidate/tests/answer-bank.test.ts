import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAnswerBanks, answerFromBank, splitBankAndAi } from '../src/answer-bank.js';
import type { Question } from '../src/types.js';
const q=(id:string,kind:Question['kind'],prompt:string):Question=>({id,kind,prompt,options:kind==='radio'||kind==='select'||kind==='checkbox'?[{id:'0',text:'Paris'},{id:'1',text:'Lyon'}]:[],required:true,hasVisual:false,stableId:'question-777-1'});
async function sandbox(fn:(d:string)=>Promise<void>){const d=mkdtempSync(join(tmpdir(),'atqa-answer-bank-'));try{await fn(d)}finally{rmSync(d,{recursive:true,force:true})}}
test('bank JSON selects by exact stable ID, maps text after option shuffle, AI receives only missing questions',async()=>sandbox(async d=>{
 const file=join(d,'answers.json');writeFileSync(file,JSON.stringify({answers:[{stableId:'question-777-1',answer:'Paris'}]}));
 const bank=await loadAnswerBanks([file]);
 const {bankAnswers,unmatched}=splitBankAndAi([q('m1','radio','Capital?'),{...q('m2','text','Other?'),stableId:'question-777-2'}],bank);
 assert.deepEqual(bankAnswers.map(a=>a.selected),[['0']]);assert.equal(unmatched.length,1);
}));
test('CSV quotes, TXT Q/A, and exact prompt matching',async()=>sandbox(async d=>{
 const csv=join(d,'answer.csv'),txt=join(d,'answers.txt');
 writeFileSync(csv,'question,answer\n"Which capital, France?",Paris\n');
 writeFileSync(txt,'Q: Derivative of x²?\nA: 2x\n');
 const bank=await loadAnswerBanks([csv,txt]);
 assert.deepEqual(answerFromBank({...q('m2','radio','Which capital, France?'),stableId:'unmatched'},bank)?.selected,['0']);
 assert.equal(answerFromBank({...q('m3','text','Derivative of x²?'),stableId:'other'},bank)?.text,'2x');
}));
test('ambiguous answer keys are never guessed',async()=>sandbox(async d=>{
 const file=join(d,'dup.json');writeFileSync(file,JSON.stringify([{question:'Same?',answer:'Paris'},{question:'Same?',answer:'Lyon'}]));
 const bank=await loadAnswerBanks([file]);
 assert.equal(answerFromBank({...q('m4','radio','Same?'),stableId:'not-matched'},bank),undefined);
}));
test('local file references are resolved relative to the answer file, no upload is fabricated',async()=>sandbox(async d=>{
 const file=join(d,'upload.json');writeFileSync(file,JSON.stringify([{id:'upload1',filePath:'my-handout.pdf'}]));
 const bank=await loadAnswerBanks([file]);
 assert.equal(answerFromBank({...q('upload1','file','Upload a file'),stableId:'x'},bank)?.localFilePath,join(d,'my-handout.pdf'));
}));
test('malformed answer files fail visibly instead of silently calling AI for every question',async()=>sandbox(async d=>{
 const file=join(d,'bad.csv');writeFileSync(file,'foo,bar\nX,Y\n');
 await assert.rejects(loadAnswerBanks([file]),/requires an answer/);
}));

test('repeated generic question prompts cannot share one bank answer',async()=>sandbox(async d=>{
 const file=join(d,'answers.txt');writeFileSync(file,'Q: Select the right answer\nA: Paris\n');
 const bank=await loadAnswerBanks([file]);
 const qs=[{...q('q1','radio','Select the right answer'),stableId:'id-1'},{...q('q2','radio','Select the right answer'),stableId:'id-2'}];
 const r=splitBankAndAi(qs,bank);assert.equal(r.bankAnswers.length,0);assert.equal(r.unmatched.length,2);
}));
