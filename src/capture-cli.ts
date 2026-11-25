/** Private, read-only inventory after the account owner authenticates.
 * Does not export cookies, passwords, browser storage or form response values.
 */
import {chromium} from 'playwright';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadConfig,ensureAllowed,originTrustFromConfig} from './config.js';
import {listAccounts,accountContext,loginForContext} from './accounts.js';
import {readSurfaces} from './interaction.js';
import {scanQuestions} from './scanner.js';
import {platformForUrl} from './platforms.js';
import {observeAccess} from './access-gates.js';
import {observeFamiTopics,observeScore} from './observations.js';
function safeUrl(s:string):string{try{const u=new URL(s);u.search='';u.hash='';return u.toString()}catch{return '[UNKNOWN]'}}
function partialRedact(s:string):string{return s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[EMAIL]').replace(/\b\d{9,13}\b/g,'[NUMBER]')}
async function main(){
 const ui=createInterface({input:stdin,output:stdout});
 let browser:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
 try{
  const config=await loadConfig(process.argv[2]||'.private/browser-task.json');
  const url=process.argv[3]||config.discoveryStartUrls?.[0]||config.tasks[0]?.url;
  if(!url)throw new Error('Pass an approved page URL');
  const originOpts=originTrustFromConfig(config);
  ensureAllowed(url,config.allowedHosts,originOpts);
  const accounts=await listAccounts();const account=config.accountId?accounts[config.accountId]:null;
  browser=account?await accountContext(config.accountId!,account):await chromium.launchPersistentContext(resolve('.private','chromium-profile'),{headless:false});
  if(account)await loginForContext(browser,config.accountId!,account,q=>ui.question(q));
  const page=await browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
  console.log('Read-only inspection. Complete login/MFA manually if necessary. No page form submission.');
  await ui.question('Press Enter when the target page is visible: ');
  ensureAllowed(page.url(),config.allowedHosts,originOpts);
  const components=[];
  for(const {frame,url:frameUrl} of await readSurfaces(page,config.allowedHosts,originOpts)){
   const questions=await scanQuestions(frame);
   const controls=await frame.evaluate(()=>({buttons:[...document.querySelectorAll('button,[role="button"]')].slice(0,80).map(e=>(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,80)),links:[...document.querySelectorAll('a[href]')].slice(0,100).map(a=>({title:(a.textContent||'').trim().slice(0,80),path:(a as HTMLAnchorElement).pathname}))}));
   components.push({frame:safeUrl(frameUrl),platform:platformForUrl(frameUrl),questionCount:questions.length,questions:questions.map(q=>({kind:q.kind,prompt:partialRedact(q.prompt.slice(0,180)),options:q.options.length,hasVisual:q.hasVisual})),controls});
  }
  const score=await observeScore(page);
  const famiTopics=await observeFamiTopics(page);
  const accessGates=await observeAccess(page);
  const result={capturedAt:new Date().toISOString(),sourceUrl:safeUrl(page.url()),title:partialRedact(await page.title()),components,accessGates,scoreObserved:score?.text||null,famiTopics:famiTopics.map(t=>({...t,topic:partialRedact(t.topic)}))};
  await mkdir('.private/inspections',{recursive:true});
  const location=resolve('.private','inspections',`site-${Date.now()}.json`);
  await writeFile(location,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log('Saved locally: '+location);
  console.log('IMPORTANT: Manually inspect/redact names, course titles and private information before sharing. Never share cookies or auth state.');
 }finally{await browser?.close();ui.close()}
}
void main().catch(e=>{console.error(e);process.exitCode=1});
