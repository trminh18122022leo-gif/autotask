import {chromium} from 'playwright';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {resolve} from 'node:path';
import {loadConfig,originTrustFromConfig} from './config.js';
import {listAccounts,accountContext,loginForContext} from './accounts.js';
import {discoverActivities} from './discovery.js';
import {header,section,entry,info,warn,success} from './ui/tokyo.js';
const ui=createInterface({input:stdin,output:stdout});
export async function runDiscover(){
 const config=await loadConfig(process.argv[2]||'.private/browser-task.json');
 const accounts=await listAccounts();const acct=config.accountId?accounts[config.accountId]:null;
 const context=acct?await accountContext(config.accountId!,acct):await chromium.launchPersistentContext(resolve('.private/chromium-profile'),{headless:false});
 try{
  header('LMS DISCOVERY');
  if(acct)await loginForContext(context,config.accountId!,acct,q=>ui.question(q));
  const urls=config.discoveryStartUrls?.length?config.discoveryStartUrls:config.tasks.map(t=>t.url);
  const found=await discoverActivities(context,urls,config.allowedHosts,config.maxDiscoveryPages||25,config.deadlineOffset,originTrustFromConfig(config));
  section('Courses, quizzes and assignments');for(const a of found.activities)entry(a.kind.toUpperCase(),a.title.slice(0,66));
  section('Upcoming deadlines');for(const d of found.deadlines.slice(0,25))entry(d.dueAt,d.label.slice(0,65));
  for(const w of found.warnings)warn(w);success(`${found.activities.length} activities found across ${found.pagesVisited} pages`);
 }finally{await context.close();ui.close()}
}
if(process.argv[1]&&/discover-cli\.(?:ts|js)$/.test(process.argv[1]))void runDiscover().catch(e=>{console.error(e);process.exitCode=1});
