import { mkdir, writeFile } from 'node:fs/promises';
import type { Deadline, TaskResult } from './types.js';
import {header,section,entry,pill,info,warn,close} from './ui/tokyo.js';
import { redactObject, redactSecrets } from './security/redact.js';
export async function saveReport(results:TaskResult[], deadlines:Deadline[]):Promise<string> {
 const folder='reports';
 await mkdir(folder,{recursive:true});
 const path=`${folder}/report-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
 const sanitized=redactObject(results.map(({page,...rest})=>rest));
 const sanitizedDeadlines=redactObject(deadlines);
 await writeFile(path,JSON.stringify({createdAt:new Date().toISOString(),results:sanitized,deadlines:sanitizedDeadlines},null,2),'utf8');
 return path;
}
export function printSummary(results: TaskResult[], deadlines:Deadline[]):void {
 section('Job report');
 for(const r of results){
  console.log('  '+pill(r.status)+'  '+r.id+'   '+r.questionsFilled+'/'+r.questionsFound+'  '+r.title.slice(0,60));
  if(r.warnings.length)warn(redactSecrets(r.warnings.join('; ').slice(0,420)));
  if(r.accessGate){entry('ACCESS GATE',r.accessGate.kind,'orange');if(r.accessGate.remainingSeconds!==undefined)entry('REMAINING',Math.ceil(r.accessGate.remainingSeconds/60)+' min','orange');if(r.accessGate.recheckAfter)entry('RECHECK (NOT UNLOCK)',r.accessGate.recheckAfter,'cyan');}
  if(r.scoreObserved)entry('OBSERVED SCORE',r.scoreObserved,'aqua');
 }
 section('Upcoming deadlines');
 if(deadlines.length){
  for(const d of deadlines.slice(0,20)){
    const hours=d.remainingHours;
    const alert=hours!==null&&hours<0?'OVERDUE':hours!==null&&hours<=24?'DUE <24H':hours!==null&&hours<=72?'DUE <3D':'UPCOMING';
    entry(alert+' · '+d.dueAt,`${d.label.slice(0,50)}  (${hours}h)`,alert==='OVERDUE'?'red':alert.startsWith('DUE')?'orange':'cyan');
  }
 }else info('No deadlines detected. Site-specific adapters may be necessary.');
}
