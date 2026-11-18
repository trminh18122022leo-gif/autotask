/** Bounded, durable desktop queue. One physical desktop action stream at a time. */
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
export type JobStatus='PENDING'|'RUNNING'|'COMPLETED'|'NEEDS_REVIEW'|'FAILED';
export interface JobState {id:string;status:JobStatus;steps:number;updatedAt:string;error?:string}
export interface QueueState {schemaVersion:1;jobs:JobState[];generatedAt:string}
export interface QueueJob {taskId:string; priority?:number; deadline?:string}
export function orderJobs<T extends QueueJob>(jobs:T[]):T[]{
 return [...jobs].sort((a,b)=> (b.priority||0)-(a.priority||0) ||
   (Date.parse(a.deadline||'9999-12-31')||8.64e15)-(Date.parse(b.deadline||'9999-12-31')||8.64e15));
}
export class QueueStore {
 constructor(readonly path:string){}
 async load():Promise<QueueState|undefined>{
  try {return JSON.parse(await readFile(this.path,'utf8')) as QueueState;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
 }
 async save(state:QueueState):Promise<void>{
  await mkdir(dirname(this.path),{recursive:true});
  state.generatedAt=new Date().toISOString();
  const temp=`${this.path}.tmp`;
  await writeFile(temp,JSON.stringify(state,null,2),'utf8');
  await rename(temp,this.path);
 }
 async init(jobs:QueueJob[],resume:boolean):Promise<QueueState>{
  const old=resume?await this.load():undefined;
  const existing=new Map(old?.jobs.map(j=>[j.id,j]));
  const state:QueueState={schemaVersion:1,generatedAt:'',jobs:jobs.map(j=>{
   const prev=existing.get(j.taskId);
   if(!prev)return {id:j.taskId,status:'PENDING',steps:0,updatedAt:new Date().toISOString()};
   // Never replay an interrupted in-flight click without explicit manual review.
   return {...prev,status:prev.status==='RUNNING'?'NEEDS_REVIEW':prev.status};
  })};
  await this.save(state);return state;
 }
 async change(state:QueueState,id:string,status:JobStatus,steps:number,error?:string):Promise<void>{
  const job=state.jobs.find(v=>v.id===id);
  if(!job)throw new Error('Unknown queue job');
  Object.assign(job,{status,steps,updatedAt:new Date().toISOString(),error});
  await this.save(state);
 }
}
export async function runExclusiveQueue<T extends QueueJob>(jobs:T[],handler:(job:T)=>Promise<void>):Promise<void>{
 // Strict sequential scheduler. Browser workers are independent and can use their own parallel tabs.
 for(const job of orderJobs(jobs)) await handler(job);
}
