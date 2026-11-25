/** Observational utilities for existing Moodle results and FAMI topics.
 * Only reports values already visible to the signed-in user.
 */
import type {Page} from 'playwright';
export interface ScoreObservation {text:string;source:string}
export interface ParsedScoreMatch {text:string;score:number;max:number}
export interface FamiTopic {topic:string;course?:string;readingMinutes?:number;examMinutes?:number;questionCount?:number;maximumScore?:string;actionLabel?:string}
export function findAllScores(text:string):ParsedScoreMatch[]{
 const normalized=text.replace(/\s+/g,' ');
 // Strip Moodle metadata headers like "Grade to pass: 5.00 out of 10.00" or "Maximum grade"
 const scrubbed=normalized.replace(/(?:grade\s*to\s*pass|passing\s*grade|maximum\s*grade|điểm\s*(?:để\s*)?đạt|điểm\s*tối\s*đa)\s*[:=/]?\s*\d+(?:[.,]\d+)?(?:\s*(?:out of|\/|trên)\s*\d+(?:[.,]\d+)?)?(?:\s*\(\d+(?:[.,]\d+)?%\))?/giu,' ');
 const out:ParsedScoreMatch[]=[];
 // Moodle & FAMI: "Grade 9.00 out of 10.00 (90%)", "Điểm 8,00/10", "Điểm đạt: 9,00/10", "Điểm số: 8.5 trên 10"
 // Unicode-aware boundary avoids JS ASCII-only \b failing on Vietnamese 'Đ' / 'ố'.
 const re=/(?:^|[^\p{L}\p{N}_])((?:Grade|Điểm(?:\s+(?:thi|số|đạt))?)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(?:out of|\/|trên)\s*(\d+(?:[.,]\d+)?)(?:\s*\((\d+(?:[.,]\d+)?%)\))?)/giu;
 for(const m of scrubbed.matchAll(re)){
  const score=Number(m[2].replace(',','.')),max=Number(m[3].replace(',','.'));
  if(!Number.isFinite(score)||!Number.isFinite(max)||max<=0||score<0||score>max)continue;
  out.push({text:m[1].slice(0,120),score,max});
 }
 return out;
}
export function findScore(text:string):string|null{
 const all=findAllScores(text);
 return all.length>0?all[all.length-1].text:null;
}
export async function observeScore(page:Page):Promise<ScoreObservation|null>{
 const rawObs=await page.evaluate(()=>{
  const bodyText=document.body?.innerText?.slice(0,28000)||'';
  const isQuizView=/\/mod\/quiz\/view\.php/i.test(location.href);
  const attemptTexts:string[]=[];
  if(isQuizView){
   const candidates=Array.from(document.querySelectorAll('table.generaltable, table.quizattemptsummary, .quizattemptsummary, [data-region="attempt-summary"]'));
   const roots=candidates.filter(el=>!candidates.some(other=>other!==el&&other.contains(el)));
   for(let i=0;i<roots.length;i++){
    const root=roots[i];
    const rows=Array.from(root.querySelectorAll('tbody tr'));
    const hasVerticalGradeRow=rows.some(tr=>/^(?:grade|điểm(?:\s*(?:thi|số))?)\b/i.test((tr.querySelector('th, td:first-child')?.textContent||'').replace(/\s+/g,' ').trim()));
    const finishedRows=rows.filter(tr=>/đã\s*kết\s*thúc|finished|hoàn\s*thành|đã\s*nộp|submitted/i.test(tr.textContent||''));
    if(!hasVerticalGradeRow&&finishedRows.length>0){
     for(let r=0;r<finishedRows.length;r++){
      const cells=Array.from(finishedRows[r].querySelectorAll('th, td')).map(c=>(c.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
      attemptTexts.push(cells.length>0?cells.join(' '):(finishedRows[r].textContent||'').replace(/\s+/g,' ').trim());
     }
    }else{
     if(hasVerticalGradeRow){
      const cardAll=(root.textContent||'').replace(/\s+/g,' ').trim();
      if(/đã\s*kết\s*thúc|finished|hoàn\s*thành|đã\s*nộp|submitted/i.test(cardAll)){
       const gradeRow=rows.find(tr=>/^(?:grade|điểm(?:\s*(?:thi|số))?)\b/i.test((tr.querySelector('th, td:first-child')?.textContent||'').replace(/\s+/g,' ').trim()));
       if(gradeRow){
        const cells=Array.from(gradeRow.querySelectorAll('th, td')).map(c=>(c.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
        attemptTexts.push(cells.length>0?cells.join(' '):(gradeRow.textContent||'').replace(/\s+/g,' ').trim());
       }
      }
     }else{
      const cardText=(root.textContent||'').replace(/\s+/g,' ').trim();
      if(/đã\s*kết\s*thúc|finished|hoàn\s*thành|đã\s*nộp|submitted/i.test(cardText))attemptTexts.push(cardText);
     }
    }
   }
  }
  return {bodyText,attemptTexts};
 }).catch(()=>({bodyText:'',attemptTexts:[] as string[]}));

 if(rawObs.attemptTexts.length>0){
  const parsedAttempts:ParsedScoreMatch[]=[];
  for(const rowTxt of rawObs.attemptTexts){
   const explicit=findAllScores(rowTxt);
   if(explicit.length>0){
    parsedAttempts.push(explicit[explicit.length-1]);
    continue;
   }
   const cleaned=rowTxt.replace(/(?:grade\s*to\s*pass|passing\s*grade|maximum\s*grade|điểm\s*(?:để\s*)?đạt|điểm\s*tối\s*đa)\s*[:=/]?\s*\d+(?:[.,]\d+)?(?:\s*(?:out of|\/|trên)\s*\d+(?:[.,]\d+)?)?/giu,' ');
   const bare=cleaned.match(/(\d+(?:[.,]\d+)?)\s*(?:out of|\/|trên)\s*(\d+(?:[.,]\d+)?)(?:\s*\(\d+(?:[.,]\d+)?%\))?/iu);
   if(bare){
    const s=Number(bare[1].replace(',','.')),mx=Number(bare[2].replace(',','.'));
    if(Number.isFinite(s)&&Number.isFinite(mx)&&mx>0&&s>=0&&s<=mx){
     parsedAttempts.push({text:`Grade ${bare[0]}`.slice(0,120),score:s,max:mx});
    }
   }
  }
  if(parsedAttempts.length>0){
   const latest=parsedAttempts[parsedAttempts.length-1];
   const highest=parsedAttempts.reduce((best,cur)=>cur.score>=best.score?cur:best,parsedAttempts[0]);
   const latestText=/^(?:grade|điểm)/iu.test(latest.text)?latest.text:`Grade ${latest.text}`;
   if(parsedAttempts.length>1&&highest.score>latest.score){
    return {
     text:`${latestText} (Lượt mới nhất #${parsedAttempts.length} | Cao nhất: ${highest.score.toFixed(2)}/${highest.max.toFixed(2)})`.slice(0,160),
     source:page.url()
    };
   }
   return {text:latestText,source:page.url()};
  }
 }

 const found=findScore(rawObs.bodyText);return found?{text:found,source:page.url()}:null;
}
export function parseTopicRow(row:string[]):FamiTopic|null{
 const cells=row.map(x=>x.replace(/\s+/g,' ').trim());
 // Columns on the FAMI exam topics screen: class, course, topic, description, reading, exam, questions, max grade, grade, action
 if(cells.length<8)return null;
 const topic=cells[2];if(!topic||/^Tên chủ đề$/i.test(topic))return null;
 const num=(i:number):number|undefined=>/^\d{1,3}$/.test(cells[i]||'')?Number(cells[i]):undefined;
 return {topic:topic.slice(0,200),course:cells[1]||undefined,readingMinutes:num(4),examMinutes:num(5),questionCount:num(6),maximumScore:cells[7]||undefined,actionLabel:cells[cells.length-1]||undefined};
}
export async function observeFamiTopics(page:Page):Promise<FamiTopic[]> {
 if(new URL(page.url()).hostname!=='fami.hust.edu.vn')return [];
 const rows=await page.evaluate(()=>[...document.querySelectorAll('table tbody tr,[role="rowgroup"] [role="row"]')].slice(0,100).map(tr=>[...tr.querySelectorAll('td,[role="cell"]')].map(td=>(td.textContent||'').trim().slice(0,220))));
 return rows.map(parseTopicRow).filter((x):x is FamiTopic=>Boolean(x));
}
