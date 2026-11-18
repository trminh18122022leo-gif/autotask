/** Arrow-key and number-key navigable terminal menu; never requires a GUI. */
import {createInterface, emitKeypressEvents} from 'node:readline';
import {paint} from './tokyo.js';
export interface MenuItem {id:string;label:string;description?:string}
export function nextSelection(current:number, key:string, size:number):number {
 if(size<1)return -1;
 if(key==='up'||key==='k')return (current+size-1)%size;
 if(key==='down'||key==='j')return (current+1)%size;
 const n=Number(key);if(Number.isInteger(n)&&n>=0&&n<size)return n;
 return current;
}
export async function selectMenu(title:string,items:MenuItem[]):Promise<string>{
 if(!items.length)throw new Error('Menu is empty');
 if(!process.stdin.isTTY||!process.stdout.isTTY||!process.stdin.setRawMode){
  const ui=createInterface({input:process.stdin,output:process.stdout});
  try {
   console.log('\n'+paint('◆ '+title,'cyan',true));
   items.forEach(item=>console.log(paint(`  [${item.id}] `,'purple')+item.label+(item.description?'  · '+item.description:'')));
   const answer=await new Promise<string>(resolve=>ui.question('  ❯ Choose › ',resolve));
   return items.find(x=>x.id===answer.trim())?.id||'';
  }finally{ui.close();}
 }
 const original=process.stdin.isRaw||false;
 const total=items.length+2;
 let selected=0;
 const width=Math.max(44,Math.min(110,(process.stdout.columns||86)-2));
 const truncate=(s:string,n:number)=>Array.from(s).slice(0,n).join('');
 const draw=(first:boolean)=>{
  if(!first)process.stdout.write(`\x1b[${total}A`);
  process.stdout.write('\x1b[2K'+paint('  ◆ '+title+'  (↑↓ • Enter • 0–9 • Esc)','cyan',true)+'\n');
  items.forEach((item,i)=>{
   const label=`[${item.id}] ${item.label}`;
   const suffix=item.description?` · ${item.description}`:'';
   const line=truncate(label+suffix,width-8);
   process.stdout.write('\x1b[2K'+(i===selected?paint('  ❯ '+line,'purple',true):paint('    '+line,'fg'))+'\n');
  });
  process.stdout.write('\x1b[2K'+paint('  Select an action, or Esc to exit.','muted')+'\n');
 };
 return new Promise<string>(resolve=>{
  let ended=false;
  const end=(value:string)=>{
   if(ended)return;ended=true;
   process.stdin.removeListener('keypress',onKey);
   process.stdin.setRawMode(original);process.stdout.write('\x1b[?25h\n');
   process.stdin.pause();resolve(value);
  };
  const onKey=(s:string,key:{name?:string;ctrl?:boolean})=>{
   if(key.ctrl&&key.name==='c'){end('0');return;}
   if(key.name==='escape'){end('0');return;}
   if(key.name==='return'||key.name==='enter'){end(items[selected].id);return;}
   const direct=items.findIndex(i=>i.id===s);
   if(direct>=0){selected=direct;draw(false);return;}
   const updated=nextSelection(selected,key.name||'',items.length);
   if(updated!==selected){selected=updated;draw(false);}
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);process.stdin.resume();
  process.stdin.on('keypress',onKey);
  process.stdout.write('\x1b[?25l');draw(true);
 });
}
