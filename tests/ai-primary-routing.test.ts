import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswerSourceMode, partitionByAnswerSource, isFormEntrySurface } from '../src/answer-routing.js';
import type { Question, AnswerSourceMode } from '../src/types.js';
import type { AnswerBank } from '../src/answer-bank.js';

const qs:Question[]=[
 {id:'q1',kind:'text',prompt:'Full name',options:[],required:true,hasVisual:false,stableId:'field:name'},
 {id:'q2',kind:'radio',prompt:'Choose subject',options:[{id:'0',text:'Math'},{id:'1',text:'English'}],required:true,hasVisual:false,stableId:'field:subject'},
 {id:'q3',kind:'text',prompt:'Unmatched field',options:[],required:true,hasVisual:false,stableId:'field:extra'}
];
const bank:AnswerBank={rows:[{stableId:'field:name',text:'Example Person'},{stableId:'field:subject',answer:'Math'}],warnings:[],sources:['form.csv']};
const url='https://forms.example.edu/register';
const route=(mode:AnswerSourceMode, platform:'generic'|'moodle'|'english-discoveries'|'fami',page=url)=>partitionByAnswerSource(qs,bank,mode,platform,page);

test('AI_PRIMARY is the default even when a form data file was saved in the config',()=>{
 assert.equal(resolveAnswerSourceMode({},{answerSourceMode:undefined}), 'AI_PRIMARY');
 assert.deepEqual(route('AI_PRIMARY','generic').bankAnswers,[]);
 assert.deepEqual(route('AI_PRIMARY','generic').unmatched.map(q=>q.id),['q1','q2','q3']);
});
test('FORM_FILE is an explicit optional mode: form fields from file, missing fields use AI',()=>{
 const result=route('FORM_FILE','generic');
 assert.deepEqual(result.bankAnswers.map(a=>a.id),['q1','q2']);
 assert.equal(result.bankAnswers[0].text,'Example Person');
 assert.deepEqual(result.bankAnswers[1].selected,['0']);
 assert.deepEqual(result.unmatched.map(q=>q.id),['q3']);
});
test('form file never replaces AI on a Moodle quiz, including direct attempt URL',()=>{
 const r=route('FORM_FILE','moodle','https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=8');
 assert.equal(r.bankAnswers.length,0);
 assert.deepEqual(r.unmatched.map(q=>q.id),['q1','q2','q3']);
});
test('form file does not override English Discoveries or FAMI exercises',()=>{
 for (const p of ['english-discoveries','fami'] as const){
  assert.equal(route('FORM_FILE',p).bankAnswers.length,0);
  assert.equal(route('FORM_FILE',p).unmatched.length,3);
 }
});
test('generic quiz and assessment paths remain AI-primary even with form file enabled',()=>{
 for (const p of ['/quiz/start','/assessment/test','/thi/123','/kiem-tra/1']){
  assert.equal(isFormEntrySurface('generic','https://example.edu'+p),false);
  assert.equal(route('FORM_FILE','generic','https://example.edu'+p).bankAnswers.length,0);
 }
});
test('task-level AI_PRIMARY overrides global FORM_FILE without deleting user files',()=>{
 assert.equal(resolveAnswerSourceMode({answerSourceMode:'FORM_FILE'},{answerSourceMode:'AI_PRIMARY'}),'AI_PRIMARY');
 assert.equal(resolveAnswerSourceMode({answerSourceMode:'AI_PRIMARY'},{answerSourceMode:'FORM_FILE'}),'FORM_FILE');
});
