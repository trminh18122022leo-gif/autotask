import {readFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium,type BrowserContext,type Page} from 'playwright';
import {ensureAllowed} from './config.js';
export interface AccountRecord {loginUrl:string;loginHost:string;displayName:string;trustedLoginHosts?:string[]}
export async function listAccounts():Promise<Record<string,AccountRecord>>{
 try{const raw=JSON.parse(await readFile('.private/accounts.json','utf8'));return raw.accounts||{}}catch{return {}}
}
export function credentialsFor(profileId:string,field:'username'|'password'):string {
 if(!/^[\w-]{1,48}$/.test(profileId))throw new Error('Invalid account ID');
 return execFileSync(process.env.AUTOTASK_PYTHON||'python',['desktop/accounts_cli.py','get',`${profileId}:${field}`],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
}
export async function accountContext(accountId:string,account:AccountRecord,options?:{serviceWorkers?:'allow'|'block'}):Promise<BrowserContext>{
 const dir=resolve('.private','sessions',accountId);
 return chromium.launchPersistentContext(dir,{headless:false,acceptDownloads:true,viewport:{width:1280,height:900},serviceWorkers:options?.serviceWorkers});
}
export async function forgetSession(accountId:string):Promise<void>{
 if(!/^[\w-]{1,48}$/.test(accountId))throw new Error('Invalid ID');
 await rm(resolve('.private','sessions',accountId),{recursive:true,force:true});
}
/** Inject saved credentials only into visible fields on explicitly trusted authentication hosts.
 * SSO/MFA/CAPTCHA are never bypassed. No password is typed into unrelated host pages.
 */
export async function fillKnownLogin(page:Page,accountId:string,approvedHosts:string[]):Promise<'FILLED'|'NO_FORM'> {
 const host=new URL(page.url()).hostname.toLowerCase();
 if(!approvedHosts.includes(host))return 'NO_FORM';
 const password=page.locator('input[type="password"]:visible');
 const user=page.locator('input[autocomplete="username"]:visible, input[type="email"]:visible, input[name="username"]:visible, input[name="email"]:visible, input[name="loginfmt"]:visible');
 if(await user.count()===1){
  await user.fill(credentialsFor(accountId,'username'));
  if(await password.count()===0){
   const next=page.getByRole('button',{name:/^(Next|Continue|Tiếp theo)$/i});
   if(await next.count()===1){await next.click();await page.waitForTimeout(500);}
  }
 }
 if(await password.count()===1){await password.fill(credentialsFor(accountId,'password'));return 'FILLED'}
 return 'NO_FORM';
}
export async function loginForContext(context:BrowserContext,accountId:string,record:AccountRecord,confirm:(q:string)=>Promise<string>):Promise<void>{
 const page=await context.newPage();
 const trusted=[record.loginHost,...(record.trustedLoginHosts||[])].map(x=>x.toLowerCase());
 try{
  ensureAllowed(record.loginUrl,[record.loginHost]);
  await page.goto(record.loginUrl,{waitUntil:'domcontentloaded',timeout:45000});
  let result=await fillKnownLogin(page,accountId,trusted);
  if(result==='NO_FORM'){
   const login=page.getByRole('link',{name:/^(Sign in|Log in|Đăng nhập|Microsoft|Google)$/i});
   if(await login.count()===1){
    await login.click();await page.waitForLoadState('domcontentloaded').catch(()=>{});
    result=await fillKnownLogin(page,accountId,trusted);
   }
  }
  if(result==='FILLED'){
   const submit=page.locator('button[type="submit"]:visible,input[type="submit"]:visible');
   const named=page.getByRole('button',{name:/^(Sign in|Log in|Đăng nhập|Continue)$/i});
   const target=await submit.count()===1?submit:await named.count()===1?named:null;
   if(target)await target.click();
  }
  await page.waitForTimeout(850);
  const currentHost=new URL(page.url()).hostname.toLowerCase();
  const pwd=page.locator('input[type="password"]:visible');
  if(trusted.includes(currentHost)&&await pwd.count()===0 && result==='NO_FORM')return;
  await confirm('Check login/MFA/SSO in browser; press Enter when the account is authenticated: ');
 }finally{await page.close()}
}
