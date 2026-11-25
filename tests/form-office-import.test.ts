import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAnswerBanks } from '../src/answer-bank.js';

const python=process.env.AUTOTASK_PYTHON||'python';
test('optional form file importer extracts static XLSX, DOCX and text PDF rows',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'autotask-office-form-'));
 try {
  execFileSync(python,['tests/helpers/build-form-document-fixtures.py',folder],{timeout:12000,windowsHide:true});
  const bank=await loadAnswerBanks(['form.xlsx','form.docx','form.pdf'].map(f=>join(folder,f)));
  assert.equal(bank.sources.length,3);
  const fields=new Map(bank.rows.map(r=>[r.question||r.prompt,r.answer]));
  assert.equal(fields.get('Student display name'),'Example Person');
  assert.equal(fields.get('Field number'),'42');
  assert.equal(fields.get('Contact preference'),'Email');
  assert.equal(fields.get('City'),'Ha Noi');
  assert.equal(fields.get('Event title'),'Weekly workshop');
 } finally {rmSync(folder,{recursive:true,force:true});}
});
