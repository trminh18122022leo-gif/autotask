import type {Page,BrowserContext} from 'playwright';
import {createHash} from 'node:crypto';
import {ensureAllowed,type OriginTrustOptions} from './config.js';
import {isStateMutatingActionUrl,isMutatingHttpMethod} from './operation-mode.js';
import {scanDeadlines} from './calendar.js';
import type {Deadline,Task} from './types.js';
export type ActivityKind='quiz'|'assignment'|'form'|'course';
export interface DiscoveredActivity {id:string;title:string;url:string;kind:ActivityKind;course?:string;deadline?:string}
export interface DiscoveryReport {activities:DiscoveredActivity[];deadlines:Deadline[];pagesVisited:number;warnings:string[]}
export function kindFor(title:string,url:string):ActivityKind|null {
 const s=(title+' '+url).toLowerCase();
 if(/\b(quiz|test|practice|exercise|assessment|checkpoint)\b|trắc nghiệm|kiểm tra|luyện tập|bài luyện|mod\/quiz|sohoa\/thi-lt|sohoa\/phong-hoc\/kiem-tra/.test(s))return 'quiz';
 if(/\b(assignment|homework|activity|submission|writing task)\b|bài tập|nộp bài|mod\/assign/.test(s))return 'assignment';
 if(/forms\.office\.com|docs\.google\.com\/forms|\b(form|survey|khảo sát)\b/.test(s))return 'form';
 if(/\b(course|courses|my courses|classroom|curriculum|unit|module)\b|môn học|học phần|lớp học|course\/view|sohoa\/phong-hoc/.test(s))return 'course';
 return null;
}
export function safeLink(raw:string,base:string,hosts:readonly string[],originOptions?:OriginTrustOptions):string|null {
 try{const u=new URL(raw,base);ensureAllowed(u.toString(),hosts,originOptions);if(!['http:','https:'].includes(u.protocol))return null;
  u.hash='';if(isStateMutatingActionUrl(u.toString()))return null;if(/\.(zip|exe|msi|pdf|jpg|jpeg|png|mp4|docx|xlsx)(\?|$)/i.test(u.pathname))return null;
  return u.toString();}catch{return null}
}
export async function discoverActivities(context:BrowserContext,seeds:string[],hosts:readonly string[],maxPages=25,offset='+07:00',originOptions?:OriginTrustOptions):Promise<DiscoveryReport>{
 const work=[...seeds];const seen=new Set<string>();const items=new Map<string,DiscoveredActivity>();const deadlines:Deadline[]=[];const warnings:string[]=[];
 const page=await context.newPage();
 const blockedWrites:string[]=[];
 // Discovery is strictly read-only: block any non-GET request and any state-mutating action URL (incl. script-initiated fetch/XHR/forms).
 await page.route('**/*',route=>{const req=route.request();
  if(isMutatingHttpMethod(req.method())||isStateMutatingActionUrl(req.url())){blockedWrites.push(`${req.method()} ${req.url().split('?')[0]}`);return route.abort('blockedbyclient');}
  return route.fallback();});
 try{
 while(work.length&&seen.size<Math.min(50,maxPages)){
  const url=work.shift()!;if(seen.has(url))continue;
  try{ensureAllowed(url,hosts,originOptions);await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
   const current=page.url();ensureAllowed(current,hosts,originOptions);seen.add(url);
   deadlines.push(...await scanDeadlines(page,offset));
   const links=await page.evaluate(()=>[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0,400).map(a=>({url:a.href,title:(a.innerText||a.getAttribute('aria-label')||a.title||'').replace(/\s+/g,' ').trim().slice(0,240)})));
   for(const link of links){
    const target=safeLink(link.url,current,hosts,originOptions);if(!target)continue;
    const kind=kindFor(link.title,target);if(!kind)continue;
    const id='act-'+createHash('sha256').update(target).digest('hex').slice(0,14);
    if(!items.has(target))items.set(target,{id,title:link.title||kind,url:target,kind});
    if((kind==='course'||/\b(dashboard|my learning|learning path|units|lessons|my classes|activities)\b|môn học|chương trình|danh sách bài/i.test(link.title)) && !seen.has(target) && !work.includes(target) && work.length<100)work.push(target);
    // Most LMS lists a course page, then an activity page. Follow course links only;
    // never automatically open attempt/submit controls during discovery.
   }
  }catch(e){warnings.push(`${url}: ${e instanceof Error?e.message:String(e)}`.slice(0,220))}
 }
 }finally{await page.close()}
 if(blockedWrites.length)warnings.push(`[READ_ONLY_WRITE_BLOCKED] Discovery đã chặn ${blockedWrites.length} request ghi/thay đổi trạng thái: ${[...new Set(blockedWrites)].slice(0,5).join(', ')}`);
 const uniq=new Map<string,Deadline>();for(const d of deadlines)uniq.set(d.source+'|'+d.dueAt+'|'+d.label,d);
 return {activities:[...items.values()].filter(x=>x.kind!=='course'),deadlines:[...uniq.values()].sort((a,b)=>a.dueAt.localeCompare(b.dueAt)),pagesVisited:seen.size,warnings};
}
export function toTask(a:DiscoveredActivity):Task {return {id:a.id,url:a.url,title:a.title,aiPermitted:true,maxPages:8}}
