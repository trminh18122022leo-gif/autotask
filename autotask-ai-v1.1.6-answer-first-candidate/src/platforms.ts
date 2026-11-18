/** URL-aware, conservative platform hints. These are not claims of compatibility. */
import type {Page,Frame} from 'playwright';
export type Platform = 'google-forms'|'microsoft-forms'|'english-discoveries'|'moodle'|'fami'|'generic';
export interface PlatformHints {platform:Platform;questionContainers:string[];courseMarkers:string[];activityMarkers:string[];nextLabels:RegExp;features:string[]}
/** Hosts verified as Moodle by exact match. Every other Moodle host must be supplied by the user (and also be in allowedHosts). */
export const KNOWN_MOODLE_HOSTS:readonly string[]=['lms.hust.edu.vn','lms.fintech.hust.edu.vn'];
/** `userMoodleHosts` is the user's explicit AppConfig.moodleHosts. A host is never added automatically. */
export function platformForUrl(raw:string,userMoodleHosts:readonly string[]=[]):Platform {
  const {hostname,pathname}=new URL(raw);
  const host=hostname.toLowerCase();
  if(host==='docs.google.com' && pathname.startsWith('/forms/'))return 'google-forms';
  if(host==='forms.office.com'||host==='forms.microsoft.com')return 'microsoft-forms';
  if(host==='englishdiscoveries.net'||host.endsWith('.englishdiscoveries.net'))return 'english-discoveries';
  if(KNOWN_MOODLE_HOSTS.includes(host)||userMoodleHosts.map(h=>h.toLowerCase()).includes(host))return 'moodle';
  if(host==='fami.hust.edu.vn')return 'fami';
  return 'generic';
 }
/** DOM evidence that a page is Moodle (any single strong signal). Used only for hosts the user already allowed. */
export async function moodleDomSignals(target:Page|Frame):Promise<boolean>{
  try{return await target.evaluate(()=>{
   const gen=document.querySelector('meta[name="generator"]')?.getAttribute('content')||'';
   const body=document.body?.className||'';
   return /moodle/i.test(gen)||/\bpath-mod-quiz\b|\bmoodle\b/.test(body)||!!document.querySelector('div.que .formulation .qtext')||!!(window as unknown as {M?:{cfg?:unknown}}).M?.cfg;
  });}catch{return false}
}
/**
 * Platform from URL first; for a generic host that the user has ALREADY put in allowedHosts, fall back to DOM
 * evidence. It never widens allowedHosts and never reclassifies fami/english-discoveries/forms hosts.
 */
export async function detectPlatform(target:Page|Frame,allowedHosts:readonly string[],userMoodleHosts:readonly string[]=[]):Promise<Platform>{
  const byUrl=platformForUrl(target.url(),userMoodleHosts);
  if(byUrl!=='generic')return byUrl;
  let host='';try{host=new URL(target.url()).hostname.toLowerCase()}catch{return 'generic'}
  if(!allowedHosts.map(h=>h.toLowerCase()).includes(host))return 'generic';
  return (await moodleDomSignals(target))?'moodle':'generic';
}
const generic:PlatformHints={platform:'generic',questionContainers:['fieldset','[role="group"]','[data-question]','.question','.quiz-question'],courseMarkers:['course','môn học','class'],activityMarkers:['assignment','quiz','practice','homework','exercise','test','lesson'],nextLabels:/^(next|continue|tiếp theo|trang sau|trang tiếp|trang tiếp theo|next page)$/i,features:['radio','checkbox','text','textarea','select','file']};
export function hintsForPlatform(p:Platform):PlatformHints{
  if(p==='google-forms')return {...generic,platform:p,questionContainers:['.Qr7Oae','.freebirdFormviewerComponentsQuestionBaseRoot','[data-params]',...generic.questionContainers],nextLabels:/^(next|tiếp|tiếp theo)$/i,features:[...generic.features,'role-radio','role-checkbox','role-listbox','paged-form']};
  if(p==='microsoft-forms')return {...generic,platform:p,questionContainers:['[data-automation-id="questionItem"]','[data-automation-id="question"]','[data-testid*="question"]','.office-form-question',...generic.questionContainers],nextLabels:/^(next|next section|tiếp theo)$/i,features:[...generic.features,'likert-when-exposed-as-radio','paged-form']};
  if(p==='english-discoveries')return {...generic,platform:p,questionContainers:['.exercise','.activity','.exercise-question','[data-question-id]',...generic.questionContainers],activityMarkers:['lesson','unit','practice','exercise','assessment','activity','quiz','assignment'],features:[...generic.features,'iframe-reader','audio-detection']};
  if(p==='moodle')return {...generic,platform:p,questionContainers:['div.que','.formulation','.qtext','.answer',...generic.questionContainers],nextLabels:/^(next page|trang tiếp theo|trang tiếp|trang sau|tiếp|next)$/i,features:[...generic.features,'iframe-reader']};
  return {...generic,platform:p};
 }
/** URL scope checked at every navigation; no credential or unapproved host leakage. */
export function isLoginChallenge(s:string):boolean{return /captcha|verify (your|the) identity|security challenge|two.factor|authenticator|one.time code|xác minh danh tính|mã xác thực/i.test(s)}
export function isAudioOrSpeech(s:string):boolean{return /\b(speaking|microphone|record your voice|listening|audio response|recording|dictation)\b|ghi âm|nghe và|nói vào mic/i.test(s)}
