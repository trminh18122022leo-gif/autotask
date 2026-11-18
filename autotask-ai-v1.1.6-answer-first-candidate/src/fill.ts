import type { Page, Frame } from 'playwright';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import {createDocument,safeFormat} from './documents.js';
import { resolve, basename, extname } from 'node:path';
import type { Question, Answer } from './types.js';

const artifactDir=resolve('artifacts');
async function outputFile(answer: Answer): Promise<string> {
 const kind=safeFormat(answer.fileName);
 const result=await createDocument({title:answer.fileName||'Generated document',content:answer.fileContent||'',format:kind,baseName:basename(answer.fileName||'document')});
 return result.path;
}
export async function fillAnswer(page: Page|Frame, question: Question, answer: Answer): Promise<void> {
  if (question.kind==='unsupported') throw new Error(`UNSUPPORTED: ${question.unsupportedReason||'question type'} - needs manual review`);
  if (question.humanOnly) throw new Error(`HUMAN_ONLY: ${question.humanOnly}`);
 const rawControl=page.locator(`[data-atqa-id="${question.id}"]`);
 if (!await rawControl.count()) throw new Error(`Không tìm thấy ${question.id}, trang có thể đã thay đổi`);
 const isInput = await rawControl.first().evaluate(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.hasAttribute('contenteditable') || el.getAttribute('role') === 'textbox').catch(() => false);
 const control = isInput ? rawControl : (await rawControl.locator('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]').count() > 0 ? rawControl.locator('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]') : rawControl);
 if (question.kind==='radio' || question.kind==='checkbox') {
  for (const optionId of answer.selected||[]) {
   const target=page.locator(`[data-atqa-choice="${optionId}"]`);
   if(await target.count()!==1) throw new Error(`Lựa chọn ${optionId} không duy nhất`);
   const native=await target.evaluate(el=>el instanceof HTMLInputElement);
   if(native){await target.check();if(!(await target.isChecked()))throw new Error(`Not checked: ${optionId}`);}
   else{if(await target.getAttribute('aria-checked')!=='true')await target.click();if(await target.getAttribute('aria-checked')!=='true')throw new Error(`Custom role option did not register: ${optionId}`);}
  }
  if(question.kind==='checkbox') for (const opt of question.options) {
    if(!(answer.selected||[]).includes(opt.id)) {
     const t=page.locator(`[data-atqa-choice="${opt.id}"]`);
     if(await t.count()===1){
      const native=await t.evaluate(el=>el instanceof HTMLInputElement);
      if(native){if(await t.isChecked())await t.uncheck();}
      else if(await t.getAttribute('aria-checked')==='true')await t.click();
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
  await target.fill(textValue);
  await target.blur().catch(() => {});
  const actual = await target.evaluate((el, txtVal) => {
   if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
   }
   // Moodle Atto / rich contenteditable editors store form submission payload in a paired hidden <textarea>
   if (el.getAttribute('contenteditable') === 'true') {
    const wrap = el.closest('.editor_atto_wrap, .answer');
    const pairedId = el.id && el.id.endsWith('editable') ? el.id.slice(0, -8) : '';
    const hiddenTa = (pairedId ? document.getElementById(pairedId) : null) || wrap?.querySelector('textarea');
    if (hiddenTa instanceof HTMLTextAreaElement && !hiddenTa.value.trim() && txtVal.trim()) {
     hiddenTa.value = txtVal;
     hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
     hiddenTa.dispatchEvent(new Event('change', { bubbles: true }));
    }
   }
   return el.textContent;
  }, textValue);
  if (actual !== textValue) throw new Error('Filled value verification mismatch');
 }
}
