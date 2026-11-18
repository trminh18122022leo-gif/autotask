/** Private AI notes are explicitly entered by the user, not derived from web text. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export interface NoteVault {global:string;byHost:Record<string,string>;byTask:Record<string,string>}
const file=resolve('.private','ai-notes.json');
const blank=():NoteVault=>({global:'',byHost:{},byTask:{}});
export function cleanNote(note:string):string {
 if(typeof note!=='string'||note.length>6000)throw new Error('Ghi chú phải là chuỗi tối đa 6000 ký tự');
 if(/(?:api[_ -]?key|password|mật khẩu|bearer token)\s*[:=]\s*\S+/i.test(note))throw new Error('Không ghi API key hoặc mật khẩu trong ghi chú');
 return note.trim();
}
export function validateVault(raw:unknown):NoteVault {
 if(!raw||typeof raw!=='object')throw new Error('Invalid note vault');
 const obj=raw as Partial<NoteVault>;
 const validateMap=(input:unknown):Record<string,string>=>{
  if(!input||typeof input!=='object'||Array.isArray(input))return {};
  const map:Record<string,string>={};
  for(const [k,v] of Object.entries(input)){
   if(k==='__proto__'||k==='constructor'||k==='prototype'||k.length>200)continue;
   map[k]=cleanNote(v as string);
  }
  return map;
 };
 return {global:cleanNote(obj.global||''),byHost:validateMap(obj.byHost),byTask:validateMap(obj.byTask)};
}
export async function loadNotes():Promise<NoteVault>{
 try{return validateVault(JSON.parse(await readFile(file,'utf8')))}catch(e){
  if((e as NodeJS.ErrnoException).code==='ENOENT')return blank();
  throw e;
 }
}
export async function saveNotes(vault:NoteVault):Promise<void>{
 const data=validateVault(vault);await mkdir('.private',{recursive:true});
 await writeFile(file,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600});
}
export function notesFor(vault:NoteVault,taskId:string,url:string,inline=''):string{
 const host=new URL(url).hostname;
 return [vault.global,vault.byHost[host],vault.byTask[taskId],cleanNote(inline)].filter(Boolean).join('\n\n').slice(0,12000);
}
