import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureAllowed,validateConfig} from '../src/config.js';
import {parseDeadline} from '../src/calendar.js';
import {checkAnswers} from '../src/ai.js';
import type {AppConfig, Question} from '../src/types.js';

test('host allowlist rejects spoof domains',()=>{
 assert.equal(ensureAllowed('https://lms.hust.edu.vn/courses',['lms.hust.edu.vn']).hostname,'lms.hust.edu.vn');
 assert.throws(()=>ensureAllowed('https://lms.hust.edu.vn.evil.net',['lms.hust.edu.vn']));
 assert.throws(()=>ensureAllowed('https://other.net',['lms.hust.edu.vn']));
});
test('blocks password embedded in URL',()=>assert.throws(()=>ensureAllowed('https://a:b@example.edu/',['example.edu'])));
test('parse Vietnamese deadline format',()=>assert.equal(parseDeadline('09/11/2026 17:00'), '2026-11-09T10:00:00.000Z'));
test('unparsable deadline is unknown',()=>assert.equal(parseDeadline('as soon as possible'),null));
test('validate disallows missing AI consent',()=>{
 const config:AppConfig={approvedForAIUse:false,allowedHosts:['localhost'],parallelTabs:1,authUrls:[],deadlinePages:[],tasks:[{id:'1',url:'http://localhost:4174',aiPermitted:true}],provider:{profileId:'unused-for-test'}};
 assert.throws(()=>validateConfig(config));
});
test('answer option must match known option IDs',()=>{
 const q:Question={id:'q1',kind:'radio',prompt:'...',options:[{id:'q1_o0',text:'1'}],required:true,hasVisual:false};
 assert.throws(()=>checkAnswers({answers:[{id:'q1',selected:['q1_o4']}]},[q]));
 assert.equal(checkAnswers({answers:[{id:'q1',selected:['q1_o0']}]},[q]).length,1);
});
