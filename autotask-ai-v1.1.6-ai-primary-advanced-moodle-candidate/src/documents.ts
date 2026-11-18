import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
export type FileKind='txt'|'md'|'csv'|'docx'|'pdf'|'xlsx';
export interface FileInput {title:string;content:string;format:FileKind;baseName?:string}
export interface FileOutput {path:string;bytes:number;format:FileKind}
export function safeFormat(fileName:string|undefined):FileKind {
 const extension=extname(fileName||'').replace('.','').toLowerCase();
 if(['txt','md','csv','docx','pdf','xlsx'].includes(extension))return extension as FileKind;
 return 'txt';
}
export async function createDocument(input:FileInput):Promise<FileOutput>{
 if(!input.content?.trim()||input.content.length>150000)throw new Error('File content must be non-empty and <=150000 characters');
 return new Promise((accept,reject)=>{
  const child=spawn(process.env.AUTOTASK_PYTHON||'python',['desktop/document_worker.py'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Document worker timeout'))},30000);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',s=>{out+=String(s).slice(0,20000)});
  child.stderr.on('data',s=>{err+=String(s).slice(0,4000)});
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('close',code=>{clearTimeout(timer);try{const obj=JSON.parse(out);if(code!==0||!obj.ok)throw new Error(obj.error||err||'Document worker failed');accept({path:obj.path,bytes:obj.bytes,format:obj.format})}catch(e){reject(e)}});
  child.stdin.end(JSON.stringify(input));
 });
}
