/** Observational utilities for existing Moodle results and FAMI topics.
 * Only reports values already visible to the signed-in user.
 */
import type {Page} from 'playwright';
export interface ScoreObservation {text:string;source:string}
export interface FamiTopic {topic:string;course?:string;readingMinutes?:number;examMinutes?:number;questionCount?:number;maximumScore?:string;actionLabel?:string}
export function findScore(text:string):string|null{
 const normalized=text.replace(/\s+/g,' ');
 // Moodle & FAMI: "Grade 9.00 out of 10.00 (90%)", "Điểm 8,00/10", "Điểm đạt: 9,00/10", "Điểm số: 8.5 trên 10"
 // Unicode-aware boundary avoids JS ASCII-only \b failing on Vietnamese 'Đ' / 'ố'.
 const m=normalized.match(/(?:^|[^\p{L}\p{N}_])((?:Grade|Điểm(?:\s+(?:thi|số|đạt))?)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(?:out of|\/|trên)\s*(\d+(?:[.,]\d+)?)(?:\s*\((\d+(?:[.,]\d+)?%)\))?)/iu);
 if(!m)return null;
 const score=Number(m[2].replace(',','.')),max=Number(m[3].replace(',','.'));
 if(!Number.isFinite(score)||!Number.isFinite(max)||max<=0||score<0||score>max)return null;
 return m[1].slice(0,120);
}
export async function observeScore(page:Page):Promise<ScoreObservation|null>{
 const text=await page.evaluate(()=>document.body?.innerText?.slice(0,28000)||'');
 const found=findScore(text);return found?{text:found,source:page.url()}:null;
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
