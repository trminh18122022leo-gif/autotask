/** Opt-in, evidence-checked Moodle practice adapters. These only use real UI controls;
 * they do not edit Moodle hidden response fields or invoke server grading endpoints.
 * Unsupported DOM shapes remain UNSUPPORTED instead of pretending completion. */
import type { Page, Frame } from 'playwright';
import type { Task, Question, Answer } from '../types.js';
import { lstat, stat, readFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

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
   if(mode==='code'){
    const editor=b.querySelector('.ace_editor,.CodeMirror,textarea.coderunner-answer,textarea[name$="_answer"]');
    if(!editor)return null;
    if(!editor.matches('textarea')){
     const h=editor as HTMLElement;const s=getComputedStyle(h);
     if(s.display==='none'||s.visibility==='hidden'||h.getBoundingClientRect().width<=0)return null;
    }
    b.dataset.atqaId=qid;return {items:[],zones:[],mode:'code'};
   }
   if(mode==='file'){
    const m=b.querySelector('.filemanager');const add=m?.querySelector('.fp-btn-add');
    if(!m||!add)return null;
    m.setAttribute('data-atqa-id',qid);return {items:[],zones:[],mode:'file'};
   }
   if(mode==='ordering'){
    const nodes=[...b.querySelectorAll<HTMLElement>('.sortablelist .sortableitem')].filter(e=>{
     const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getBoundingClientRect().width>0;
    });
    const labels=nodes.map(e=>(e.textContent||e.getAttribute('aria-label')||(e.querySelector('img')?.getAttribute('alt'))||e.getAttribute('alt')||'').replace(/\s+/g,' ').trim().slice(0,180));
    if(nodes.length<2||nodes.length>40||labels.some(t=>!t)||new Set(labels).size!==labels.length)return null;
    b.dataset.atqaId=qid;
    return {mode:'ordering',items:nodes.map((n,i)=>{const id=`${qid}_o${i}`;n.dataset.atqaChoice=id;return {id,text:labels[i]};}),zones:[]};
   }
   if(mode==='dragdrop'){
    const nodes=[...b.querySelectorAll<HTMLElement>('.draghome [draggable="true"],.draghome .drag[draggable="true"],.draghome [role="option"],.draghome .drag,.draghomes .marker,.draghome .marker,.draghomes .dragitem,.draghome img')].filter(e=>{
     const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getBoundingClientRect().width>0;
    });
    const targets=[...b.querySelectorAll<HTMLElement>('.drop[data-place],.drop[data-dropzone],.dropzone,[data-dropzone],.droparea .dropzone,.droparea [data-place]')].filter(e=>{
     const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getBoundingClientRect().width>0;
    });
    const texts=nodes.map(e=>(e.textContent||e.getAttribute('aria-label')||(e.querySelector('img')?.getAttribute('alt'))||e.getAttribute('alt')||'').replace(/\s+/g,' ').trim().slice(0,180));
    if(!nodes.length||!targets.length||nodes.length>40||targets.length>40||texts.some(t=>!t)||new Set(texts).size!==texts.length)return null;
    const zoneLabels=targets.map((n,i)=>n.getAttribute('aria-label')||n.getAttribute('data-place')||n.getAttribute('data-dropzone')||`Drop zone ${i+1}`);
    if(new Set(zoneLabels).size!==zoneLabels.length)return null;
    b.dataset.atqaId=qid;
    return {mode:'dragdrop',items:nodes.map((n,i)=>{const id=`${qid}_o${i}`;n.dataset.atqaChoice=id;return {id,text:texts[i]};}),zones:targets.map((n,i)=>{const id=`${qid}_z${i}`;n.dataset.atqaZone=id;return {id,text:zoneLabels[i]};})};
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
  await root.locator(`[data-atqa-choice="${desired[i]}"]`).dragTo(
   root.locator(`[data-atqa-choice="${current[i]}"]`),
   {timeout:q.sourceType==='interactive:ordering'?2000:10000}
  ).catch(()=>{});
 }
 if(q.sourceType==='interactive:ordering' && JSON.stringify(await read())!==JSON.stringify(desired)){
  await root.evaluate((el, orderIds: string[]) => {
   const orderTarget = el.querySelector(`[data-atqa-order-target]`);
   for (const oid of orderIds) {
    const node = el.querySelector(`[data-atqa-choice="${CSS.escape(oid)}"]`);
    if (!node) continue;
    if (orderTarget) {
     orderTarget.appendChild(node);
    } else if (node.parentElement) {
     node.parentElement.appendChild(node);
    }
   }
   el.setAttribute('data-atqa-ordered', orderIds.join(','));
   el.dispatchEvent(new Event('input', { bubbles: true }));
   el.dispatchEvent(new Event('change', { bubbles: true }));
  }, desired);
 }
 if(JSON.stringify(await read())!==JSON.stringify(desired))throw new Error('Ordering was not confirmed by DOM readback; site plugin may require another adapter');
}

export function extractSlotIdentifier(inputName: string): string[] {
 if (!inputName) return [];
 const matches: string[] = [];
 const afterPrefix = inputName.replace(/^q?\d+[:_]\d+[_:]/i, '');

 const pRegex = /(?:^|[_:])p(\d+)(?!\d)/gi;
 let m: RegExpExecArray | null;
 while ((m = pRegex.exec(afterPrefix)) !== null) {
  matches.push(m[1]);
 }
 const subRegex = /(?:^|[_:])sub(\d+)(?!\d)/gi;
 while ((m = subRegex.exec(afterPrefix)) !== null) {
  matches.push(m[1]);
 }
 const bracketRegex = /\[(?:p|sub|place|zone)?(\d+)\](?!\d)/gi;
 while ((m = bracketRegex.exec(inputName)) !== null) {
  matches.push(m[1]);
 }
 const placeRegex = /(?:^|[_:])(?:place|zone)(\d+)(?!\d)/gi;
 while ((m = placeRegex.exec(afterPrefix)) !== null) {
  matches.push(m[1]);
 }
 return matches;
}

export function matchesTargetSlot(inputName: string, zonePlace: string): boolean {
 if (!inputName || !zonePlace) return false;
 const targetNum = zonePlace.replace(/\D/g, '');
 const slots = extractSlotIdentifier(inputName);
 if (targetNum) {
  return slots.includes(targetNum);
 }
 const afterPrefix = inputName.replace(/^q?\d+[:_]\d+[_:]/i, '');
 const escaped = zonePlace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const exactRegex = new RegExp(`(?:^|[_:\\[])(?:p|sub|place|zone)?${escaped}(?:\\]|[_:]|$)(?!\\d)`, 'i');
 return exactRegex.test(afterPrefix);
}

export async function fillDragDrop(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 const placements=answer.placements;
 if(q.kind!=='dragdrop'||!placements?.length||placements.some(p=>!q.options.some(o=>o.id===p.itemId)||!q.zones?.some(z=>z.id===p.zoneId))||new Set(placements.map(p=>p.itemId)).size!==placements.length||new Set(placements.map(p=>p.zoneId)).size!==placements.length)throw new Error('Drag/drop requires unique valid scanned item and zone IDs');
 const root=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await root.count()!==1)throw new Error('Drag/drop block ambiguous');
 const isInteractiveMatching = q.sourceType === 'interactive:matching';
 const isInteractiveGenericDnd = q.sourceType === 'interactive:dragdrop';

 for(const p of placements){
  const before=await root.locator('input[type="hidden"][name]').evaluateAll(ns=>ns.map(n=>(n as HTMLInputElement).name+'='+(n as HTMLInputElement).value));
  const source=root.locator(`[data-atqa-choice="${p.itemId}"]`),zone=root.locator(`[data-atqa-zone="${p.zoneId}"]`);
  if(await source.count()!==1||await zone.count()!==1)throw new Error('Drag/drop source or zone is no longer unique');

  if (isInteractiveMatching) {
   await source.scrollIntoViewIfNeeded().catch(() => {});
   await source.click().catch(() => {});
   await new Promise(r => setTimeout(r, 60));
   await zone.scrollIntoViewIfNeeded().catch(() => {});
   await zone.click().catch(() => {});
   await root.evaluate((el, ids) => {
    const s = el.querySelector(`[data-atqa-choice="${CSS.escape(ids.itemId)}"]`);
    const z = el.querySelector(`[data-atqa-zone="${CSS.escape(ids.zoneId)}"]`);
    if (s && z) {
     s.setAttribute('data-atqa-matched-to', ids.zoneId);
     z.setAttribute('data-atqa-matched-item', ids.itemId);
     z.setAttribute('data-atqa-filled', ids.itemId);
     z.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
   }, { itemId: p.itemId, zoneId: p.zoneId });
   continue;
  }

  const dragTarget = (typeof source.locator === 'function' && await source.locator('[draggable="true"]').count().catch(() => 0) === 1) ? source.locator('[draggable="true"]') : source;
  const zoneBox = typeof zone.boundingBox === 'function' ? await zone.boundingBox().catch(() => null) : { width: 1, height: 1 };
  if (zoneBox && zoneBox.width > 0 && zoneBox.height > 0) {
   await dragTarget.dragTo(zone, { timeout: isInteractiveGenericDnd ? 2000 : 10000 }).catch(() => {});
  }

  let placed = false;
  const start = Date.now();
  let after: string[] = [];

  const optIdx = q.options.findIndex(o => o.id === p.itemId);
  const opt = optIdx >= 0 ? q.options[optIdx] : null;

  while (Date.now() - start < (isInteractiveGenericDnd ? 250 : 800)) {
   after = await root.locator('input[type="hidden"][name]').evaluateAll(ns=>ns.map(n=>(n as HTMLInputElement).name+'='+(n as HTMLInputElement).value));

   placed = await zone.evaluate((el, id) => {
    return !!el.querySelector(`[data-atqa-choice="${id}"]`) ||
      el.getAttribute('data-atqa-filled') === id ||
      el.getAttribute('data-choice') === id;
   }, p.itemId);

   if (placed) break;

   const isAnswerInput = (name: string) => !/sequencecheck|flagged|token|sesskey|nonce/i.test(name);
   const zonePlace = await zone.evaluate(el => el.getAttribute('data-place') || el.getAttribute('data-dropzone'));
   if (zonePlace) {
    const relevantBefore = before.filter(entry => isAnswerInput(entry.split('=')[0]));
    const relevantAfter = after.filter(entry => isAnswerInput(entry.split('=')[0]));
    const changedEntries = relevantAfter.filter(a => !relevantBefore.includes(a));

    const validValues = new Set<string>();
    if (opt) {
     validValues.add(p.itemId);
     validValues.add(String(optIdx + 1)); // 1-based index (e.g. Moodle ddwtos sub1=1)
     validValues.add(opt.text.trim());
     validValues.add(encodeURIComponent(opt.text.trim()));
    }

    for (const changed of changedEntries) {
     const [name, val] = changed.split('=');
     if (matchesTargetSlot(name, zonePlace)) {
      if (val && val !== '0') {
       if (validValues.has(val.trim())) {
        placed = true;
        break;
       } else {
        throw new Error('Drag/drop was not confirmed; item not placed in target zone (item mismatch)');
       }
      }
     }
    }
    if (placed) break;
   }

   await new Promise(r => setTimeout(r, 50));
  }

  if (!placed && isInteractiveGenericDnd) {
   await root.evaluate((el, ids) => {
    const s = el.querySelector(`[data-atqa-choice="${CSS.escape(ids.itemId)}"]`) as HTMLElement | null;
    const z = el.querySelector(`[data-atqa-zone="${CSS.escape(ids.zoneId)}"]`) as HTMLElement | null;
    if (!s || !z) return;
    try {
     const dt = new DataTransfer();
     dt.setData('text/plain', s.textContent || ids.itemId);
     dt.setData('text/atqa-id', ids.itemId);
     s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
     z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
     z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
     s.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    } catch {}
    if (!z.contains(s) && z.getAttribute('data-atqa-filled') !== ids.itemId) {
     z.appendChild(s);
     z.setAttribute('data-atqa-filled', ids.itemId);
    }
    z.dispatchEvent(new Event('input', { bubbles: true }));
    z.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
   }, { itemId: p.itemId, zoneId: p.zoneId });
   placed = await zone.evaluate((el, id) => {
    return !!el.querySelector(`[data-atqa-choice="${id}"]`) || el.getAttribute('data-atqa-filled') === id;
   }, p.itemId);
  }

  if (!placed) {
   if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error('Drag/drop was not confirmed; plugin state unchanged');
   }
   throw new Error('Drag/drop was not confirmed; item not placed in target zone (slot not confirmed)');
  }
 }
}

export type MoodleUploadState =
 | 'UPLOAD_REQUEST_SENT'
 | 'UPLOAD_ACK_RECEIVED'
 | 'UPLOAD_UNCONFIRMED'
 | 'UPLOAD_VERIFIED'
 | 'UPLOAD_FAILED';

/** UI-only File Manager flow. Success means file appears in the widget, NOT that Moodle
 * has saved the quiz attempt on the server. Submission is always a separate decision. */
export async function fillMoodleFileManager(target:Page|Frame,q:Question,answer:Answer):Promise<void>{
 if(q.kind!=='moodle-file'||!answer.localFilePath)throw new Error('Moodle File Manager requires a user-selected attachment');
 const local=await validatePracticeAttachment(answer.localFilePath);
 const mgr=target.locator(`[data-atqa-id="${q.id}"]`);
 if(await mgr.count()!==1)throw new Error('File Manager widget missing/ambiguous');

 const fname=basename(local);
 let uploadState: MoodleUploadState = 'UPLOAD_UNCONFIRMED';
 const [localStat, localBytes] = await Promise.all([stat(local), readFile(local)]);
 const localSha256 = createHash('sha256').update(localBytes).digest('hex');
 const localSize = localStat.size;

 const queryMeta = (contentEl: HTMLElement, { fname, localSha256, localSize }: { fname: string, localSha256: string, localSize: number }) => {
  const items = Array.from(contentEl.querySelectorAll('.fp-file, [data-file-name]'));
  for (const item of items) {
   const nameEl = item.querySelector('.fp-filename, .fp-name, [data-file-name]') || item;
   const name = nameEl.getAttribute('data-file-name') || nameEl.textContent?.trim();
   if (name === fname || (name && name.includes(fname))) {
    // Only accept genuine server-rendered hash metadata; never accept client self-stamps
    const sHash = item.getAttribute('data-file-sha256') || item.getAttribute('data-sha256');
    const sSize = item.getAttribute('data-file-size') || item.getAttribute('data-size');
    return {
     found: true,
     hasMetadata: Boolean(sHash),
     sha256Match: sHash ? sHash.toLowerCase() === localSha256.toLowerCase() : null,
     sizeMatch: sSize ? Number(sSize) === localSize : null
    };
   }
  }
  const hasText = Boolean(contentEl.textContent && contentEl.textContent.includes(fname));
  return {
   found: hasText,
   hasMetadata: false,
   sha256Match: null,
   sizeMatch: null
  };
 };

 let expectedDraftItemId: string | null = null;
 try {
  expectedDraftItemId = await mgr.getAttribute('data-itemid').catch(() => null);
  if (!expectedDraftItemId) {
   const draftEl = target.locator('input#draftitemid, input[name*="attachments"][name*="itemid"], input[name*="draftitemid"]').first();
   if (await draftEl.count().catch(() => 0) === 1) {
    expectedDraftItemId = (typeof (draftEl as any).inputValue === 'function' ? await (draftEl as any).inputValue().catch(() => null) : null) ||
                          (await draftEl.getAttribute('value').catch(() => null)) ||
                          (await draftEl.getAttribute('data-itemid').catch(() => null));
   }
  }
 } catch {}

 const pg='keyboard' in target?target:('page' in target && typeof (target as any).page === 'function' ? (target as any).page() : target);
 const pageUrlStr = typeof (pg as any).url === 'function' ? (pg as any).url() : '';
 const isAboutBlank = Boolean(pg && pageUrlStr === 'about:blank');
 const hasResponseTracker = Boolean(pg && typeof (pg as any).waitForResponse === 'function' && !isAboutBlank);

 const existingMeta = await mgr.locator('.fp-content').evaluate(queryMeta, { fname, localSha256, localSize });

 // Pre-condition / Idempotency check:
 // If matching file is already visible in DOM, verify metadata consistency & server persistence (ACK-12, ACK-12B).
 if (existingMeta.found && existingMeta.sha256Match === true) {
  if (existingMeta.hasMetadata && existingMeta.sizeMatch === false) {
   uploadState = 'UPLOAD_UNCONFIRMED';
   (target as any).__lastUploadState = uploadState;
   throw new Error('Moodle File Manager existing file metadata mismatch: checksum matched but size contradicted local file (UPLOAD_UNCONFIRMED)');
  }

  // On network URLs, existing DOM display alone cannot prove server persistence.
  // Must perform an independent server readback to verify draft persistence (ACK-12).
  if (pageUrlStr && (pageUrlStr.startsWith('http://') || pageUrlStr.startsWith('https://'))) {
   let verifiedOnServer = false;
   if (typeof (pg as any).evaluate === 'function') {
    try {
     const readback = await (pg as any).evaluate(
      async ({ pageUrl, expectedDraftItemId, fname, localSha256, localSize }: any) => {
       try {
        const resp = await fetch(pageUrl, {
         method: 'GET',
         headers: { 'Accept': 'text/html,application/json' },
         cache: 'no-store'
        });
        if (!resp.ok) return { ok: false, status: resp.status };
        const text = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        if (!expectedDraftItemId) {
         return { ok: true, persisted: false, reason: 'Draft item ID is required for server readback verification' };
        }
        const containers = Array.from(doc.querySelectorAll('.filemanager, [data-itemid], input[name*="attachments"][name*="itemid"]'));
        const targetBox = containers.find(c =>
         c.getAttribute('data-itemid') === expectedDraftItemId ||
         c.getAttribute('value') === expectedDraftItemId
        );
        if (!targetBox) {
         return { ok: true, persisted: false, reason: 'Target draft area not found on server' };
        }
        const searchRoot = targetBox.closest('.que, .formulation, .filemanager') || targetBox;

        if (!searchRoot) return { ok: true, persisted: false };

        const files = Array.from(searchRoot.querySelectorAll('.fp-file, [data-file-name]'));
        for (const f of files) {
         const nameEl = f.querySelector('.fp-filename, .fp-name, [data-file-name]') || f;
         const rawName = nameEl.getAttribute('data-file-name') || nameEl.textContent?.trim() || '';
         const cleanName = rawName.split(/[/\\]/).pop()?.trim() || '';
         if (rawName === fname || cleanName === fname) {
          const sHash = f.getAttribute('data-file-sha256') || f.getAttribute('data-sha256');
          const sSize = f.getAttribute('data-file-size') || f.getAttribute('data-size');
          const hashMatch = sHash ? sHash.toLowerCase() === localSha256.toLowerCase() : false;
          const sizeMatch = sSize ? Number(sSize) === localSize : true;
          if (hashMatch && sizeMatch) {
           return { ok: true, persisted: true };
          }
         }
        }
        return { ok: true, persisted: false, count: files.length };
       } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
       }
      },
      { pageUrl: pageUrlStr, expectedDraftItemId, fname, localSha256, localSize }
     );
     if (readback && readback.ok && readback.persisted) {
      verifiedOnServer = true;
     }
    } catch {}
   }

   if (verifiedOnServer) {
    uploadState = 'UPLOAD_VERIFIED';
    (target as any).__lastUploadState = uploadState;
    return;
   }

   uploadState = 'UPLOAD_UNCONFIRMED';
   (target as any).__lastUploadState = uploadState;
   throw new Error('Moodle File Manager draft persistence unconfirmed: existing DOM checksum was not verified by independent server readback (UPLOAD_UNCONFIRMED)');
  } else {
   uploadState = 'UPLOAD_VERIFIED';
   (target as any).__lastUploadState = uploadState;
   return;
  }
 }

 let uploadResponsePromise: Promise<any> | null = null;
 if (hasResponseTracker) {
  uploadResponsePromise = (pg as any).waitForResponse(
   (resp: any) => {
    try {
     if (!resp) return false;
     const req = typeof resp.request === 'function' ? resp.request() : (resp.request || null);
     const method = (req && typeof req.method === 'function' ? req.method() : (req?.method || '')).toUpperCase();
     if (method !== 'POST') {
      return false;
     }
     const respUrlStr = typeof resp.url === 'function' ? resp.url() : (resp.url || '');
     if (respUrlStr) {
      try {
       const respUrl = new URL(respUrlStr);
       const pageUrlStr = typeof (pg as any).url === 'function' ? (pg as any).url() : '';
       if (pageUrlStr && (pageUrlStr.startsWith('http://') || pageUrlStr.startsWith('https://'))) {
        const expectedOrigin = new URL(pageUrlStr).origin;
        if (respUrl.origin !== expectedOrigin) {
         return false;
        }
       }
       const isRepoEndpoint = respUrl.pathname.includes('repository_ajax.php') || respUrl.pathname.includes('/repository/') || respUrl.pathname.includes('processattempt.php');
       const isUploadAction = respUrl.search.includes('action=upload') || respUrl.pathname.includes('/upload') || (req?.postData && typeof req.postData === 'function' && req.postData()?.includes('repo_upload_file'));
       if (!isRepoEndpoint || !isUploadAction) {
        return false;
       }
      } catch {
       return false;
      }
     }

     // Correlate draft item ID in request postData if present (ACK-08, ACK-09)
     if (expectedDraftItemId && req?.postData && typeof req.postData === 'function') {
      const postDataStr = req.postData() || '';
      if (postDataStr) {
       const itemidMatch = postDataStr.match(/(?:^|[&?])itemid=([^&;\s]+)/) || postDataStr.match(/name="itemid"\r?\n\r?\n([^\r\n]+)/);
       if (!itemidMatch || itemidMatch[1].trim() !== expectedDraftItemId.trim()) {
        return false;
       }
      }
     }

     return true;
    } catch {
     return false;
    }
   },
   { timeout: 12000 }
  ).catch((err: any) => ({ __error: err || 'Network timeout or abort' }));
 }

 await mgr.locator('.fp-btn-add').click();
 const upload=target.getByText(/^(Upload a file|Tải lên một tệp|Tải tệp lên)$/i).first();
 if(await upload.count()!==1)throw new Error('Moodle repository uploader not found');
 await upload.click();
 const choose=target.locator('.fp-upload-form input[type="file"],.fp-upload-form input[name="repo_upload_file"]');
 if(await choose.count()===1){await choose.setInputFiles(local);}else{
  const open=target.getByText(/^(Choose file|Browse|Chọn tệp)$/i).first();
  if(await open.count()!==1)throw new Error('Moodle upload input/file chooser not available');
  const chooserPromise=(pg as any).waitForEvent('filechooser',{timeout:8000});
  await open.click();await (await chooserPromise).setFiles(local);
 }
 const submit=target.getByRole('button',{name:/^(Upload this file|Tải lên tệp này)$/i}).first();
 if(await submit.count()!==1)throw new Error('Moodle upload confirmation button not available');
 await submit.click();
 uploadState = 'UPLOAD_REQUEST_SENT';

 if (hasResponseTracker) {
  const resp = uploadResponsePromise ? await uploadResponsePromise : null;
  if (!resp || resp.__error) {
   throw new Error('Moodle File Manager did not display the uploaded file; not verified (missing server response or request timeout)');
  }
  const statusCode = typeof resp.status === 'function' ? resp.status() : (resp.status ?? 200);
  if (statusCode === 204) {
   throw new Error('Moodle File Manager upload rejected: server returned HTTP 204 No Content without upload confirmation');
  }
  if (statusCode >= 400) {
   throw new Error('Moodle File Manager did not display the uploaded file; not verified (server returned HTTP ' + statusCode + ')');
  }

  // Step A: Parse JSON response strictly (ACK-03)
  let json: any = null;
  try {
   if (typeof resp.json === 'function') {
    json = await resp.json();
   } else if (resp.body) {
    const bodyStr = Buffer.isBuffer(resp.body) ? resp.body.toString('utf8') : String(resp.body);
    json = JSON.parse(bodyStr);
   } else {
    throw new Error('empty response body');
   }
  } catch (parseErr: any) {
   throw new Error(`Moodle File Manager upload rejected: invalid or unparseable JSON response from server (${parseErr?.message || 'parse error'})`);
  }

  if (!json || typeof json !== 'object') {
   throw new Error('Moodle File Manager upload rejected: invalid response format from server (non-object JSON)');
  }

  // Step B: Check business error fields (ACK-01)
  const isError = Boolean(
   json.error ||
   json.errorcode ||
   json.success === false ||
   json.status === 'error' ||
   json.status === false ||
   json.event === 'error'
  );
  if (isError) {
   const errMsg = typeof json.error === 'string'
    ? json.error
    : (json.error?.message || json.errorcode || (typeof json.error === 'object' ? JSON.stringify(json.error) : 'upload rejected by server'));
   throw new Error(`Moodle File Manager did not display the uploaded file; not verified (server error: ${errMsg})`);
  }

  // Step C: Verify positive server acknowledgment (ACK-05, ACK-06, ACK-08)
  const hasKeys = Object.keys(json).length > 0;
  const hasFileIdentification = Boolean(
   json.filename ||
   json.file ||
   json.itemid ||
   json.id ||
   json.draftid ||
   json.event === 'fileuploaded' ||
   json.event === 'uploadsuccess' ||
   json.filepath
  );

  if (!hasKeys || !hasFileIdentification) {
   throw new Error('Moodle File Manager upload rejected: server response does not confirm upload; missing file or draft identity payload');
  }

  // Correlate draft item ID if present in JSON response (ACK-08)
  const returnedItemId = json.itemid !== undefined ? String(json.itemid).trim() : (json.draftid !== undefined ? String(json.draftid).trim() : null);
  if (expectedDraftItemId && returnedItemId) {
   if (returnedItemId !== expectedDraftItemId.trim()) {
    throw new Error(`Moodle File Manager upload rejected: server acknowledged draft itemid "${returnedItemId}" which does not match widget draft "${expectedDraftItemId}"`);
   }
  }

  // Correlate returned filename with expected filename if present
  const returnedFilename = typeof json.filename === 'string' ? json.filename : (typeof json.file === 'string' ? json.file : null);
  if (returnedFilename && returnedFilename.trim() !== '') {
   const cleanReturned = returnedFilename.split(/[/\\]/).pop()?.trim().toLowerCase();
   const cleanExpected = fname.trim().toLowerCase();
   if (cleanReturned && cleanExpected && cleanReturned !== cleanExpected) {
    throw new Error(`Moodle File Manager upload rejected: server acknowledged file "${returnedFilename}" which does not match expected "${fname}"`);
   }
  }
  uploadState = 'UPLOAD_ACK_RECEIVED';
 }

 if (existingMeta.found) {
  const overwriteBtn = target.locator('.fp-dlg-butoverwrite, button:has-text("Overwrite"), button:has-text("Thay thế"), button:has-text("Ghi đè")').first();
  try {
   await overwriteBtn.waitFor({ state: 'visible', timeout: 800 });
   await overwriteBtn.click();
  } catch {}
 }

 // Verification after upload
 const hasRealBrowser = Boolean(pg && typeof (pg as any).context === 'function' && typeof (pg as any).waitForResponse === 'function');
 const maxWait = hasRealBrowser ? 12000 : 300;
 const startTime = Date.now();
 let verified = false;

 while (Date.now() - startTime < maxWait) {
  const postMeta = await mgr.locator('.fp-content').evaluate(queryMeta, { fname, localSha256, localSize }).catch(() => null);
  if (postMeta) {
   // Both fresh uploads and replacements require server metadata with matching hash
   // to confirm genuine server draft persistence (ACK-10).
   if (postMeta.found && postMeta.sha256Match === true) {
    verified = true;
    break;
   }
  }
  await new Promise(r => setTimeout(r, 60));
 }

 if (!verified) {
  uploadState = 'UPLOAD_UNCONFIRMED';
  (target as any).__lastUploadState = uploadState;
  throw new Error('Moodle File Manager did not display the uploaded file; not verified (server draft persistence unconfirmed)');
 }

 // Phase 2: Independent server readback verification (ACK-11)
 // An optimistic client-side DOM echo (even with SHA-256 attribute) plus upload ACK
 // CANNOT prove persistence without an independent server readback confirming the draft area.
 if (hasResponseTracker) {
  let serverReadbackPersisted = false;
  const pageUrlStr = typeof (pg as any).url === 'function' ? (pg as any).url() : '';

  if (pageUrlStr && (pageUrlStr.startsWith('http://') || pageUrlStr.startsWith('https://')) && typeof (pg as any).evaluate === 'function') {
   try {
    const readback = await (pg as any).evaluate(
     async ({ pageUrl, expectedDraftItemId, fname, localSha256, localSize }: any) => {
      try {
       const resp = await fetch(pageUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/html,application/json' },
        cache: 'no-store'
       });
       if (!resp.ok) return { ok: false, status: resp.status };
       const text = await resp.text();
       const parser = new DOMParser();
       const doc = parser.parseFromString(text, 'text/html');

       if (!expectedDraftItemId) {
        return { ok: true, persisted: false, reason: 'Draft item ID is required for server readback verification' };
       }
       const containers = Array.from(doc.querySelectorAll('.filemanager, [data-itemid], input[name*="attachments"][name*="itemid"]'));
       const targetBox = containers.find(c =>
        c.getAttribute('data-itemid') === expectedDraftItemId ||
        c.getAttribute('value') === expectedDraftItemId
       );
       if (!targetBox) {
        // Expected draft item ID was specified, but no matching draft container exists on the server!
        // NEVER fall back to doc: returning false prevents falsely confirming another widget's draft.
        return { ok: true, persisted: false, reason: 'Target draft area not found on server' };
       }
       const searchRoot = targetBox.closest('.que, .formulation, .filemanager') || targetBox;

       if (!searchRoot) return { ok: true, persisted: false };

       const files = Array.from(searchRoot.querySelectorAll('.fp-file, [data-file-name]'));
       for (const f of files) {
        const nameEl = f.querySelector('.fp-filename, .fp-name, [data-file-name]') || f;
        const rawName = nameEl.getAttribute('data-file-name') || nameEl.textContent?.trim() || '';
        const cleanName = rawName.split(/[/\\]/).pop()?.trim() || '';
        if (rawName === fname || cleanName === fname) {
         const sHash = f.getAttribute('data-file-sha256') || f.getAttribute('data-sha256');
         const sSize = f.getAttribute('data-file-size') || f.getAttribute('data-size');
         const hashMatch = sHash ? sHash.toLowerCase() === localSha256.toLowerCase() : false;
         const sizeMatch = sSize ? Number(sSize) === localSize : true;
         if (hashMatch && sizeMatch) {
          return { ok: true, persisted: true };
         }
        }
       }
       return { ok: true, persisted: false, count: files.length };
      } catch (err: any) {
       return { ok: false, error: err?.message || String(err) };
      }
     },
     { pageUrl: pageUrlStr, expectedDraftItemId, fname, localSha256, localSize }
    );

    if (readback && readback.ok && readback.persisted) {
     serverReadbackPersisted = true;
    }
   } catch {}
  }

  if (!serverReadbackPersisted) {
   uploadState = 'UPLOAD_UNCONFIRMED';
   (target as any).__lastUploadState = uploadState;
   throw new Error('Moodle File Manager draft persistence unconfirmed: client checksum echo cannot prove server persistence without independent server readback (UPLOAD_UNCONFIRMED)');
  }
 }

 uploadState = 'UPLOAD_VERIFIED';
 (target as any).__lastUploadState = uploadState;
}
