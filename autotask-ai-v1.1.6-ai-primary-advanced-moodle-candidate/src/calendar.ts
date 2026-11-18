import type { Page } from 'playwright';
import type { Deadline } from './types.js';
/** Parse Vietnamese DD/MM/YYYY and Moodle's weekday, DD Month YYYY, hh:mm AM/PM.
 * Treat a deadline as the *Closed/Closes/Due* date, never as the opening time.
 */
export function parseDeadline(raw: string, offset = '+07:00'): string|null {
 let text=raw.trim();
 if(!text)return null;
 // Example: "Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM"
 const closing=text.match(/(?:Closed?|Closes?|Due(?: date)?|Hạn nộp|Đóng)\s*[:：]?\s*(.*)$/i);
 if(closing)text=closing[1];
 const dmy=text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
 if(dmy){
  const [,d,m,y,h='23',min='59']=dmy;
  const dt=new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${min}:00${offset}`);
  if(!Number.isNaN(dt.valueOf())&&dt.getUTCFullYear()>=2020)return dt.toISOString();
 }
 const english=text.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*(?:AM|PM))?/i)
  ||text.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*(?:AM|PM))?/i);
 if(english){
  const match=english[0].replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i,'')
   .match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if(match){
   const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(match[2].toLowerCase());
   if(month>=0){
    let hour=Number(match[4]||'23');const minute=Number(match[5]||'59');
    if(match[6])hour=hour%12+(match[6].toUpperCase()==='PM'?12:0);
    const dt=new Date(`${match[3]}-${String(month+1).padStart(2,'0')}-${match[1].padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00${offset}`);
    if(!Number.isNaN(dt.valueOf()))return dt.toISOString();
   }
  }
 }
 const iso=text.match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?/);
 if(iso){
  const candidate=iso[0].length===10?`${iso[0]}T23:59:00${offset}`:iso[0];
  const date=new Date(candidate);return Number.isNaN(date.valueOf())?null:date.toISOString();
 }
 return null;
}
export async function scanDeadlines(page: Page, offset='+07:00'):Promise<Deadline[]> {
 const entries=await page.evaluate(()=>{
  const selector='time[datetime], [data-due], [data-deadline], .due-date, .deadline, [data-region="due-date"], .activity-dates, .calendar_event_course, .activity-item, li.activity, .course-content li, .description, .generalbox';
  return [...document.querySelectorAll(selector)].slice(0,300).map(el=>({
   raw:el.getAttribute('datetime')||el.getAttribute('data-due')||el.getAttribute('data-deadline')||el.textContent||'',
   label:(el.closest('li,article,tr,.assignment,.card,.activity')?.textContent||el.parentElement?.textContent||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,160)
  }));
 });
 const now=Date.now(),out:Deadline[]=[],seen=new Set<string>();
 for(const entry of entries){
  const dueAt=parseDeadline(entry.raw,offset);if(!dueAt)continue;
  const remainingHours=Math.round((new Date(dueAt).valueOf()-now)/3600000*10)/10;
  const key=entry.label+'|'+dueAt;if(seen.has(key))continue;seen.add(key);
  out.push({label:entry.label,dueAt,source:page.url(),remainingHours});
 }
 return out.sort((a,b)=>a.dueAt.localeCompare(b.dueAt));
}
