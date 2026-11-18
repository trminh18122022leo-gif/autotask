/** Opt-in, evidence-checked Moodle practice adapters. These only use real UI controls;
 * they do not edit Moodle hidden response fields or invoke server grading endpoints.
 * Unsupported DOM shapes remain UNSUPPORTED instead of pretending completion. */
import type { Page, Frame } from 'playwright';
import type { Task, Question, Answer } from '../types.js';
import { lstat } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';

const EXTENSIONS = new Set(['.txt','.md','.csv','.pdf','.docx','.xlsx','.png','.jpg','.jpeg','.pptx','.py','.java','.c','.cpp','.js','.ts']);
export async function validatePracticeAttachment(file: string): Promise<string> {
 if(typeof file!=='string'||!file.trim()||/^[a-z]+:\/\//i.test(file)) throw new Error('A local user-selected file is required');
 const p=resolve(file), stat=await lstat(p);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>30*1024*1024||stat.size===0) throw new Error('Attachment is not a nonempty regular file <= 30MB');
 if(!EXTENSIONS.has(extname(p).toLowerCase())||p.split(/[\\/]/).some(s=>['.private','.ssh','.git'].includes(s.toLowerCase()))) throw new Error('Attachment path/type is not permitted');
 return p;
}

/** Promote only structurally verifiable blocks and only for explicitly enabled self-practice.
 * File attachments are accepted ONLY from explicit task.attachmentFiles mapping. */
export async function prepareAdvancedPracticeQuestions(target: Page|Frame, questions: Question[], task: Task): Promise<Question[]> {
 const opts=task.advancedLmsAdapters;
 if(!opts || task.mode!=='PRACTICE_ASSISTED' || task.scopeAttestation!=='PERMITTED_SELF_PRACTICE') return questions;
 const results: Question[]=[];
 for(const q of questions){
  if(q.kind!=='unsupported'||!q.sourceType?.startsWith('moodle:')||!q.stableId){results.push(q);continue;}
  const code=q.sourceType==='moodle:coderunner'&&opts.codeDraft;
  const order=q.sourceType==='moodle:ordering'&&opts.ordering;
  const dnd=/^moodle:ddwtos$|^moodle:ddmarker$|^moodle:ddimageortext$/.test(q.sourceType)&&opts.dragdrop;
  const file=q.id.endsWith('_att')&&opts.fileManager&&typeof (task.attachmentFiles?.[q.stableId]||task.attachmentFiles?.[q.id])==='string';
  if(!code&&!order&&!dnd&&!file){results.push(q);continue;}
  const blockId=q.stableId.split('#')[0];
  const scan=await target.evaluate(({blockId,qid,mode})=>{
   const b=document.getElementById(blockId);
   if(!b||!b.matches('div.que'))return null;
   const visible=(e:Element)=>{const h=e as HTMLElement;const s=getComputedStyle(h);return s.display!=='none'&&s.visibility!=='hidden'&&h.getBoundingClientRect().width>0;};
   const label=(e:Element)=>(e.textContent||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,180);
   if(mode==='code'){
    const editor=b.querySelector('.ace_editor,.CodeMirror,textarea.coderunner-answer,textarea[name$="_answer"]');
    if(!editor||(!editor.matches('textarea')&&!visible(editor)))return null;
    b.dataset.atqaId=qid;return {items:[],zones:[],mode:'code'};
   }
   if(mode==='file'){
    const m=b.querySelector('.filemanager');const add=m?.querySelector('.fp-btn-add');
    if(!m||!add)return null;
    m.setAttribute('data-atqa-id',qid);return {items:[],zones:[],mode:'file'};
   }
   if(mode==='ordering'){
    const nodes=[...b.querySelectorAll<HTMLElement>('.sortablelist .sortableitem')].filter(visible);
    if(nodes.length<2||nodes.length>40||nodes.some(n=>!label(n)))return null;
    const labels=nodes.map(label);if(new Set(labels).size!==labels.length)return null;
    b.dataset.atqaId=qid;
    return {mode:'ordering',items:nodes.map((n,i)=>{const id=`${qid}_o${i}`;n.dataset.atqaChoice=id;return {id,text:label(n)};}),zones:[]};
   }
   if(mode==='dragdrop'){
    const nodes=[...b.querySelectorAll<HTMLElement>('.draghome [draggable="true"],.draghome .drag[draggable="true"],.draghome [role="option"],.draghome .drag')].filter(visible);
    const targets=[...b.querySelectorAll<HTMLElement>('.drop[data-place],.drop[data-dropzone],.dropzone,[data-dropzone]')].filter(visible);
    if(!nodes.length||!targets.length||nodes.length>40||targets.length>40||nodes.some(n=>!label(n)))return null;
    const texts=nodes.map(label);if(new Set(texts).size!==texts.length)return null;
    const zoneLabels=targets.map((n,i)=>n.getAttribute('aria-label')||n.getAttribute('data-place')||n.getAttribute('data-dropzone')||`Drop zone ${i+1}`);
    if(new Set(zoneLabels).size!==zoneLabels.length)return null;
    b.dataset.atqaId=qid;
    return {mode:'dragdrop',items:nodes.map((n,i)=>{const id=`${qid}_o${i}`;n.dataset.atqaChoice=id;return {id,text:label(n)};}),zones:targets.map((n,i)=>{const id=`${qid}_z${i}`;n.dataset.atqaZone=id;return {id,text:zoneLabels[i]};})};
   }
   return null;
  },{blockId,qid:q.id,mode:code?'code':order?'ordering':dnd?'dragdrop':'file'}).catch(()=>null);
  if(!scan){results.push(q);continue;}
  const next:Question={...q,kind:scan.mode==='file'?'moodle-file':scan.mode==='code'?'code':scan.mode==='ordering'?'ordering':'dragdrop',options:scan.items, ...(scan.zones.length?{zones:scan.zones}:{}),unsupportedReason:undefined,hasVisual:q.hasVisual || (scan.mode==='dragdrop'&&Boolean(q.media?.some(m=>['img','canvas','svg'].includes(m.type))))};
  results.push(next);
 }
 return results;
}

export function practiceAttachmentAnswer(question: Question, task: Task): Answer|undefined {
 if(question.kind!=='moodle-file')return;
 const p=task.attachmentFiles?.[question.stableId||'']||task.attachmentFiles?.[question.id];
 return p?{id:question.id,localFilePath:p}:undefined;
}

/** CodeRunner: writes a DRAFT only, never clicks Check, Try again, or Submit. */
export async function fillCodeDraft(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 if(q.kind!=='code'||typeof answer.text!=='string'||!answer.text.trim())throw new Error('A nonempty code draft is required');
 const root=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await root.count()!==1)throw new Error('CodeRunner question identity is ambiguous');
 const native=root.locator('textarea.coderunner-answer:visible,textarea[name$="_answer"]:visible');
 if(await native.count()===1){await native.fill(answer.text);if(await native.inputValue()!==answer.text)throw new Error('CodeRunner textarea readback mismatch');return;}
 const ace=root.locator('.ace_editor:visible'), cm=root.locator('.CodeMirror:visible');
 const editor=await ace.count()===1?ace:await cm.count()===1?cm:null;
 if(!editor)throw new Error('Unknown CodeRunner editor: no safe draft adapter');
 await editor.click();const pg='keyboard' in target?target:target.page();
 await pg.keyboard.press('ControlOrMeta+A');await pg.keyboard.insertText(answer.text);
 const saved=await root.locator('textarea.coderunner-answer,textarea[name$="_answer"]').first().inputValue().catch(()=>null);
 if(saved!==answer.text)throw new Error('Editor did not sync code to the underlying form field; draft unverified');
}

export async function fillOrdering(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 const desired=answer.selected||[];
 if(q.kind!=='ordering'||desired.length!==q.options.length||new Set(desired).size!==desired.length||desired.some(x=>!q.options.some(o=>o.id===x))) throw new Error('Ordering requires an exact permutation of the scanned item IDs');
 const root=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await root.count()!==1)throw new Error('Ordering block ambiguous');
 const read=async()=>root.locator('[data-atqa-choice]').evaluateAll(ns=>ns.map(n=>n.getAttribute('data-atqa-choice')||''));
 for(let i=0;i<desired.length;i++){
  const current=await read();if(current[i]===desired[i])continue;
  await root.locator(`[data-atqa-choice="${desired[i]}"]`).dragTo(root.locator(`[data-atqa-choice="${current[i]}"]`));
 }
 if(JSON.stringify(await read())!==JSON.stringify(desired))throw new Error('Ordering was not confirmed by DOM readback; site plugin may require another adapter');
}

export async function fillDragDrop(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 const placements=answer.placements;
 if(q.kind!=='dragdrop'||!placements?.length||placements.some(p=>!q.options.some(o=>o.id===p.itemId)||!q.zones?.some(z=>z.id===p.zoneId))||new Set(placements.map(p=>p.itemId)).size!==placements.length||new Set(placements.map(p=>p.zoneId)).size!==placements.length)throw new Error('Drag/drop requires unique valid scanned item and zone IDs');
 const root=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await root.count()!==1)throw new Error('Drag/drop block ambiguous');
 for(const p of placements){
  const before=await root.locator('input[type="hidden"][name]').evaluateAll(ns=>ns.map(n=>(n as HTMLInputElement).name+'='+(n as HTMLInputElement).value));
  const source=root.locator(`[data-atqa-choice="${p.itemId}"]`),zone=root.locator(`[data-atqa-zone="${p.zoneId}"]`);
  if(await source.count()!==1||await zone.count()!==1)throw new Error('Drag/drop source or zone is no longer unique');
  await source.dragTo(zone);
  const after=await root.locator('input[type="hidden"][name]').evaluateAll(ns=>ns.map(n=>(n as HTMLInputElement).name+'='+(n as HTMLInputElement).value));
  const placed=await zone.evaluate((el,id)=>!!el.querySelector(`[data-atqa-choice="${id}"]`)||el.getAttribute('data-atqa-filled')===id,p.itemId);
  if(!placed&&JSON.stringify(before)===JSON.stringify(after))throw new Error('Drag/drop was not confirmed; plugin state unchanged');
 }
}

/** UI-only File Manager flow. Success means file appears in the widget, NOT that Moodle
 * has saved the quiz attempt on the server. Submission is always a separate decision. */
export async function fillMoodleFileManager(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 if(q.kind!=='moodle-file'||!answer.localFilePath)throw new Error('Moodle File Manager requires a user-selected attachment');
 const local=await validatePracticeAttachment(answer.localFilePath);
 const mgr=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await mgr.count()!==1)throw new Error('File Manager widget missing/ambiguous');
 const pg='keyboard' in target?target:target.page();
 await mgr.locator('.fp-btn-add').click();
 const upload=target.getByText(/^(Upload a file|Tải lên một tệp|Tải tệp lên)$/i).first();
 if(await upload.count()!==1)throw new Error('Moodle repository uploader not found');
 await upload.click();
 const chooserPromise=pg.waitForEvent('filechooser',{timeout:8000});
 const choose=target.locator('.fp-upload-form input[type="file"],.fp-upload-form input[name="repo_upload_file"]');
 if(await choose.count()===1){await choose.setInputFiles(local);}else{
  const open=target.getByText(/^(Choose file|Browse|Chọn tệp)$/i).first();
  if(await open.count()!==1)throw new Error('Moodle upload input/file chooser not available');
  const chooserPromise=pg.waitForEvent('filechooser',{timeout:8000});
  await open.click();await (await chooserPromise).setFiles(local);
 }
 const submit=target.getByRole('button',{name:/^(Upload this file|Tải lên tệp này)$/i}).first();
 if(await submit.count()!==1)throw new Error('Moodle upload confirmation button not available');
 await submit.click();
 const fname=basename(local);
 await mgr.locator('.fp-content').getByText(fname,{exact:true}).first().waitFor({timeout:12000}).catch(()=>{throw new Error('Moodle File Manager did not display the uploaded file; not verified')});
}
