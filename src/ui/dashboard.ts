import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {section,entry,info,warn,pill} from './tokyo.js';
import type {TaskResult,Deadline} from '../types.js';
export interface StoredReport {createdAt:string;results:Omit<TaskResult,'page'>[];deadlines:Deadline[]}
export function deadlineSeverity(hours:number|null):'overdue'|'urgent'|'soon'|'future'|'unknown'{
 if(hours===null||!Number.isFinite(hours))return 'unknown';
 if(hours<0)return 'overdue';if(hours<=24)return 'urgent';if(hours<=72)return 'soon';return 'future';
}
export async function recentReports(limit=5):Promise<{file:string;report:StoredReport}[]> {
 let names:string[]=[];try{names=(await readdir('reports')).filter(x=>/^report-.*\.json$/.test(x)).sort().reverse().slice(0,Math.max(0,Math.min(30,limit)));}catch{return []}
 const out:{file:string;report:StoredReport}[]=[];
 for(const name of names){try{const obj=JSON.parse(await readFile(join('reports',name),'utf8'));
  if(!Array.isArray(obj.results)||!Array.isArray(obj.deadlines))continue;
  out.push({file:name,report:obj});}catch{}}
 return out;
}
export async function showReports():Promise<void>{
 const reports=await recentReports(10);section('Report history');
 if(!reports.length){info('No saved job reports yet.');return;}
 for(const {file,report} of reports){
  entry('SESSION',report.createdAt||file,'cyan');
  for(const r of report.results.slice(0,12))console.log('   '+pill(r.status)+'  '+r.id+'  '+r.questionsFilled+'/'+r.questionsFound+(r.scoreObserved?'  ·  '+r.scoreObserved:''));
  if(report.results.length>12)warn(`${report.results.length-12} more tasks in ${file}`);
  const due=report.deadlines.filter(d=>deadlineSeverity(d.remainingHours)==='urgent').length;
  if(due)warn(`${due} deadline(s) were within 24 hours when this report was created`);
  info(file);
 }
}
export async function dashboardAlerts():Promise<{urgent:number;overdue:number;lastReport?:string}>{
 const reports=await recentReports(1);if(!reports.length)return {urgent:0,overdue:0};
 const deadlines=reports[0].report.deadlines;
 // Recompute from current clock; stored remainingHours may be stale.
 const unique=[...new Map(deadlines.map(d=>[d.source+'|'+d.dueAt+'|'+d.label,d])).values()];
 const stats=unique.map(d=>deadlineSeverity((Date.parse(d.dueAt)-Date.now())/3600000));
 return {urgent:stats.filter(x=>x==='urgent').length,overdue:stats.filter(x=>x==='overdue').length,lastReport:reports[0].report.createdAt};
}
