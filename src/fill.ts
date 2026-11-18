import type { Page, Frame, Locator } from 'playwright';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import {createDocument,safeFormat} from './documents.js';
import { resolve, basename, extname } from 'node:path';
import type { Question, Answer } from './types.js';
import {fillCodeDraft,fillOrdering,fillDragDrop,fillMoodleFileManager} from './lms/advanced-adapters.js';
import {performSpeechRecordingFill} from './agent/multimedia-interactive.js';

const artifactDir=resolve('artifacts');
async function outputFile(answer: Answer): Promise<string> {
 const kind=safeFormat(answer.fileName);
 const result=await createDocument({title:answer.fileName||'Generated document',content:answer.fileContent||'',format:kind,baseName:basename(answer.fileName||'document')});
 return result.path;
}

/**
 * Checks or unchecks a native `<input type="radio"|"checkbox">` reliably even under
 * sticky Moodle headers/drawers or custom label overlays without waiting 30s on hit-tests.
 */
async function setNativeInputChecked(page: Page|Frame, target: Locator, shouldCheck: boolean, optionId: string): Promise<void> {
 const current = await target.isChecked().catch(() => false);
 if (current === shouldCheck) return;

 const isOccluded = await target.evaluate(el => {
  if ((el as HTMLInputElement).disabled) throw new Error('Input control is disabled');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || hit === el || el.contains(hit)) return false;
  const lbl = el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  return !(lbl && (hit === lbl || lbl.contains(hit)));
 });

 if (!isOccluded) {
  try {
   if (shouldCheck) await target.check({ timeout: 2500 });
   else await target.uncheck({ timeout: 2500 });
  } catch {}
  if ((await target.isChecked().catch(() => false)) === shouldCheck) return;

  // Fallback 1: click associated <label> (often receives pointer events on Boost/custom CSS themes)
  const inputId = await target.getAttribute('id').catch(() => null);
  const linkedLabel = inputId
   ? page.locator(`label[for="${inputId.replace(/"/g, '\\"')}"]`).first()
   : target.locator('xpath=ancestor::label[1]').first();
  if ((await linkedLabel.count().catch(() => 0)) === 1) {
   await linkedLabel.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
   await linkedLabel.click({ timeout: 2000 }).catch(() => {});
   if ((await target.isChecked().catch(() => false)) === shouldCheck) return;
  }
 }

 // Fallback 2: forced Playwright check/uncheck (bypasses sticky overlay pointer interception)
 try {
  if (shouldCheck) await target.check({ force: true, timeout: 3000 });
  else await target.uncheck({ force: true, timeout: 3000 });
 } catch {}
 if ((await target.isChecked().catch(() => false)) === shouldCheck) return;

 // Fallback 3: safe DOM state update with native input/change events (never touches disabled fields)
 await target.evaluate((el, checkedVal) => {
  const inp = el as HTMLInputElement;
  if (inp.disabled) throw new Error('Input control is disabled');
  inp.checked = checkedVal;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
 }, shouldCheck);

 if ((await target.isChecked().catch(() => false)) !== shouldCheck) {
  throw new Error(`Not ${shouldCheck ? 'checked' : 'unchecked'}: ${optionId}`);
 }
}
export async function fillAnswer(page: Page|Frame, question: Question, answer: Answer): Promise<void> {
  if (question.kind==='unsupported') throw new Error(`UNSUPPORTED: ${question.unsupportedReason||'question type'} - needs manual review`);
  if (question.humanOnly) throw new Error(`HUMAN_ONLY: ${question.humanOnly}`);
  if(question.kind==='ordering')return fillOrdering(page,question,answer);
  if(question.kind==='dragdrop')return fillDragDrop(page,question,answer);
  if(question.kind==='code')return fillCodeDraft(page,question,answer);
  if(question.kind==='moodle-file')return fillMoodleFileManager(page,question,answer);
  if(question.sourceType==='interactive:speech')return performSpeechRecordingFill(page,question,answer);
 const rawControl=page.locator(`[data-atqa-id="${question.id}"]`);
 if (!await rawControl.count()) throw new Error(`Không tìm thấy ${question.id}, trang có thể đã thay đổi`);
 const isInput = await rawControl.first().evaluate(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.hasAttribute('contenteditable') || el.getAttribute('role') === 'textbox').catch(() => false);
 const control = isInput ? rawControl : (await rawControl.locator('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]').count() > 0 ? rawControl.locator('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]') : rawControl);
 const firstInputType = await control.first().evaluate(el => el instanceof HTMLInputElement ? el.type.toLowerCase() : '').catch(() => '');
 if (question.sourceType === 'interactive:slider' || firstInputType === 'range') {
  const numMatch = String(answer.text ?? '').match(/-?\d+(?:\.\d+)?/);
  const valStr = numMatch ? numMatch[0] : String(answer.text ?? '').trim();
  if (!valStr) throw new Error('Slider value is empty');
  const actual = await control.first().evaluate((el, v) => {
   const inp = el as HTMLInputElement;
   inp.value = v;
   inp.dispatchEvent(new Event('input', { bubbles: true }));
   inp.dispatchEvent(new Event('change', { bubbles: true }));
   return inp.value;
  }, valStr);
  if (actual !== valStr) throw new Error(`Slider readback mismatch: expected ${valStr}, got ${actual}`);
  return;
 }
 if (question.kind==='radio' || question.kind==='checkbox') {
  for (const optionId of answer.selected||[]) {
   const target=page.locator(`[data-atqa-choice="${optionId}"]`);
   if(await target.count()!==1) throw new Error(`Lựa chọn ${optionId} không duy nhất`);
   const native=await target.evaluate(el=>el instanceof HTMLInputElement);
   if(native){await setNativeInputChecked(page,target,true,optionId);}
   else{
    if(await target.getAttribute('aria-checked')!=='true'){
     await target.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'})).catch(()=>{});
     await target.click({timeout:3500}).catch(async()=>{await target.click({force:true,timeout:2500});});
    }
    if(await target.getAttribute('aria-checked')!=='true')throw new Error(`Custom role option did not register: ${optionId}`);
   }
  }
  if(question.kind==='checkbox') for (const opt of question.options) {
    if(!(answer.selected||[]).includes(opt.id)) {
     const t=page.locator(`[data-atqa-choice="${opt.id}"]`);
     if(await t.count()===1){
      const native=await t.evaluate(el=>el instanceof HTMLInputElement);
      if(native){await setNativeInputChecked(page,t,false,opt.id);}
      else if(await t.getAttribute('aria-checked')==='true'){
       await t.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'})).catch(()=>{});
       await t.click({timeout:3500}).catch(async()=>{await t.click({force:true,timeout:2500});});
      }
     }
    }
  }
 } else if(question.kind==='select') {
  const t=control.first();
  if(await t.evaluate(el=>el.tagName)==='SELECT'){
   const index=Number(answer.selected?.[0]);
   if(!Number.isInteger(index)||index<0)throw new Error('Invalid native select option');
   await t.selectOption({index});
   const selected=await t.evaluate(el=>(el as HTMLSelectElement).selectedIndex);
   if(selected!==index)throw new Error('Không xác minh được select');
  }else{
   const option=question.options.find(o=>o.id===answer.selected?.[0]);
   if(!option)throw new Error('Custom listbox choice not scanned; rescan with expanded options');
   await t.click();
   const control=page.locator(`[data-atqa-choice="${option.id}"]`);
   const byRole=page.getByRole('option',{name:option.text,exact:true});
   const selected=await control.count()===1?control:byRole;
   if(await selected.count()!==1)throw new Error('Custom listbox option ambiguous');
   await selected.click();
   const finalValue=await t.getAttribute('aria-valuetext')||await t.getAttribute('aria-label')||await t.innerText().catch(()=> '');
   if(!(await selected.getAttribute('aria-selected')==='true') && !finalValue.includes(option.text))
     throw new Error('Không xác minh được combobox sau khi chọn');
  }
 } else if(question.kind==='file') {
  let p:string;
  if (answer.localFilePath) {
   p=resolve(answer.localFilePath);
   const st=await lstat(p);
   if (!st.isFile() || st.isSymbolicLink() || st.size>30*1024*1024) throw new Error('Local upload file is invalid, a symlink, or larger than 30 MB');
   if (!new Set(['.txt','.md','.csv','.pdf','.docx','.xlsx','.png','.jpg','.jpeg','.pptx']).has(extname(p).toLowerCase())) throw new Error('Local upload extension not allowed');
   if (p.split(/[\\/]/).some(part=>part==='.private'||part==='.ssh')) throw new Error('Sensitive private file cannot be uploaded automatically');
  } else p=await outputFile(answer);
  await control.first().setInputFiles(p);
  const count=await control.first().evaluate((el:Element)=>(el as HTMLInputElement).files?.length||0);
  if(count!==1) throw new Error('File chưa xuất hiện trong trường upload');
 } else {
  const target = control.first();
  const textValue = answer.text || '';
  const tagName = await target.evaluate(el => el.tagName).catch(() => 'INPUT');

  if (tagName === 'IFRAME') {
   const iframeId = await target.getAttribute('id').catch(() => null);
   const handle = await target.elementHandle();
   const cFrame = await handle?.contentFrame().catch(() => null);
   if (cFrame) {
    const body = cFrame.locator('body#tinymce, body[contenteditable="true"], body').first();
    await body.click().catch(() => {});
    await body.fill(textValue).catch(async () => {
     await body.evaluate((b, val) => { b.textContent = val; }, textValue);
    });
    await body.evaluate(b => {
     b.dispatchEvent(new Event('input', { bubbles: true }));
     b.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
   }
   // Sync paired hidden <textarea> if Moodle TinyMCE wraps one
   await target.evaluate((el, { txtVal, ifrId }) => {
    const pairedId = ifrId && ifrId.endsWith('_ifr') ? ifrId.slice(0, -4) : '';
    const wrap = el.closest('.tox-tinymce, .editor_tinymce, .answer, .feditor, [data-fieldtype="editor"]');
    const hiddenTa = (pairedId ? document.getElementById(pairedId) : null) || wrap?.querySelector('textarea');
    if (hiddenTa instanceof HTMLTextAreaElement) {
     hiddenTa.value = txtVal;
     hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
     hiddenTa.dispatchEvent(new Event('change', { bubbles: true }));
    }
    try { (window as any).tinyMCE?.triggerSave?.(); } catch {}
   }, { txtVal: textValue, ifrId: iframeId });

   const readNorm = cFrame
    ? (await cFrame.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    : '';
   if (readNorm !== textValue.replace(/\s+/g, ' ').trim()) {
    throw new Error('Filled value verification mismatch');
   }
  } else {
   await target.fill(textValue);
   await target.blur().catch(() => {});
   const { actual, isRich } = await target.evaluate((el, txtVal) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
     el.dispatchEvent(new Event('change', { bubbles: true }));
     return { actual: el.value, isRich: false };
    }
    // Moodle Atto / rich contenteditable editors store form submission payload in a paired hidden <textarea>
    const isRichEditor = el.getAttribute('contenteditable') === 'true';
    if (isRichEditor) {
     const wrap = el.closest('.editor_atto_wrap, .answer, .feditor');
     const pairedId = el.id && el.id.endsWith('editable') ? el.id.slice(0, -8) : '';
     const hiddenTa = (pairedId ? document.getElementById(pairedId) : null) || wrap?.querySelector('textarea');
     if (hiddenTa instanceof HTMLTextAreaElement) {
      hiddenTa.value = txtVal;
      hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
      hiddenTa.dispatchEvent(new Event('change', { bubbles: true }));
     }
    }
    return { actual: el.textContent || '', isRich: isRichEditor };
   }, textValue);
   const matched = isRich
    ? actual.replace(/\s+/g, ' ').trim() === textValue.replace(/\s+/g, ' ').trim()
    : actual === textValue;
   if (!matched) throw new Error('Filled value verification mismatch');
  }
 }
}
