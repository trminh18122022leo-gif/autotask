import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {header,section,choice,success,entry,info,warn,close} from './ui/tokyo.js';
import {loadNotes,saveNotes,cleanNote} from './ai-notes.js';
async function main(){
 const cli=createInterface({input:stdin,output:stdout});
 try{
  header('AI NOTES VAULT');section('Private instructions');
  const vault=await loadNotes();
  entry('GLOBAL',vault.global?'Configured':'Empty');
  entry('WEBSITES',String(Object.keys(vault.byHost).length));
  entry('TASKS',String(Object.keys(vault.byTask).length));
  choice('1','Global note');choice('2','Website note');choice('3','Task note');choice('4','Delete note');
  const op=(await cli.question('Select option (Enter=Exit): ')).trim();
  if(!['1','2','3','4'].includes(op))return;
  let scope:'global'|'byHost'|'byTask'='global';let key='';
  if(op!=='1'){
   const target=op==='2'?'host':op==='3'?'task':(await cli.question('Delete scope [global/host/task]: ')).trim();
   if(target!=='global'&&target!=='host'&&target!=='task')throw new Error('Invalid scope');
   scope=target==='global'?'global':target==='host'?'byHost':'byTask';
   if(scope!=='global'){key=(await cli.question(scope==='byHost'?'Website hostname: ':'Task ID: ')).trim();
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(key))throw new Error('Invalid key');}
  }
  if(op==='4'){
   const confirmed=(await cli.question('Type DELETE to confirm: ')).trim();if(confirmed!=='DELETE')return;
   if(scope==='global')vault.global='';else delete vault[scope][key];
  } else {
   info('Có thể nhập nhiều dòng. Gõ .END để lưu. Không nhập mật khẩu hoặc dữ liệu riêng tư.');
   const lines:string[]=[];
   for(let i=0;i<50;i++){const line=await cli.question('  │ ');if(line==='.END')break;lines.push(line);if(lines.join('\n').length>6000)throw new Error('Note too long');}
   const value=cleanNote(lines.join('\n'));
   if(scope==='global')vault.global=value;else vault[scope][key]=value;
  }
  await saveNotes(vault);success('Đã lưu ghi chú trong .private/ai-notes.json (không đóng gói vào source).');
 }catch(e){warn(e instanceof Error?e.message:String(e));process.exitCode=1}
 finally{close('NOTES CLOSED');cli.close()}
}
void main();
