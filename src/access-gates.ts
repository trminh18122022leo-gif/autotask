/** Read-only recognition of availability controls and timed sessions.
 * No clock manipulation, challenge bypass, or synthetic reading progress.
 */
import type {Page} from 'playwright';
export type GateKind = 'FAMI_READING'|'NOT_YET_OPEN'|'PHASED_ENTRY'|'HUMAN_VERIFICATION'|'QUIZ_TIMER';
export interface AccessGate {kind:GateKind; blocked:boolean; reason:string; remainingSeconds?:number; recheckAfter?:string; observedAt:string}
export function durationSeconds(text:string):number|undefined {
 const hms=text.match(/\b(\d{1,3}):(\d{2}):(\d{2})\b/);
 if(hms)return Number(hms[1])*3600+Number(hms[2])*60+Number(hms[3]);
 const ms=text.match(/\b(\d{1,3}):(\d{2})\b/);
 if(ms)return Number(ms[1])*60+Number(ms[2]);
 const h=text.match(/(\d+)\s*(?:giờ|hours?|hrs?)(?=\s|$|[,.;])/i)?.[1];
 const m=text.match(/(\d+)\s*(?:phút|minutes?|mins?)(?=\s|$|[,.;])/i)?.[1];
 const s=text.match(/(\d+)\s*(?:giây|seconds?|secs?)(?=\s|$|[,.;])/i)?.[1];
 if(h||m||s)return Number(h||0)*3600+Number(m||0)*60+Number(s||0);
 return undefined;
}
export function classifyAccess(text:string,url:string, now=new Date()):AccessGate[] {
 const compact=text.replace(/\s+/g,' ').slice(0,25000);
 const at=now.toISOString(),gates:AccessGate[]=[];
 const fami=/fami\.hust\.edu\.vn/i.test(url);
 const reading=compact.match(/(?:Bạn đọc quá nhanh|Thời gian đọc còn lại|xem lại tài liệu trước khi có thể bắt đầu thi)[^.\n]{0,220}/i);
 if(fami&&reading){
   const remaining=compact.match(/Thời gian đọc còn lại\s*[:：]?\s*([^.!\n]{0,70})/i)?.[1]||reading[0];
   const seconds=durationSeconds(remaining);
   gates.push({kind:'FAMI_READING',blocked:true,reason:'FAMI yêu cầu đọc đủ thời gian trước khi mở bài; không tự động bỏ qua',observedAt:at,...(seconds!==undefined?{remainingSeconds:seconds,recheckAfter:new Date(now.valueOf()+seconds*1000).toISOString()}:{})});
 }
 if(/this quiz is currently not available|bài (?:kiểm tra|thi) (?:chưa|không) (?:mở|khả dụng)|quiz is not available|chưa đến thời gian/i.test(compact)){
   const phase=/phased entry|your turn for this quiz|randomly with up to/i.test(compact);
   gates.push({kind:phase?'PHASED_ENTRY':'NOT_YET_OPEN',blocked:true,reason:phase?'Hệ thống xếp lượt, cần chờ được cấp quyền vào bài':'Bài chưa khả dụng theo lịch của hệ thống',observedAt:at});
 }
 if(/captcha|verify your identity|xác minh danh tính/i.test(compact)&&/(?:recaptcha|captcha|security challenge|xác minh danh tính)/i.test(compact)){
   gates.push({kind:'HUMAN_VERIFICATION',blocked:true,reason:'Cần người dùng xác thực bằng giao diện chính thức',observedAt:at});
 }
 // A running quiz timer is informational: never claim that the timer can be paused.
 const timer=compact.match(/(?:Time left|Remaining time|Thời gian còn lại)\s*[:：]?\s*((?:\d+:){1,2}\d{2}|\d+\s*(?:minutes?|phút|giây|seconds?))/i);
 if(timer)gates.push({kind:'QUIZ_TIMER',blocked:false,reason:'Bài đang giới hạn thời gian; đồng hồ của website tiếp tục chạy',observedAt:at,...(durationSeconds(timer[1])!==undefined?{remainingSeconds:durationSeconds(timer[1])}:{})});
 return gates;
}
/** Extracts ONLY visible text. Site availability takes precedence over browser timers. */
export async function observeAccess(page:Page):Promise<AccessGate[]> {
 const text=await page.evaluate(()=>document.body?.innerText?.slice(0,25000)||'');
 return classifyAccess(text,page.url());
}
export function mostRestrictive(gates:AccessGate[]):AccessGate|undefined{return gates.find(g=>g.blocked)}
/** Optional local foreground monitor. Does not simulate reading, skip an entry gate,
 * alter timers, or submit anything. It only watches the real UI state.
 */
export async function watchUntilAccessible(
 observe:()=>Promise<AccessGate[]>,
 maxMinutes:number,
 onBlocked?:(gate:AccessGate)=>void,
 sleep:(ms:number)=>Promise<void>=(ms)=>new Promise(r=>setTimeout(r,ms)),
 now:()=>number=()=>Date.now()
):Promise<{ready:boolean;gate?:AccessGate;checks:number}>{
 if(!Number.isInteger(maxMinutes)||maxMinutes<0||maxMinutes>30)throw new Error('accessWatchMinutes must be 0..30');
 const deadline=now()+maxMinutes*60000;
 let checks=0;
 while(true){
  checks++;const blocked=mostRestrictive(await observe());
  if(!blocked)return {ready:true,checks};
  onBlocked?.(blocked);
  const remaining=deadline-now();
  if(remaining<=0)return {ready:false,gate:blocked,checks};
  await sleep(Math.min(20000,remaining));
 }
}
