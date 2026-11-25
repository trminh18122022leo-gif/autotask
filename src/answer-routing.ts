/** AI-first routing. A form file is an explicit optional input source, not a quiz solver. */
import type { AppConfig, Task, Question, AnswerSourceMode } from './types.js';
import type { Platform } from './platforms.js';
import type { AnswerBank } from './answer-bank.js';
import { splitBankAndAi } from './answer-bank.js';

export function resolveAnswerSourceMode(config: Pick<AppConfig,'answerSourceMode'>,task:Pick<Task,'answerSourceMode'>):AnswerSourceMode {
  return task.answerSourceMode ?? config.answerSourceMode ?? 'AI_PRIMARY';
}

/** Moodle Quiz and platform exercises use AI even if the operator previously selected a form data file.
 * The optional form data file is only used for general form-entry surfaces; an explicit mode alone
 * never silently turns a graded/practice quiz into a file-sourced answer batch.
 */
export function isFormEntrySurface(platform:Platform, url:string):boolean {
  if (!['generic','google-forms','microsoft-forms'].includes(platform)) return false;
  let pathname='';
  try {pathname=new URL(url).pathname.toLowerCase();}catch{return false;}
  if (/\/(?:mod\/quiz|quiz|assessment|exam|test|kiem-tra|thi)(?:\/|$)/i.test(pathname)) return false;
  return true;
}

export function partitionByAnswerSource(
  questions:Question[], bank:AnswerBank,mode:AnswerSourceMode,platform:Platform,url:string
):{bankAnswers:import('./types.js').Answer[];unmatched:Question[]} {
  if(mode!=='FORM_FILE' || !bank.rows.length || !isFormEntrySurface(platform,url)) {
    return {bankAnswers:[],unmatched:[...questions]};
  }
  return splitBankAndAi(questions,bank);
}
