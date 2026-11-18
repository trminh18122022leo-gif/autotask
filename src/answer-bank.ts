/** Explicit user answer files: exact identifiers/prompts only, AI fallback for unmatched questions.
 * The bank never runs code or evaluates formulas. Invalid/ambiguous answers remain unresolved.
 */
import { readFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, dirname, isAbsolute, resolve, basename } from 'node:path';
import type { Question, Answer } from './types.js';

const MAX_BANK_BYTES = 4 * 1024 * 1024;
const execFileAsync=promisify(execFile);
const MAX_ROWS = 5000;
export interface AnswerBankRow {
 id?: string; stableId?: string; question?: string; prompt?: string;
 answer?: string; text?: string; selected?: string[] | string;
 choiceText?: string[] | string; localFilePath?: string; filePath?: string;
 fileName?: string; confidence?: number;
}
export interface AnswerBank { rows: AnswerBankRow[]; warnings: string[]; sources: string[] }
const norm = (s: string) => String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

function csvRows(src: string, delimiter = ','): string[][] {
 const rows: string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<src.length;i++){
  const c=src[i];
  if(c==='"'){if(quoted&&src[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===delimiter&&!quoted){row.push(cell);cell='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&src[i+1]==='\n')i++;row.push(cell);cell='';if(row.some(x=>x.trim()))rows.push(row);row=[];}
  else cell+=c;
 }
 if(quoted)throw new Error('CSV has an unmatched quotation mark');
 row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
 return rows;
}
function parseDelimited(src: string, delimiter: string): AnswerBankRow[] {
 const all=csvRows(src,delimiter);if(!all.length)return [];
 const headings=all.shift()!.map(s=>norm(s).replace(/[ _-]/g,''));
 const aliases:Record<string,keyof AnswerBankRow>={id:'id',stableid:'stableId',question:'question',prompt:'prompt', 'câuhỏi':'question', 'cauhoi':'question',answer:'answer','đápán':'answer',dapan:'answer',text:'text',selected:'selected',choicetext:'choiceText',filepath:'filePath',localfilepath:'localFilePath',filename:'fileName',confidence:'confidence'};
 if(!headings.some(h=>aliases[h]==='answer'||aliases[h]==='text'||aliases[h]==='selected'||aliases[h]==='filePath'))throw new Error('CSV/TSV answer file requires an answer/text/selected/filePath column');
 return all.map(line=>{const r:Record<string,unknown>={};headings.forEach((h,i)=>{if(aliases[h]&&line[i]?.trim())r[aliases[h]]=line[i].trim();});return r as AnswerBankRow;});
}
function parseText(src: string): AnswerBankRow[] {
 const rows:AnswerBankRow[]=[];
 // Q: prompt / A: answer, with blank lines separating pairs.
 let question='';
 for(const raw of src.split(/\r?\n/)){
  const line=raw.trim().replace(/^[-*]\s+/, '');
  if(!line)continue;
  const q=/^(?:Q|Question|Câu hỏi|Cau hoi)\s*:\s*(.+)$/i.exec(line);
  const ans=/^(?:A|Answer|Đáp án|Dap an)\s*:\s*(.*)$/i.exec(line);
  if(q){question=q[1];continue;}
  if(ans&&question){rows.push({question,answer:ans[1]});question='';continue;}
  const kv=/^(.+?)\s*(?:=>|\t|\s+\|\s+)\s*(.+)$/.exec(line);
  if(kv)rows.push({question:kv[1],answer:kv[2]});
 }
 return rows;
}
function parseJson(src: string): AnswerBankRow[] {
 const parsed:unknown=JSON.parse(src);
 if(Array.isArray(parsed))return parsed as AnswerBankRow[];
 if(!parsed||typeof parsed!=='object')throw new Error('JSON answer bank must be object or array');
 const data=parsed as Record<string,unknown>;
 if(Array.isArray(data.answers))return data.answers as AnswerBankRow[];
 if(Array.isArray(data.rows))return data.rows as AnswerBankRow[];
 return Object.entries(data).filter(([k])=>!['__proto__','prototype','constructor'].includes(k)).map(([question,v])=>typeof v==='string'?{question,answer:v}:{question,...(v&&typeof v==='object'&&!Array.isArray(v)?v:{answer:String(v)})}) as AnswerBankRow[];
}
export async function loadAnswerBanks(paths: string[]):Promise<AnswerBank> {
 const bank:AnswerBank={rows:[],warnings:[],sources:[]};
 for(const raw of paths){
  if(typeof raw!=='string'||!raw.trim()||/^https?:\/\//i.test(raw))throw new Error('Answer bank must be a local file explicitly selected by the user');
  const filepath=resolve(raw);
  const st=await lstat(filepath);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BANK_BYTES)throw new Error(`Invalid, symlinked, or oversized answer bank: ${basename(filepath)}`);
  const ext=extname(filepath).toLowerCase();
  let rows:AnswerBankRow[];
  if(['.xlsx','.docx','.pdf'].includes(ext)) {
    // Python bridge extracts static text/cached spreadsheet cell values only; it never evaluates macros/formulas.
    const script=resolve('scripts','import-form-data.py');
    let raw:string;
    try {
      const result=await execFileAsync(process.env.AUTOTASK_PYTHON||'python',[script,filepath],
        {timeout:20000,maxBuffer:6*1024*1024,windowsHide:true,env:{...process.env, PYTHONIOENCODING:'utf-8'}});
      raw=result.stdout;
    } catch(e) {
      throw new Error(`Cannot import ${ext} form data. Check Python dependencies (openpyxl/python-docx/pypdf): ${e instanceof Error?e.message:'import failed'}`);
    }
    const parsed=JSON.parse(raw) as {rows?:unknown};
    if(!Array.isArray(parsed.rows))throw new Error('Form importer returned invalid rows');
    rows=parsed.rows as AnswerBankRow[];
  } else {
    const src=(await readFile(filepath,'utf8')).replace(/^\uFEFF/,'');
  if(ext==='.json')rows=parseJson(src);
  else if(ext==='.csv')rows=parseDelimited(src,',');
  else if(ext==='.tsv')rows=parseDelimited(src,'\t');
  else if(ext==='.md'||ext==='.txt')rows=parseText(src);
  else throw new Error(`Unsupported form-data format ${ext}: use JSON, CSV, TSV, TXT, MD, XLSX, DOCX, PDF`);
  }
  if(bank.rows.length+rows.length>MAX_ROWS)throw new Error('Too many answer-bank rows');
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row))continue;
   const r={...row};
   const localPath=r.localFilePath||r.filePath;
   if(typeof localPath==='string'&&localPath.trim()){
    if(/^https?:\/\//i.test(localPath))throw new Error('Remote upload paths are forbidden');
    r.localFilePath=isAbsolute(localPath)?resolve(localPath):resolve(dirname(filepath),localPath);
   }
   bank.rows.push(r);
  }
  bank.sources.push(filepath);
 }
 return bank;
}
function splitSelections(raw: string[]|string|undefined):string[] {
 if(Array.isArray(raw))return raw.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean);
 if(typeof raw==='string')return raw.split(/\s*\|\s*|\s*;\s*/).map(x=>x.trim()).filter(Boolean);
 return [];
}
export function answerFromBank(q: Question, bank: AnswerBank): Answer|undefined {
 if(q.kind==='unsupported'||q.humanOnly)return undefined;
 const matching=bank.rows.filter(r=>{
  if(r.stableId)return !!q.stableId&&norm(r.stableId)===norm(q.stableId);
  if(r.id)return norm(r.id)===norm(q.id);
  return !!(r.question||r.prompt)&&norm(r.question||r.prompt||'')===norm(q.prompt);
 });
 // Conflicts are not guessed, even if two rows use the same question prompt.
 if(matching.length!==1)return undefined;
 const row=matching[0];
 const a:Answer={id:q.id}; // User-supplied is not a model confidence score or a guarantee of correctness.
 if(q.kind==='radio'||q.kind==='checkbox'||q.kind==='select'){
  const candidates=splitSelections(row.selected||row.choiceText||row.answer||row.text);
  if(!candidates.length)return undefined;
  const ids:string[]=[];
  const allowOptionIds=row.selected!==undefined;
  for(const token of candidates){
   const matches=q.options.filter(o=>norm(o.text)===norm(token)||(allowOptionIds&&o.id===token));
   if(matches.length!==1)return undefined;
   if(!ids.includes(matches[0].id))ids.push(matches[0].id);
  }
  if(q.kind!=='checkbox'&&ids.length!==1)return undefined;
  a.selected=ids;
 }else if(q.kind==='file'){
  const local=row.localFilePath||row.filePath;
  if(typeof local==='string'&&local.trim())a.localFilePath=local;
  else if(typeof row.text==='string'&&row.text.trim()){a.fileContent=row.text;a.fileName=row.fileName||'answer.txt';}
  else return undefined;
 }else{
  const val=row.text??row.answer;
  if(typeof val!=='string'||!val.trim())return undefined;
  a.text=val;
 }
 return a;
}
export function splitBankAndAi(questions:Question[], bank:AnswerBank):{bankAnswers:Answer[];unmatched:Question[]} {
 const bankAnswers:Answer[]=[],unmatched:Question[]=[];
 const prompts=new Map<string,number>();
 for(const q of questions)prompts.set(norm(q.prompt),(prompts.get(norm(q.prompt))||0)+1);
 for(const q of questions){
  // Repeated generic prompts may be separate distinct questions; do not reuse one prompt-only row for all.
  const ambiguous=(prompts.get(norm(q.prompt))||0)>1 && !bank.rows.some(r=>
   (r.stableId&&q.stableId&&norm(r.stableId)===norm(q.stableId))||(r.id&&norm(r.id)===norm(q.id)));
  const a=ambiguous?undefined:answerFromBank(q,bank);
  if(a)bankAnswers.push(a);else unmatched.push(q);
 }
 return {bankAnswers,unmatched};
}
