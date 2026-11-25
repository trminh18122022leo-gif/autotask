/** Local, network-free Browser DOM E2E. No site credentials and no real submissions. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readdir,unlink} from 'node:fs/promises';
import {chromium} from 'playwright';
import {scanQuestions,scanUnsupported} from '../dist/src/scanner.js';
import {fillAnswer} from '../dist/src/fill.js';
import {locateNext} from '../dist/src/interaction.js';
import {scanDeadlines} from '../dist/src/calendar.js';
import {classifyAccess} from '../dist/src/access-gates.js';
import {observeScore} from '../dist/src/observations.js';
const CHROME=process.env.AUTOTASK_CHROMIUM_EXECUTABLE_PATH;
let browser,passed=0;
const note=name=>{passed++;console.log('PASS '+name)};
try{
 browser=await chromium.launch({headless:true,...(CHROME&&existsSync(CHROME)?{executablePath:CHROME,args:['--no-sandbox']}: {})});
 const fixtures=new Map();
 fixtures.set('/form',`<!DOCTYPE html><html><body>
 <section class="question"><h2>Which day?</h2><div role="radiogroup">
 <label><input type="radio" name="d" value="mon">Monday</label>
 <label><input type="radio" name="d" value="tue">Tuesday</label></div></section>
 <section class="question"><h2>Your written response</h2><input type="text" aria-label="Text answer"></section>
 <section class="question"><h2>Pick skills</h2><label><input type="checkbox">Reading</label><label><input type="checkbox">Writing</label></section>
 <button type="button">Next</button></body></html>`);
 fixtures.set('/aria',`<html><body>
 <div class="question"><h3>Choose one</h3><div role="radiogroup">
 <div role="radio" tabindex="0" aria-label="First" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">First</div>
 <div role="radio" tabindex="0" aria-label="Second" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">Second</div></div></div></body></html>`);
 fixtures.set('/upload',`<html><body><div class="question"><h2>Upload a file</h2><input type="file" aria-label="Document upload"></div></body></html>`);
 fixtures.set('/media',`<html><body><audio controls></audio><p>Record your voice</p></body></html>`);
 fixtures.set('/course',`<html><body><div class="activity-item">Weekly quiz</div><div class="activity-dates">Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM</div></body></html>`);
 fixtures.set('/gate',`<html><body>Bạn đọc quá nhanh. Hãy xem lại tài liệu trước khi có thể bắt đầu thi. Thời gian đọc còn lại 15 phút</body></html>`);
 fixtures.set('/score',`<html><body>Your attempts <table><tr><td>Grade</td><td>9.00 out of 10.00 (90%)</td></tr></table></body></html>`);
 const page=await browser.newPage();await page.setContent(fixtures.get('/form'));
 const qs=await scanQuestions(page);
 assert(qs.some(q=>q.kind==='radio')&&qs.some(q=>q.kind==='checkbox')&&qs.some(q=>q.kind==='text'),JSON.stringify(qs));
 note('Google-style native form scan (in-memory HTML)');
 const radio=qs.find(q=>q.kind==='radio');await fillAnswer(page,radio,{id:radio.id,selected:[radio.options[0].id]});
 assert.equal(await page.locator('input[name=d]:checked').count(),1);note('Radio answer fill verified');
 const checkbox=qs.find(q=>q.kind==='checkbox');await fillAnswer(page,checkbox,{id:checkbox.id,selected:[checkbox.options[0].id]});
 assert.equal(await page.locator('input[type=checkbox]:checked').count(),1);note('Multiple-choice checkbox fill verified');
 const text=qs.find(q=>q.kind==='text');await fillAnswer(page,text,{id:text.id,text:'Reviewed response'});
 assert.equal(await page.locator('input[type=text]').inputValue(),'Reviewed response');note('Textbox fill verified');
 assert.equal(await page.getByRole('button',{name:'Next'}).count(),1);note('Next-page button identifiable');
 await page.setContent(fixtures.get('/aria'));
 const aria=await scanQuestions(page);const roleRadio=aria.find(q=>q.kind==='radio');
 assert(roleRadio&&roleRadio.options.length===2,JSON.stringify(aria));
 await fillAnswer(page,roleRadio,{id:roleRadio.id,selected:[roleRadio.options[0].id]});
 assert.equal(await page.locator('[role=radio][aria-checked=true]').count(),1);note('ARIA custom radio click and post-click verification');
 await page.setContent(fixtures.get('/media'));const unsupported=await scanUnsupported(page);
 assert(unsupported.some(x=>x.includes('Media'))&&unsupported.some(x=>x.includes('Speech')));note('Audio/speech control detected without invented completion');
 await page.setContent(fixtures.get('/upload'));
 const files=await scanQuestions(page);const upload=files.find(q=>q.kind==='file');assert(upload);
 const before=new Set(await readdir('artifacts').catch(()=>[]));
 try{await fillAnswer(page,upload,{id:upload.id,fileName:'verification.txt',fileContent:'Local file upload verification'});
   assert.equal(await page.locator('input[type=file]').evaluate(el=>el.files?.length),1);
   note('Generated local file attached to HTML upload control');
 }finally{
   for(const name of await readdir('artifacts').catch(()=>[]))if(!before.has(name)&&name.startsWith('verification-'))await unlink('artifacts/'+name);
 }
 await page.setContent(fixtures.get('/course'));const deadlines=await scanDeadlines(page);assert(deadlines.length&&deadlines[0].dueAt.startsWith('2026-11-14'));note('Moodle Closed date rather than Opened date');
 await page.setContent(fixtures.get('/gate'));const gates=classifyAccess(await page.locator('body').innerText(),'https://fami.hust.edu.vn/sohoa/phong-hoc/kiem-tra/5514');assert(gates.some(g=>g.kind==='FAMI_READING'&&g.blocked&&g.remainingSeconds===900));note('FAMI 15-minute gate respected');
 await page.setContent(fixtures.get('/score'));const score=await observeScore(page);assert(score?.text.includes('9.00'));note('Published grade observation');
 console.log(`RESULT ${passed}/${passed} browser smoke checks passed`);
}catch(e){console.error('Browser smoke FAILED:',e);process.exitCode=1;}
finally{await browser?.close();}
