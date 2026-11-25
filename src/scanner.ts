import type {Page,Frame} from 'playwright';
import type {Question,MediaRef} from './types.js';
import {hintsForPlatform,platformForUrl} from './platforms.js';
/** DOM/accessibility-first scanner. Only reads enabled and visible fields; never makes submission decisions.
 *
 * Two extraction paths, chosen from the DOM (not from the hostname):
 *  - Moodle quiz-attempt blocks (`div.que` with `.formulation`/`.qtext`): prompt comes from `.qtext`, each block is
 *    typed from its `que <type>` class, ids derive from the Moodle slot (stable across pages/re-order), page chrome
 *    (search, nav, jump menu, flag checkbox, clear-choice radio) is never read, and unknown/drag-drop/file-manager
 *    types are returned as kind 'unsupported' instead of being downgraded to plain text.
 *  - Everything else: the generic container/ARIA scan, with navigation/search/login regions excluded.
 */
export async function scanQuestions(target:Page|Frame):Promise<Question[]> {
  const hints=hintsForPlatform(platformForUrl(target.url()));
  try { await target.evaluate('window.__name = window.__name || function(fn) { return fn; };'); } catch {}
  return target.evaluate(({containers, platform})=>{
   const CTRL='input:not([type="hidden"]),textarea,select,[role="radio"],[role="checkbox"],[role="textbox"],[role="combobox"],[role="listbox"],[contenteditable="true"]';
   const NOISE='.sr-only,.accesshide,.answernumber,script,style,noscript,.MathJax_Preview,.MathJax_Display_hidden';
   const REGION='nav,[role="navigation"],[role="search"],form[role="search"],form[action*="search" i],.search-input-form,header[role="banner"],.navbar,#mod_quiz_navblock,.qn_buttons,.jumpmenu,.urlselect,footer,[role="contentinfo"],.block-myoverview,[data-region="myoverview"],.block_timeline,[data-region="timeline"],.block_calendar_month,[data-region="calendar"],#page-my-index,.path-my';
   const SPEECH=/microphone|record your voice|ghi âm|nói vào mic|recordrtc|speak into/i;
   const txt=(el:Element|null)=>((el?.textContent||'').replace(/\s+/g,' ').trim());
   const isVisible=(el:HTMLElement)=>{
    const s=getComputedStyle(el);const rect=el.getBoundingClientRect();
    return el.getAttribute('aria-disabled')!=='true' && !el.hasAttribute('disabled') && !el.closest('[hidden],[aria-hidden="true"],template') && s.display!=='none' && s.visibility!=='hidden' && (rect.width>0||rect.height>0);
   };
   let mathUnreadable=false;
   // Recover TeX from MathJax/KaTeX annotation, then a limited MathML subset.
   // Unknown MathML remains visual-required; never invent a mathematical expression.
   const mathTex=(el:Element):string|null=>{
    const ann=el.querySelector('annotation[encoding="application/x-tex"]');if(ann)return (ann.textContent||'').trim();
    const sc=el.querySelector('script[type^="math/tex"]');if(sc)return (sc.textContent||'').trim();
    const math=el.matches('math')?el:el.querySelector('math');
    if(!math)return null;
    const render=(n:Element):string|null=>{
     const tag=n.localName?.toLowerCase();const kids=[...n.children].filter(c=>c.localName?.toLowerCase()!=='annotation');
     if(['mi','mn','mo','mtext'].includes(tag))return (n.textContent||'').trim();
     if(['math','mrow','mstyle','semantics','mtd','mtr','mtable'].includes(tag)){
      const texts=kids.map(render);return texts.some(x=>x===null)?null:texts.join('');
     }
     if(tag==='mfrac'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`\\frac{${a}}{${b}}`;}
     if(tag==='msup'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`{${a}}^{${b}}`;}
     if(tag==='msub'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`{${a}}_{${b}}`;}
     if(tag==='msubsup'&&kids.length===3){const a=render(kids[0]),b=render(kids[1]),c=render(kids[2]);return a===null||b===null||c===null?null:`{${a}}_{${b}}^{${c}}`;}
     if(tag==='mroot'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`\\sqrt[${b}]{${a}}`;}
     if(tag==='mover'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`{${a}}^{${b}}`;}
     if(tag==='munder'&&kids.length===2){const a=render(kids[0]),b=render(kids[1]);return a===null||b===null?null:`{${a}}_{${b}}`;}
     if(tag==='munderover'&&kids.length===3){const a=render(kids[0]),b=render(kids[1]),c=render(kids[2]);return a===null||b===null||c===null?null:`{${a}}_{${b}}^{${c}}`;}
     if(tag==='menclose'){const texts=kids.map(render);return texts.some(x=>x===null)?null:`{${texts.join('')}}`;}
     if(tag==='msqrt'){const a=kids.map(render);return a.some(x=>x===null)?null:`\\sqrt{${a.join('')}}`;}
     return null;
    };
    return render(math);
   };
   /** Text of a (cloned) subtree: math becomes \(tex\), screen-reader-only noise and answer numbering are dropped. */
   const cleanClone=(c:Element):string=>{
    c.querySelectorAll('mjx-container,span.MathJax,.MathJax_Display,.katex,math').forEach(m=>{
     if(!c.contains(m))return;
     const tex=mathTex(m);
     if(tex!==null)m.replaceWith(document.createTextNode(`\\(${tex}\\)`));else mathUnreadable=true;
    });
    c.querySelectorAll(NOISE).forEach(n=>n.remove());
    return txt(c).replace(/(\[\[\d+\]\])\s+([.,;:!?)])/g,'$1$2');
   };
   const cleanText=(el:Element):string=>cleanClone(el.cloneNode(true) as Element);
   const mediaOf=(root:Element,scope:'question'|'option',optionId?:string):MediaRef[]=>{
    const m:MediaRef[]=[];const add=(type:MediaRef['type'],el?:Element)=>m.push({type,src:el?.getAttribute('src')||undefined,alt:el?.getAttribute('alt')||undefined,scope,...(optionId?{optionId}:{})});
    root.querySelectorAll('img').forEach(i=>add('img',i));
    root.querySelectorAll('video').forEach(i=>add('video',i));
    root.querySelectorAll('audio').forEach(i=>add('audio',i));
    root.querySelectorAll('canvas').forEach(i=>add('canvas',i));
    root.querySelectorAll('iframe').forEach(i=>add('iframe',i));
    root.querySelectorAll('svg').forEach(i=>{const r=i.getBoundingClientRect();if(i.getAttribute('role')==='img'||r.width>=40)add('svg',i);});
    if(root.querySelector('mjx-container,.MathJax,.katex,math,.filter_mathjaxloader_equation')||/\\\(|\\\[|\$\$/.test(root.textContent||''))add('math');
    return m;
   };
   const VISUAL=new Set(['img','video','canvas','svg','iframe']);
   const kindOf=(el:HTMLElement):Question['kind']|null=>{
    const role=el.getAttribute('role');
    if(role==='radio'||role==='checkbox')return role;
    if(role==='listbox'||role==='combobox')return 'select';
    if(role==='textbox'||el.getAttribute('contenteditable')==='true')return el.getAttribute('aria-multiline')==='true'?'textarea':'text';
    if(el.tagName==='TEXTAREA')return 'textarea';if(el.tagName==='SELECT')return 'select';
    if(el.tagName==='INPUT'){
     const type=(el as HTMLInputElement).type||'text';
     if(['radio','checkbox','file'].includes(type))return type as Question['kind'];
     // 'search' is deliberately absent: a search box is site chrome, never an answer field.
     if(['email','number','url','date','tel','text'].includes(type))return 'text';
    }
    return null;
   };
   const labelFor=(el:HTMLElement)=>{
    const labelled=el.getAttribute('aria-labelledby');
    if(labelled){const text=labelled.split(/\s+/).map(id=>txt(document.getElementById(id))).filter(Boolean).join(' ');if(text)return text;}
    const linked=el.id?document.querySelector(`label[for="${CSS.escape(el.id)}"]`):null;
    return el.getAttribute('aria-label')||txt(linked)||txt(el.closest('label'))||'';
   };
   const isPlaceholder=(o:HTMLOptionElement,index:number)=>o.value===''||(index===0&&/^[\s–—-]*(choose|select|chọn)(\s+(one|an option|một|đáp án))?[\s.…–—-]*$/iu.test(txt(o)));
   const pageKey=(()=>{try{const u=new URL(location.href);if(/\/mod\/quiz\/attempt\.php$/.test(u.pathname))return `attempt=${u.searchParams.get('attempt')||''}&page=${u.searchParams.get('page')||'0'}`;return u.pathname+u.search;}catch{return '';}})();
   const selectOptions=(first:HTMLSelectElement)=>{
    const out:{id:string;text:string;value:string}[]=[];
    [...first.options].forEach((option,index)=>{if(!option.disabled&&!isPlaceholder(option,index)&&option.value!=='')out.push({id:String(index),text:cleanText(option)||option.value,value:option.value})});
    return out;
   };

   const out:Question[]=[];

   // ---------------------------------------------------------------- Moodle quiz-attempt path
   const blocks=[...document.querySelectorAll<HTMLElement>('div.que')].filter(b=>b.querySelector('.formulation,.qtext'));
   if(blocks.length){
    const SUPPORTED=new Set(['multichoice','truefalse','shortanswer','numerical','calculated','calculatedsimple','calculatedmulti','essay','match','randomsamatch','multianswer','gapselect']);
    const GENERIC_CLS=new Set(['que','deferredfeedback','immediatefeedback','interactivecountback','adaptive','adaptivenopenalty','deferredcbm','immediatecbm','notyetanswered','answersaved','correct','incorrect','partiallycorrect','complete','invalid','todo','requiresgrading','gradedright','gradedwrong','gradedpartial','manualgraded','informationitem','editable','hidden']);
    const excluded=(el:HTMLElement)=>!!el.closest('.questionflag,.comment,.history,.outcome,.specificfeedback,.qtype_multichoice_clearchoice,.filemanager,.fp-content,.fp-navbar')||/_clearchoice$|:flagged$|:sequencecheck$/.test((el as HTMLInputElement).name||'');
    blocks.forEach((block,bi)=>{
     mathUnreadable=false; // per block: one unreadable formula must not force vision on its neighbours
     const idm=/^question-(\d+)-(\d+)$/.exec(block.id);
     const slot=idm?idm[2]:String(bi+1),usage=idm?idm[1]:'0';
     const baseId=`m${slot}`,stableBase=`question-${usage}-${slot}`;
     const cls=[...block.classList];
     const type=cls.find(c=>SUPPORTED.has(c))||cls.find(c=>['ddwtos','ddmarker','ddimageortext','ordering','description'].includes(c))||cls.find(c=>!GENERIC_CLS.has(c))||'unknown';
     if(type==='description')return; // informational item, not a question
     const formulation=(block.querySelector('.formulation')||block.querySelector('.content')||block) as HTMLElement;
     const qtextEl=block.querySelector('.qtext');
     const promptPlain=(qtextEl?cleanText(qtextEl):cleanText(formulation)).slice(0,1800)||`Question ${slot}`;
     const qMedia=qtextEl?mediaOf(qtextEl,'question'):[];
     const sourceType=`moodle:${type}`;
     const base={required:false,sourceType,pageKey,media:qMedia};
     const speech=SPEECH.test(block.textContent||'')||!!block.querySelector('[class*="recordrtc" i],.mediarecorder');

     const push=(q:Omit<Question,'sourceType'|'pageKey'|'media'|'required'|'hasVisual'>&{required?:boolean;hasVisual?:boolean;media?:MediaRef[]})=>out.push({...base,hasVisual:false,...q} as Question);
     const unsupported=(id:string,stable:string,reason:string)=>push({id,stableId:stable,kind:'unsupported',prompt:promptPlain,options:[],unsupportedReason:reason});
     const guidanceFor=(qtype:string):string=>{
      if(qtype==='ddwtos'||qtype==='ddmarker'||qtype==='ddimageortext')return `Moodle drag-and-drop question ("${qtype}") is not automated safely; manually drag each item/marker into its target drop zone (or use Tab/Space keyboard placement) in the open browser tab before reviewing submission`;
      if(qtype==='ordering')return `Moodle ordering question ("ordering") relies on interactive sortable list placement; manually reorder the list items in the open browser tab before reviewing submission`;
      if(qtype==='coderunner')return `Moodle CodeRunner plugin ("coderunner") executes code against server testcases and is never downgraded to plain text; manually write, test, and verify your code in the open browser tab`;
      return `Moodle question plugin "${qtype}" is unverified/unsupported and is never downgraded to plain text; complete and verify this item manually in the open browser tab`;
     };

     if(!SUPPORTED.has(type)){unsupported(baseId,stableBase,guidanceFor(type));return;}

     const controls=[...formulation.querySelectorAll<HTMLElement>(CTRL)].filter(el=>!excluded(el)&&isVisible(el));
     const units:{nodes:HTMLElement[];kind:Question['kind']}[]=[];
     const keyed=new Map<unknown,{nodes:HTMLElement[];kind:Question['kind']}>();
     for(const c of controls){
      const k=kindOf(c);if(!k||k==='file')continue;
      let key:unknown=c;
      if(k==='radio')key=`r:${(c as HTMLInputElement).name||''}`;
      else if(k==='checkbox')key=c.closest('.answer,.subquestion,.ablock')||`c:${(c as HTMLInputElement).name}`;
      const existing=keyed.get(key);
      if(existing)existing.nodes.push(c);else{const u={nodes:[c],kind:k};keyed.set(key,u);units.push(u);}
     }
     // Moodle TinyMCE renders an accessible rich-text <iframe> while hiding its underlying <textarea>
     if(!units.some(u=>u.kind==='textarea'||u.kind==='text')){
      const tinyFrames=[...formulation.querySelectorAll<HTMLIFrameElement>('iframe[id$="_ifr"],iframe.tox-edit-area__iframe')].filter(ifr=>!excluded(ifr)&&isVisible(ifr));
      for(const ifr of tinyFrames){
       units.push({nodes:[ifr],kind:'textarea'});
      }
     }
     const hasAttachment=!!block.querySelector('.filemanager,.fp-content,.filepicker,[data-fieldtype="filemanager"]');
     if(!units.length&&!hasAttachment){unsupported(baseId,stableBase,'No accessible answer control was found in this block');return;}

     const markerMode=(type==='multianswer'||type==='gapselect')&&!!qtextEl&&units.length>0&&units.every(u=>u.nodes.every(n=>qtextEl.contains(n)));
     let promptMarked=promptPlain;
     if(markerMode&&qtextEl){
      const clone=qtextEl.cloneNode(true) as Element;
      const orig=[...qtextEl.querySelectorAll<HTMLElement>(CTRL)];const copy=[...clone.querySelectorAll<HTMLElement>(CTRL)];
      const placed=new Set<number>();
      orig.forEach((o,i)=>{
       const c=copy[i];if(!c||!clone.contains(c))return;
       const ui=units.findIndex(u=>u.nodes.includes(o));
       const w=c.closest('.subquestion,.control');const wrap=(w&&clone.contains(w))?w:c;
       if(ui<0)c.remove();
       else if(!placed.has(ui)){placed.add(ui);wrap.replaceWith(document.createTextNode(` [[${ui+1}]] `));}
       else wrap.remove();
      });
      promptMarked=cleanClone(clone).slice(0,1800);
     }

     units.forEach((unit,ui)=>{
      const sub=markerMode||units.length>1;
      const id=sub?`${baseId}_${ui+1}`:baseId;
      const stable=sub?`${stableBase}#${ui+1}`:stableBase;
      const first=unit.nodes[0];
      let prompt=promptPlain;
      if(markerMode)prompt=promptMarked;
      else if(type==='match'||type==='randomsamatch'){const row=first.closest('tr');const cell=row?.querySelector('td.text,th,td');prompt=`${promptPlain} :: ${(cell&&!cell.contains(first)?cleanText(cell):labelFor(first))||`part ${ui+1}`}`;}
      else if(units.length>1)prompt=`${promptPlain} :: ${labelFor(first)||`part ${ui+1}`}`;
      const options:Question['options']=[];
      for(const [index,node] of unit.nodes.entries()){
       node.dataset.atqaId=id;
       if(unit.kind==='radio'||unit.kind==='checkbox'){
        const optionId=`${id}_o${index}`;node.dataset.atqaChoice=optionId;
        const lbl=node.getAttribute('aria-labelledby');
        let el:Element|null=lbl?document.getElementById(lbl.split(/\s+/)[0]):null;
        if(!el&&node.id)el=block.querySelector(`label[for="${CSS.escape(node.id)}"]`);
        if(!el)el=node.closest('label')||node.parentElement;
        const text=(el?cleanText(el):'')||(node as HTMLInputElement).value||`Option ${index+1}`;
        options.push({id:optionId,text:text.slice(0,500),value:(node as HTMLInputElement).value,media:el?mediaOf(el,'option',optionId):[]});
       }
      }
      if(unit.kind==='select'){
       if(first instanceof HTMLSelectElement)for(const o of selectOptions(first))options.push(o);
       else for(const [index,option] of [...first.querySelectorAll<HTMLElement>('[role="option"]')].entries()){const oid=`${id}_o${index}`;option.dataset.atqaChoice=oid;options.push({id:oid,text:cleanText(option)||`Option ${index+1}`});}
      }
      const optVisual=options.some(o=>(o.media||[]).some(m=>VISUAL.has(m.type)));
      const hasAudioVideo=qMedia.some(m=>m.type==='audio'||m.type==='video')||options.some(o=>(o.media||[]).some(m=>m.type==='audio'||m.type==='video'));
      push({id,stableId:stable,kind:unit.kind,prompt,options,
       required:unit.nodes.some(el=>(el as HTMLInputElement).required||el.getAttribute('aria-required')==='true'),
       hasVisual:qMedia.some(m=>VISUAL.has(m.type))||optVisual||mathUnreadable,
       ...(hasAudioVideo?{humanOnly:'Question contains audio/video; the learner must listen/watch themselves'}:speech?{humanOnly:'Speech/recording required; the learner must take part'}:{})});
     });
     if(hasAttachment)unsupported(`${baseId}_att`,`${stableBase}#attachment`,'Moodle File Manager attachment requires Moodle repository File Picker AJAX draft upload; click "Add..." -> "Upload a file" in the open browser tab to attach your file manually');
    });
    return out;
   }

   // Moodle non-quiz pages (Dashboard /my/, Course outline, Site home, etc.)
   // In Moodle, quiz questions are strictly generated inside `div.que`.
   // If a page is identified as an overview/dashboard/course-outline and has no `div.que`, it has 0 questions.
   const isMoodleOverviewPage =
     document.body?.classList.contains('path-my') ||
     document.body?.classList.contains('path-course-view') ||
     !!document.querySelector('#page-my-index, #page-site-index, .block-myoverview, [data-region="myoverview"]') ||
     /\/my(?:\/|\/index\.php)?$/i.test(location.pathname);

   if (isMoodleOverviewPage && !blocks.length) {
     return [];
   }

   // ---------------------------------------------------------------- generic path
   const groupSelector=[...containers,'[role="radiogroup"]','[role="group"]','[data-item-id]','.freebirdFormviewerComponentsQuestionBaseRoot'].join(',');
   const nodes=[...document.querySelectorAll<HTMLElement>(CTRL)].filter(el=>{
    if(!isVisible(el))return false;
    if(el.closest(REGION))return false;
    if(el.getAttribute('role')==='searchbox'||(el as HTMLInputElement).type==='search')return false;
    const form=el.closest('form');if(form&&form.querySelector('input[type="password"]'))return false; // login form
    return true;
   });
   const grouped=new Map<Element,{nodes:HTMLElement[];kind:Question['kind']}>();
   for(const node of nodes){
    const k=kindOf(node);if(!k)continue;
    const group=node.closest(groupSelector)||node.closest('label')||node.parentElement||node;
    const key=(k==='radio'||k==='checkbox')?group:node;
    const item=grouped.get(key);if(item)item.nodes.push(node);else grouped.set(key,{nodes:[node],kind:k});
   }
   for(const [group,item] of grouped){
    const first=item.nodes[0],id=`q${out.length+1}`;
    const promptNode=group.querySelector('[data-automation-id="questionTitle"],.qtext,.question-title,.prompt,.freebirdFormviewerComponentsQuestionBaseTitle,[role="heading"],legend,.questiontext,[data-question-title],h2,h3');
    const prompt=(txt(promptNode)||labelFor(first)||txt(group).slice(0,900)||first.getAttribute('name')||'Question').slice(0,1800);
    const options:{id:string;text:string}[]=[];
    for(const [index,node] of item.nodes.entries()){
     node.dataset.atqaId=id;
     if(item.kind==='radio'||item.kind==='checkbox'){
      const optionId=`${id}_o${index}`;node.dataset.atqaChoice=optionId;
      const text=(labelFor(node)||txt(node.parentElement)||((node as HTMLInputElement).value||'')).slice(0,500);
      options.push({id:optionId,text:text||`Option ${index+1}`});
     }
    }
    if(item.kind==='select'){
     if(first instanceof HTMLSelectElement){
      for(const o of selectOptions(first))options.push({id:o.id,text:o.text});
     }else{
      // Custom listboxes are only actionable after options are actually rendered.
      const choices=[...first.querySelectorAll<HTMLElement>('[role="option"]')];
      for(const [index,option] of choices.entries()){
       const oid=`${id}_o${index}`;option.dataset.atqaChoice=oid;options.push({id:oid,text:labelFor(option)||txt(option)||`Option ${index+1}`});
      }
     }
    }
    // Visual/media scope = the nearest question container, not the page and not just the option label.
    const scope=group.closest(containers.join(','))||group;
    const media=mediaOf(scope,'question');
    const humanOnly=media.some(m=>m.type==='audio'||m.type==='video')?'Audio/video in this question; the learner must listen/watch themselves':SPEECH.test(scope.textContent||'')?'Speech/recording required; the learner must take part':undefined;
    out.push({id,kind:item.kind,prompt,options,pageKey,media,
     required:item.nodes.some(el=>(el as HTMLInputElement).required||el.getAttribute('aria-required')==='true'),
     hasVisual:!!scope.querySelector('img,canvas,svg,math,.katex,.MathJax,video,audio'),
     ...(humanOnly?{humanOnly}:{})});
   }
   // Explicit question blocks without standard controls (e.g. speech-only or drag-drop/slider widgets)
   const coveredScopes=new Set([...grouped.keys()].map(g=>g.closest('.exercise-question,[data-question],[data-question-id]')||g));
   for(const block of document.querySelectorAll<HTMLElement>('.exercise-question,[data-question],[data-question-id]')){
    if(!isVisible(block)||block.closest(REGION)||coveredScopes.has(block))continue;
    if(block.querySelector(CTRL)&&[...block.querySelectorAll<HTMLElement>(CTRL)].some(c=>isVisible(c)&&kindOf(c)!==null))continue;
    const hasSpeech=SPEECH.test(block.textContent||'')||!!block.querySelector('[class*="recordrtc" i],[aria-label*="record" i]');
    const hasInteractive=!!block.querySelector('[draggable="true"],.draghome,.sortableitem,[class*="drag-item" i],[role="slider"],input[type="range"],canvas,object,embed');
    const media=mediaOf(block,'question');
    const hasAV=media.some(m=>m.type==='audio'||m.type==='video');
    if(!hasSpeech&&!hasInteractive&&!hasAV)continue;
    const id=`q${out.length+1}`;
    const promptNode=block.querySelector('[data-automation-id="questionTitle"],.qtext,.question-title,.prompt,[role="heading"],legend,.questiontext,[data-question-title],h2,h3,p');
    const prompt=(txt(promptNode)||txt(block).slice(0,900)||'Interactive activity').slice(0,1800);
    out.push({id,kind:'unsupported',prompt,options:[],required:false,
     hasVisual:!!block.querySelector('img,canvas,svg,math,.katex,.MathJax,video,audio'),
     pageKey,media,
     unsupportedReason:hasSpeech?'Speech/recording activity requires direct learner participation':hasInteractive?'Interactive drag-and-drop/slider/canvas control is not supported; complete manually':'Media activity has no supported answer field; review manually',
     ...(hasSpeech?{humanOnly:'Speech/recording required; the learner must take part'}:hasAV?{humanOnly:'Audio/video in this question; the learner must listen/watch themselves'}:{})});
   }
   return out;
  },{containers:hints.questionContainers,platform:hints.platform});
 }
/** Detect interactive elements not yet supported by the scanner. */
export async function scanUnsupported(target:Page|Frame):Promise<string[]>{
  return target.evaluate(()=>{
   const text=(document.body?.innerText||'').slice(0,20000);const notes:string[]=[];
   if(document.querySelector('audio,video,[role="slider"],input[type="range"]'))notes.push('Media/slider detected: verify using site adapter; no automatic audio or slider response');
   if(/microphone|record your voice|ghi âm|nói vào mic/i.test(text)||document.querySelector('[class*="recordrtc" i],[aria-label*="record" i]'))notes.push('Speech recording detected; requires separate speech workflow');
   if(document.querySelector('[draggable="true"],.draghome,.sortableitem,[class*="drag-item" i]'))notes.push('Drag-and-drop interaction detected: not supported, complete manually');
   if(document.querySelector('object,embed,canvas'))notes.push('Embedded plugin/canvas content detected: not readable by the scanner');
   if(document.querySelector('[aria-label*="CAPTCHA" i],iframe[src*="recaptcha" i]'))notes.push('CAPTCHA detected: human action required');
   return notes;
  });
 }
