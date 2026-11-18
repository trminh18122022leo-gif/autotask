import type { Page } from 'playwright';
import type { Deadline } from './types.js';
/** Parse Vietnamese DD/MM/YYYY and Moodle's weekday, DD Month YYYY, hh:mm AM/PM.
 * Treat a deadline as the *Closed/Closes/Due* date, never as the opening time.
 */
const VI_MONTHS: [RegExp, number][] = [
 [/tháng\s*(?:mười\s*hai|chạp|12)\b/i, 12],
 [/tháng\s*(?:mười\s*một|11)\b/i, 11],
 [/tháng\s*(?:mười|10)\b/i, 10],
 [/tháng\s*(?:chín|0?9)\b/i, 9],
 [/tháng\s*(?:tám|0?8)\b/i, 8],
 [/tháng\s*(?:bảy|0?7)\b/i, 7],
 [/tháng\s*(?:sáu|0?6)\b/i, 6],
 [/tháng\s*(?:năm|0?5)\b/i, 5],
 [/tháng\s*(?:tư|bốn|0?4)\b/i, 4],
 [/tháng\s*(?:ba|0?3)\b/i, 3],
 [/tháng\s*(?:hai|0?2)\b/i, 2],
 [/tháng\s*(?:một|giêng|0?1)\b/i, 1]
];

export function parseDeadline(raw: string, offset = '+07:00'): string|null {
 let text=raw.trim();
 if(!text)return null;
 // Example: "Opened: Monday, 26 October 2026, 12:00 AM Closed: Saturday, 14 November 2026, 11:59 PM"
 const closing=text.match(/(?:Đã\s+đóng|Đóng(?:\s+vào)?|Hạn\s+(?:nộp|chót)|Ngày\s+đến\s+hạn|Kết\s+thúc|Closed?|Closes?|Due(?:\s+date)?)\s*[:：]?\s*(.*)$/i);
 if(closing)text=closing[1];
 else if(/(?:Opened|Opens|Mở(?:\s+vào)?|Ngày\s+mở|Bắt\s+đầu)\s*[:：]/i.test(text))return null;
 const dmy=text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH))?)?/i);
 if(dmy){
  const [,d,m,y,rawH='23',min='59',mer]=dmy;
  let h=Number(rawH);
  if(mer){
   const isPm=/^(PM|CH)$/i.test(mer);
   h=(h%12)+(isPm?12:0);
  }
  const dt=new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${String(h).padStart(2,'0')}:${min}:00${offset}`);
  if(!Number.isNaN(dt.valueOf())&&dt.getUTCFullYear()>=2020)return dt.toISOString();
 }
 // Vietnamese Moodle format: "Thứ Bảy, 14 Tháng Mười Một 2026, 11:59 PM" or "14 Tháng 10 năm 2026, 23:59 CH"
 const viMatch=text.match(/(\d{1,2})\s+(tháng\s+(?:mười\s*hai|mười\s*một|mười|chạp|giêng|một|hai|ba|tư|bốn|năm|sáu|bảy|tám|chín|\d{1,2}))(?:\s+năm)?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH))?)?/i);
 if(viMatch){
  const [,dayStr,monthPhrase,yearStr,rawH='23',min='59',mer]=viMatch;
  const foundMonth=VI_MONTHS.find(([re])=>re.test(monthPhrase))?.[1];
  if(foundMonth){
   let h=Number(rawH);
   if(mer){
    const isPm=/^(PM|CH)$/i.test(mer);
    h=(h%12)+(isPm?12:0);
   }
   const dt=new Date(`${yearStr}-${String(foundMonth).padStart(2,'0')}-${dayStr.padStart(2,'0')}T${String(h).padStart(2,'0')}:${min}:00${offset}`);
   if(!Number.isNaN(dt.valueOf())&&dt.getUTCFullYear()>=2020)return dt.toISOString();
  }
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
  const selector='time[datetime], [data-due], [data-deadline], .due-date, .deadline, [data-region="due-date"], [data-region="activity-dates"], .activity-dates, .calendar_event_course, .activity-item, li.activity';
  return [...document.querySelectorAll(selector)].slice(0,300).map(el=>{
   let raw=el.getAttribute('datetime')||el.getAttribute('data-due')||el.getAttribute('data-deadline')||el.textContent||'';
   if(el.tagName==='TIME'){
    const pText=(el.parentElement?.textContent||'').trim();
    if(/(?:Opened|Opens|Mở(?:\s+vào)?|Ngày\s+mở|Bắt\s+đầu)\s*[:：]/i.test(pText)&&!/(?:Closed?|Closes?|Due(?:\s+date)?|Đóng|Hạn)/i.test(pText)){
     raw='';
    }
   }
   const act=el.closest('.activity-item, li.activity, .calendar_event_course, article, tr, .assignment, .card');
   let title='';
   const titleEl=act?.querySelector('.instancename, .activityname, a.aalink, h3, h4');
   if(titleEl){
    const cl=titleEl.cloneNode(true) as HTMLElement;
    cl.querySelectorAll('.accesshide, .sr-only, [data-region="completion-info"], .activity-dates').forEach(n=>n.remove());
    title=(cl.textContent||'').trim().replace(/\s+/g,' ');
   }
   if(!title){
    title=(act?.textContent||el.parentElement?.textContent||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,120);
   }
   const secEl=el.closest('li.section, .course-section, [data-for="section"], .section');
   const secTitle=(secEl?.querySelector('.sectionname, .section-title, h3.sectionname, [data-for="section_title"]')?.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
   const label=(secTitle&&!title.includes(secTitle)?`[${secTitle}] ${title}`:title).slice(0,160);
   return {raw,label};
  });
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
