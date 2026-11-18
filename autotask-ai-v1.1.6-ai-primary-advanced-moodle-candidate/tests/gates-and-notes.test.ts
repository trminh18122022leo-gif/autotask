import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAccess,durationSeconds,mostRestrictive} from '../src/access-gates.js';
import {cleanNote,notesFor,validateVault} from '../src/ai-notes.js';
import {parseDeadline} from '../src/calendar.js';
import {kindFor} from '../src/discovery.js';

test('FAMI reading gate recognizes 15-minute requirement without simulating reading',()=>{
 const time=new Date('2026-10-27T04:00:00.000Z');
 const gates=classifyAccess('Bạn đọc quá nhanh. Hãy xem lại tài liệu trước khi có thể bắt đầu thi. Thời gian đọc còn lại 15 phút','https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5514',time);
 assert.equal(gates[0].kind,'FAMI_READING');assert.equal(gates[0].blocked,true);
 assert.equal(gates[0].remainingSeconds,900);
 assert.equal(gates[0].recheckAfter,'2026-10-27T04:15:00.000Z');
});
test('No FAMI wait gate on an ordinary page',()=>{
 assert.equal(classifyAccess('Bài học 1 đang hiển thị','https://fami.hust.edu.vn/sohoa/phong-hoc').length,0);
});
test('Moodle future activity and phased entry are blocked',()=>{
 const locked=classifyAccess('Your turn for this quiz will start in about 12:34:39. This quiz is currently not available.', 'https://lms.hust.edu.vn/mod/quiz/view.php?id=2');
 assert.equal(mostRestrictive(locked)?.kind,'PHASED_ENTRY');
 const simplyLocked=classifyAccess('This quiz is currently not available.', 'https://lms.hust.edu.vn/mod/quiz/view.php');
 assert.equal(mostRestrictive(simplyLocked)?.kind,'NOT_YET_OPEN');
});
test('Quiz timer is informational, not availability gate',()=>{
 const gates=classifyAccess('Time left 09:58. Question 1','https://lms.hust.edu.vn/mod/quiz/attempt.php');
 assert.equal(gates[0].kind,'QUIZ_TIMER');assert.equal(gates[0].blocked,false);assert.equal(gates[0].remainingSeconds,598);
 assert.equal(mostRestrictive(gates),undefined);
});
test('Durations parse Vietnamese minutes, seconds and digital format',()=>{
 assert.equal(durationSeconds('còn 15 phút'),900);assert.equal(durationSeconds('00:01:45'),105);assert.equal(durationSeconds('3 giờ 12 phút'),11520);
});
test('Explicit scoped AI notes compose safely',()=>{
 const vault=validateVault({global:'Không thêm dữ liệu ngoài yêu cầu',byHost:{'lms.example.edu':'Dùng tiếng Việt'},byTask:{unit2:'Viết ngắn gọn'}});
 assert.equal(notesFor(vault,'unit2','https://lms.example.edu/task','Trình bày theo bảng'),'Không thêm dữ liệu ngoài yêu cầu\n\nDùng tiếng Việt\n\nViết ngắn gọn\n\nTrình bày theo bảng');
 assert.throws(()=>cleanNote('password=abc123'));
});
test('Moodle Closed date is parsed rather than Opened date',()=>{
 const raw='Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM';
 assert.equal(parseDeadline(raw,'+07:00'),'2026-11-14T16:59:00.000Z');
 assert.equal(parseDeadline('Closed: Saturday, 3 October 2026, 11:59 PM','+07:00'),'2026-10-03T16:59:00.000Z');
});
test('Recognizes FAMI exam and course routes',()=>{
 assert.equal(kindFor('CD4 exam','https://fami.hust.edu.vn/sohoa/thi-lt'),'quiz');
 assert.equal(kindFor('Bài kiểm tra','https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5514'),'quiz');
 assert.equal(kindFor('Lớp học','https://fami.hust.edu.vn/sohoa/phong-hoc'),'course');
});
test('Foregound gate watcher rechecks genuine site state, with no synthetic reading',async()=>{
 const {watchUntilAccessible}=await import('../src/access-gates.js');
 let count=0,clock=0;
 const observer=async()=>{count++;return count===1?[{kind:'FAMI_READING' as const,blocked:true,reason:'read first',observedAt:new Date(0).toISOString()}]:[]};
 const finished=await watchUntilAccessible(observer,1,undefined,async ms=>{clock+=ms},()=>clock);
 assert.equal(finished.ready,true);assert.equal(finished.checks,2);
 assert.equal((await watchUntilAccessible(async()=>[{kind:'NOT_YET_OPEN' as const,blocked:true,reason:'scheduled',observedAt:''}],0)).ready,false);
});
