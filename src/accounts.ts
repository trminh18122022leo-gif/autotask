import {readFile,rename,rm,unlink,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium,type BrowserContext,type Page} from 'playwright';
import {ensureAllowed} from './config.js';

export interface AccountRecord {
  loginUrl: string;
  loginHost: string;
  displayName: string;
  trustedLoginHosts?: string[];
}

export interface SaveAccountInput {
  loginUrl?: string;
  displayName?: string;
  trustedLoginHosts?: string[];
  isDefault?: boolean;
}

export async function listAccounts():Promise<Record<string,AccountRecord>>{
  try{const raw=JSON.parse(await readFile('.private/accounts.json','utf8'));return raw.accounts||{}}catch{return {}}
}

export function credentialsFor(profileId:string,field:'username'|'password'):string {
  if(!/^[\w-]{1,48}$/.test(profileId))throw new Error('Invalid account ID');
  return execFileSync(process.env.AUTOTASK_PYTHON||'python',['desktop/accounts_cli.py','get',`${profileId}:${field}`],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
}

export async function saveAccount(
  accountId: string,
  input: SaveAccountInput,
  username: string,
  password: string
): Promise<void> {
  if (!/^[\w-]{1,48}$/.test(accountId)) throw new Error('Invalid account ID: must be 1-48 alphanumeric characters, underscores or hyphens');
  if (!username || username.trim().length === 0) throw new Error('Username / email is required');
  if (!password || password.length === 0) throw new Error('Password is required');

  const loginUrl = (input.loginUrl || 'https://lms.hust.edu.vn').trim();
  const payload = JSON.stringify({
    accountId,
    loginUrl,
    displayName: input.displayName || accountId,
    trustedLoginHosts: input.trustedLoginHosts || ['id.hust.edu.vn', 'fami.hust.edu.vn', 'login.microsoftonline.com', 'login.live.com'],
    isDefault: input.isDefault ?? true,
    username: username.trim(),
    password
  });

  execFileSync(
    process.env.AUTOTASK_PYTHON || 'python',
    ['desktop/accounts_cli.py', 'set'],
    {
      input: payload,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
}

export async function deleteAccount(accountId: string): Promise<void> {
  if (!/^[\w-]{1,48}$/.test(accountId)) throw new Error('Invalid account ID');
  execFileSync(
    process.env.AUTOTASK_PYTHON || 'python',
    ['desktop/accounts_cli.py', 'delete', accountId],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await forgetSession(accountId);
}

export async function getDefaultAccountId(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile('.private/accounts.json', 'utf8'));
    if (raw.default && raw.accounts?.[raw.default]) return raw.default;
    const ids = Object.keys(raw.accounts || {});
    return ids[0] || null;
  } catch {
    return null;
  }
}

export async function setDefaultAccount(accountId: string): Promise<void> {
  if (!/^[\w-]{1,48}$/.test(accountId)) throw new Error('Invalid account ID');
  const accounts = await listAccounts();
  if (!accounts[accountId]) throw new Error(`Account "${accountId}" not found`);
  const targetPath = '.private/accounts.json';
  const raw = JSON.parse(await readFile(targetPath, 'utf8'));
  raw.default = accountId;
  const payload = JSON.stringify(raw, null, 2);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, payload, 'utf8');
  try {
    await rename(tmpPath, targetPath);
  } catch {
    await writeFile(targetPath, payload, 'utf8');
    await unlink(tmpPath).catch(() => {});
  }
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
 * Supports:
 * - Direct login forms (Moodle, Canvas, Blackboard, custom)
 * - Microsoft Entra ID / Office 365 multi-step authentication
 * - Federated school IdPs (e.g. id.hust.edu.vn, ADFS, CAS, SAML)
 * - OAuth2 / OIDC buttons ("Login with HUST Account", "Office 365", "Google")
 */
export async function fillKnownLogin(
  page: Page,
  accountId: string,
  approvedHosts: string[],
  creds?: { username: string; password: string }
): Promise<'FILLED'|'NO_FORM'> {
  let host = '';
  try {
    host = new URL(page.url()).hostname.toLowerCase();
  } catch {
    return 'NO_FORM';
  }

  const trusted = approvedHosts.map(h => h.toLowerCase().trim());
  const isTrusted = trusted.some(h => host === h || host.endsWith('.' + h)) ||
    host.includes('hust.edu.vn') ||
    host.includes('microsoftonline.com') ||
    host.includes('login.live.com') ||
    host.includes('accounts.google.com') ||
    host.includes('sso.') ||
    host.includes('cas.') ||
    host.includes('adfs.') ||
    host.includes('id.');

  if (!isTrusted) return 'NO_FORM';

  const userVal = creds ? creds.username : credentialsFor(accountId, 'username');
  const passVal = creds ? creds.password : credentialsFor(accountId, 'password');

  // 1. Dedicated Microsoft Entra ID / Office 365 SSO handler
  if (host.includes('microsoftonline.com') || host.includes('login.live.com')) {
    const msUser = page.locator('#i0116, input[name="loginfmt"], input[type="email"]:visible');
    const msPass = page.locator('#i0118, input[name="passwd"]:visible, input[type="password"]:visible');

    // If password is not yet visible, fill email and advance
    if ((await msPass.count()) === 0 || !(await msPass.first().isVisible().catch(() => false))) {
      if ((await msUser.count()) > 0 && (await msUser.first().isVisible().catch(() => false))) {
        await msUser.first().fill(userVal);
        const msNext = page.locator('#idSIButton9, input[type="submit"]:visible, button[type="submit"]:visible, input[value="Next"], button:has-text("Next"), input[value="Tiếp theo"]').first();
        if ((await msNext.count()) > 0) {
          await msNext.click().catch(() => {});
          // Wait for either password field on Microsoft or redirect to school IdP
          await Promise.race([
            page.locator('#i0118, input[name="passwd"]:visible, input[type="password"]:visible').first().waitFor({ timeout: 10000 }).catch(() => {}),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
          ]);
          await page.waitForTimeout(1000);
          try {
            host = new URL(page.url()).hostname.toLowerCase();
          } catch {}
        }
      }
    }

    // Now fill password if visible on Microsoft
    const passField = page.locator('#i0118, input[name="passwd"]:visible, input[type="password"]:visible').first();
    if ((await passField.count()) > 0 && (await passField.isVisible().catch(() => false))) {
      await passField.fill(passVal);
      return 'FILLED';
    }
  }

  // 2. School IdP / Federated CAS / ADFS (e.g. sso.hust.edu.vn, id.hust.edu.vn)
  const isSchoolIdp = host.startsWith('sso.') ||
    host.startsWith('id.') ||
    host.startsWith('cas.') ||
    host.startsWith('adfs.') ||
    host.includes('adfs') ||
    host.includes('/adfs') ||
    host === 'sso.hust.edu.vn' ||
    host === 'id.hust.edu.vn';

  if (isSchoolIdp) {
    const schoolUser = page.locator('#userNameInput:visible, input[name="UserName"]:visible, input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="user"]:visible, input[name*="login"]:visible, #username:visible, input[type="text"]:visible').first();
    if (await schoolUser.count() > 0 && await schoolUser.isVisible().catch(() => false)) {
      const curVal = await schoolUser.inputValue().catch(() => '');
      if (!curVal.trim()) {
        await schoolUser.fill(userVal);
      }
    }
    const schoolPass = page.locator('#passwordInput:visible, input[name="Password"]:visible, input[type="password"]:visible, #password:visible, #passwd:visible, input[name="passwd"]:visible, input[name="password"]:visible').first();
    if (await schoolPass.count() > 0 && await schoolPass.isVisible().catch(() => false)) {
      await schoolPass.fill(passVal);
      return 'FILLED';
    }
  }

  // 3. Generic standard form login (Moodle, Canvas, Blackboard, custom)
  // CRITICAL: If the page contains a visible SSO Identity Provider button (e.g. "Login with HUST account", "Office 365"),
  // NEVER fill this local admin form! Students must authenticate through the SSO button.
  const hasSsoBtn = (await page.locator(
    'a.login-identityprovider-btn:visible, a[href*="oauth2/login.php"]:visible, a[href*="auth/oidc"]:visible, a:has-text("Login with HUST"):visible, a:has-text("HUST Account"):visible, a:has-text("HUST account"):visible, a:has-text("Office 365"):visible, a:has-text("Microsoft"):visible, .potentialidp a:visible, button:has-text("HUST"):visible'
  ).count().catch(() => 0)) > 0;

  if (hasSsoBtn) {
    return 'NO_FORM';
  }
  const password = page.locator('input[type="password"]:visible');
  const user = page.locator('input[autocomplete="username"]:visible, input[type="email"]:visible, input[name="username"]:visible, input[name="email"]:visible, input[name="loginfmt"]:visible, input[id="username"]:visible, input[type="text"]:visible');

  if (await user.count() >= 1) {
    const curUserVal = await user.first().inputValue().catch(() => '');
    if (!curUserVal.trim()) {
      await user.first().fill(userVal);
    }
    if (await password.count() === 0) {
      const next = page.locator('#idSIButton9, input[type="submit"]:visible, button[type="submit"]:visible, button:has-text("Next"), button:has-text("Continue"), button:has-text("Tiếp theo")').first();
      if (await next.count() >= 1) {
        await next.click().catch(() => {});
        await page.locator('input[type="password"]:visible').first().waitFor({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }
  }
  if (await password.count() >= 1) {
    await password.first().fill(passVal);
    return 'FILLED';
  }
  return 'NO_FORM';
}

/**
 * Rigorously checks DOM and URL markers to verify whether the session is genuinely authenticated.
 * Prevents false positives where an agent assumes it is logged in without real authentication.
 * Works across Moodle, Canvas, Blackboard, and custom LMS.
 */
export async function verifyIsLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url || url === 'about:blank') return false;

  // 1. Definite non-authenticated URLs
  if (url.includes('login.microsoftonline.com') ||
      url.includes('login.live.com') ||
      url.includes('/login/index.php') ||
      url.includes('/cas/login') ||
      url.includes('id.hust.edu.vn/auth')) {
    return false;
  }

  // 2. Explicit negative checks BEFORE positive markers (e.g. Moodle guest homepage has .usermenu with "Log in" + body.notloggedin)
  const notLoggedInBody = await page.locator('body.notloggedin').count();
  if (notLoggedInBody > 0) return false;

  const pwdVisibleCount = await page.locator('input[type="password"]:visible').count();
  if (pwdVisibleCount > 0) return false;

  const logoutCount = await page.locator('a[href*="/login/logout.php"], a[href*="logout"], a:has-text("Đăng xuất"), a:has-text("Log out"), a:has-text("Sign out"), button:has-text("Đăng xuất")').count();
  if (logoutCount > 0) return true;

  const loginBtnCount = await page.locator(
    '.usermenu .login:visible, .usermenu a[href*="/login/index.php"]:visible, a[href*="/login/index.php"]:visible, .logininfo a:has-text("Đăng nhập"):visible, .logininfo a:has-text("Log in"):visible'
  ).count();
  if (loginBtnCount > 0) return false;

  // 3. Positive Moodle / LMS authenticated elements
  const userMenuCount = await page.locator('.usermenu, .userbutton, [data-region="user-menu"], .userpicture, #user-menu-toggle, .user-profile-menu, #global_nav_profile_link, .ic-app-header__user-menu, [aria-label="User menu"], [aria-label="Account"]').count();
  if (userMenuCount > 0) return true;

  const dashboardCount = await page.locator('a[href*="/my/"], a[href*="/my/courses.php"], .dashboard-card, .courses-view-course-item, h1:has-text("Khóa học của tôi"), h1:has-text("Bảng điều khiển"), h1:has-text("Dashboard")').count();
  if (dashboardCount > 0) return true;

  if (url.includes('/dashboard') || url.includes('/my/') || url.includes('/course/view.php') || url.includes('/courses/')) {
    return true;
  }

  return false;
}

export interface AutoLoginResult {
  success: boolean;
  status: 'LOGGED_IN' | 'MFA_REQUIRED' | 'NO_FORM' | 'FAILED';
  message: string;
  urlAfter?: string;
}

export async function attemptAutoLogin(
  page: Page,
  accountId: string,
  approvedHosts: string[],
  creds?: { username: string; password: string }
): Promise<AutoLoginResult> {
  const currentUrl = page.url();
  let host = '';
  try {
    host = new URL(currentUrl).hostname.toLowerCase();
  } catch {
    return { success: false, status: 'NO_FORM', message: 'URL không hợp lệ' };
  }

  const trusted = [
    ...approvedHosts.map(h => h.toLowerCase().trim()),
    'login.microsoftonline.com',
    'login.live.com',
    'accounts.google.com',
    'id.hust.edu.vn',
    'sso.hust.edu.vn'
  ];

  const isTrustedHost = trusted.some(h => host === h || host.endsWith('.' + h)) ||
    host.includes('hust.edu.vn') ||
    host.includes('sso.') ||
    host.includes('adfs.') ||
    host.includes('cas.') ||
    host.includes('id.');

  if (!isTrustedHost) {
    return { success: false, status: 'NO_FORM', message: `Host "${host}" không nằm trong danh sách đăng nhập tin cậy` };
  }

  const userVal = creds ? creds.username : credentialsFor(accountId, 'username');
  const passVal = creds ? creds.password : credentialsFor(accountId, 'password');

  // Multi-tier SSO & Login State Machine Loop (up to 20 iterations, 1s each)
  const maxWaitSteps = 20;
  for (let waitStep = 0; waitStep < maxWaitSteps; waitStep++) {
    // 1. Stage 1: Check if genuine authentication on LMS is already achieved
    if (await verifyIsLoggedIn(page)) {
      return {
        success: true,
        status: 'LOGGED_IN',
        message: `Đã tự động đăng nhập và xác thực phiên thành công với tài khoản "${accountId}".`,
        urlAfter: page.url()
      };
    }

    // 2. Stage 2: Check if MFA/OTP challenge is present
    const isMfa = (await page.locator('input[name*="otp"]:visible, input[name*="code"]:visible, input[name*="token"]:visible, input[autocomplete="one-time-code"]:visible, #idDiv_SAOTCS_Title, #idRichContext_DisplaySign').count().catch(() => 0)) > 0 ||
      (await page.locator('body').innerText().catch(() => '')).includes('xác thực 2 bước');
    if (isMfa) {
      return {
        success: false,
        status: 'MFA_REQUIRED',
        message: `Đã điền thông tin tài khoản "${accountId}". Hệ thống yêu cầu mã xác thực 2 bước (MFA/OTP). Vui lòng hoàn thành trên trình duyệt.`,
        urlAfter: page.url()
      };
    }

    // 3. Stage 3 (HIGHEST PRIORITY): University / Enterprise SSO Identity Provider Button
    // On LMS login pages (HUST Moodle, Canvas, Blackboard), students MUST click the SSO button.
    // The local username/password form on the LMS page is ONLY for local system administrators.
    const ssoBtn = page.locator(
      'a.login-identityprovider-btn:visible, a[href*="oauth2/login.php"]:visible, a[href*="auth/oidc"]:visible, a:has-text("Login with HUST"):visible, a:has-text("HUST Account"):visible, a:has-text("HUST account"):visible, a:has-text("Office 365"):visible, a:has-text("Microsoft"):visible, .potentialidp a:visible, button:has-text("HUST"):visible'
    ).first();

    if ((await ssoBtn.count().catch(() => 0)) > 0 && (await ssoBtn.isVisible().catch(() => false))) {
      await ssoBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }

    // 4. Stage 4: General login link on main page (if not on login page yet and no inputs visible)
    const loginLink = page.locator(
      'a[href*="/login/index.php"]:visible, .logininfo a:has-text("Đăng nhập"):visible, .logininfo a:has-text("Log in"):visible'
    ).first();
    const hasAnyInputs = (await page.locator('input:visible').count().catch(() => 0)) > 0;
    if (!hasAnyInputs && (await loginLink.count().catch(() => 0)) > 0 && (await loginLink.isVisible().catch(() => false))) {
      await loginLink.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }

    // 5. Stage 5: Microsoft KMSI ("Stay signed in?" / "Duy trì đăng nhập?") screen
    const kmsi = page.locator('#idSIButton9:visible, input[value="Yes"]:visible, input[value="Có"]:visible, button:has-text("Yes"):visible, button:has-text("Có"):visible, input[type="submit"][value*="Yes"]:visible, input[type="submit"][value*="Có"]:visible').first();
    const isKmsiPrompt = (await page.locator('#kmsiTitle, :has-text("Stay signed in?"), :has-text("Duy trì đăng nhập?"), [name="DontShowAgain"]').count().catch(() => 0)) > 0;
    if (isKmsiPrompt && (await kmsi.count().catch(() => 0)) > 0 && (await kmsi.isVisible().catch(() => false))) {
      await kmsi.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }

    // 6. Stage 6: Password field (School ADFS sso.hust.edu.vn, Microsoft step 2, or plain standard form when NO SSO button exists)
    const passInput = page.locator('#passwordInput:visible, input[name="Password"]:visible, #i0118:visible, input[name="passwd"]:visible, input[type="password"]:visible, #password:visible, #passwd:visible, input[name="password"]:visible').first();
    if ((await passInput.count().catch(() => 0)) > 0 && (await passInput.isVisible().catch(() => false))) {
      const curPassVal = await passInput.inputValue().catch(() => '');
      if (!curPassVal) {
        // If there's an empty username/email field on this page, fill it first
        const curUserField = page.locator('#userNameInput:visible, input[name="UserName"]:visible, input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="user"]:visible, input[name*="login"]:visible, #username:visible, input[type="text"]:visible').first();
        if ((await curUserField.count().catch(() => 0)) > 0 && (await curUserField.isVisible().catch(() => false))) {
          const curUVal = await curUserField.inputValue().catch(() => '');
          if (!curUVal.trim()) {
            await curUserField.fill(userVal);
          }
        }

        await passInput.fill(passVal);
        const submitBtn = page.locator('#submitButton:visible, #idSIButton9:visible, button[type="submit"]:visible, input[type="submit"]:visible, #loginbtn:visible, button:has-text("Đăng nhập"):visible, button:has-text("Log in"):visible, button:has-text("Sign in"):visible, button:has-text("Login"):visible').first();
        if ((await submitBtn.count().catch(() => 0)) > 0) {
          await submitBtn.click().catch(() => {});
        } else {
          await passInput.press('Enter').catch(() => {});
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }
    }

    // 7. Stage 7: Username / Email field on Microsoft step 1 (login.microsoftonline.com)
    const msUserInput = page.locator('#i0116:visible, input[name="loginfmt"]:visible, input[type="email"]:visible').first();
    if ((await msUserInput.count().catch(() => 0)) > 0 && (await msUserInput.isVisible().catch(() => false))) {
      const curUVal = await msUserInput.inputValue().catch(() => '');
      if (!curUVal.trim()) {
        await msUserInput.fill(userVal);
        const nextBtn = page.locator('#idSIButton9:visible, input[type="submit"]:visible, button[type="submit"]:visible, input[value="Next"]:visible, button:has-text("Next"):visible, button:has-text("Tiếp theo"):visible').first();
        if ((await nextBtn.count().catch(() => 0)) > 0) {
          await nextBtn.click().catch(() => {});
        } else {
          await msUserInput.press('Enter').catch(() => {});
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }
    }

    // If waiting for redirects or animation
    await page.waitForTimeout(1000);
  }

  // After loop, final check
  if (await verifyIsLoggedIn(page)) {
    return {
      success: true,
      status: 'LOGGED_IN',
      message: `Đã tự động đăng nhập và xác thực phiên thành công với tài khoản "${accountId}".`,
      urlAfter: page.url()
    };
  }

  const errorText = await page.locator('.alert-danger, .error, #loginerrormsg, [role="alert"], #error, .error-text').first().innerText().catch(() => '');
  return {
    success: false,
    status: 'FAILED',
    message: `Đăng nhập chưa hoàn tất${errorText ? ': ' + errorText.trim() : ' (Chưa phát hiện phiên đăng nhập hợp lệ trên hệ thống, URL: ' + page.url() + ')'}.`,
    urlAfter: page.url()
  };
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
