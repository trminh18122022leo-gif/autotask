import { chromium, type BrowserContext, type Page } from 'playwright';
const contextBlockHandlers = new WeakMap<BrowserContext, ((route: any) => Promise<void>) | null>();
const contextActiveReadOnlyTasks = new WeakMap<BrowserContext, number>();
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccounts, accountContext, loginForContext, forgetSession } from './accounts.js';
import { discoverActivities, toTask } from './discovery.js';
import { loadTheme } from './ui/themes.js';
import { hasUnvisitedPages, readyForReview } from './workflow-guards.js';
import { loadConfig, ensureAllowed, isApprovedSsoOrigin, originTrustFromConfig } from './config.js';
import { browserSetupInteractive } from './setup.js';
import { scanQuestions, scanUnsupported } from './scanner.js';
import { readSurfaces, readableFrames, locateNext, revealStart, revealContinue, hasQuestions } from './interaction.js';
import { classifyActivityScope, inspectQuizLaunchSurface, evaluateQuizStartPolicy, evaluateAttemptExecutionGate, extractQuizActivityIdentity } from './quiz-start-policy.js';
import { resolveEffectiveOperationMode, isStateMutatingActionUrl, isMutatingHttpMethod } from './operation-mode.js';
import { detectPlatform, isLoginChallenge } from './platforms.js';
import { observeAccess, mostRestrictive, watchUntilAccessible } from './access-gates.js';
import { loadNotes, notesFor, type NoteVault } from './ai-notes.js';
import { observeScore } from './observations.js';
import { solveQuestions } from './ai.js';
import { loadAnswerBanks } from './answer-bank.js';
import { partitionByAnswerSource, resolveAnswerSourceMode } from './answer-routing.js';
import { fillAnswer } from './fill.js';
import {prepareAdvancedPracticeQuestions,practiceAttachmentAnswer} from './lms/advanced-adapters.js';
import { scanDeadlines } from './calendar.js';
import { printSummary, saveReport } from './report.js';
import {
  resilientGoto,
  checkDuplicateRisk,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint
} from './task-manager.js';
import { ResumeCoordinator } from './browser/resume-coordinator.js';
import { executeVerifiedNavigation, isAuthRequired } from './browser/verified-navigation.js';
import { redactSecrets } from './security/redact.js';
import type { TaskCheckpoint } from './task-manager.js';
import type { AppConfig, Deadline, Task, TaskResult } from './types.js';
import { header, section, entry, info, success, warn, fail, close, renderBreadcrumb, renderErrorCard } from './ui/tokyo.js';

let cliInstance: ReadlineInterface | undefined;
function getCli(): ReadlineInterface {
  if (!cliInstance) cliInstance = createInterface({ input: stdin, output: stdout });
  return cliInstance;
}
let context:BrowserContext|undefined;
let results:TaskResult[]=[];
let deadlines:Deadline[]=[];
let noteVault:NoteVault={global:'',byHost:{},byTask:{}};

/** Pauses on CAPTCHA/OTP. Never tries to read/solve challenges using AI or evade login.
 * User may solve in the visible browser (Enter) or type the manually obtained code
 * when the task has an explicitly configured, unique challenge input selector.
 */
let authPromptQueue:Promise<unknown>=Promise.resolve();
async function resumeAfterManualChallenge(page:Page,task:Task,config:AppConfig):Promise<boolean>{
 if(!config.interactiveAuthRecovery)return false;
 const work=async():Promise<boolean>=>{
 info(`[CHỜ XÁC THỰC] ${task.id}: CAPTCHA/OTP/SSO xuất hiện tại trang ${redactSecrets(page.url())}`);
 info('Bạn lấy mã CAPTCHA từ ảnh/ô thử thách ngay trên trang Chromium đang mở; OTP lấy từ ứng dụng/kênh xác thực của chính bạn. Không gửi mã cho AI.');
 const label=task.challengeInputSelector?'Nhập mã nhìn thấy (hoặc Enter nếu đã tự xác thực trong trình duyệt, SKIP để dừng): ':'Tự xác thực trong trình duyệt, sau đó nhấn Enter để tiếp tục; SKIP để dừng: ';
 const entered=(await getCli().question(label)).trim();
 if(entered.toUpperCase()==='SKIP')return false;
 if(entered && task.challengeInputSelector){
  const input=page.locator(task.challengeInputSelector);
  if(await input.count()!==1)throw new Error('Challenge input is not unique; manual browser action required');
  await input.fill(entered);
  if(task.challengeVerifySelector){
   const verify=page.locator(task.challengeVerifySelector);
   if(await verify.count()!==1)throw new Error('Challenge verify action is not unique');
   const label=(await verify.innerText().catch(()=>''))+' '+(await verify.getAttribute('value').catch(() => '')||'');
   if(/submit all|finish attempt|nộp bài|turn in|submit assignment/i.test(label))throw new Error('Challenge verify selector is a final submission button');
   await verify.click();
  }
 }
 await page.waitForLoadState('domcontentloaded',{timeout:12000}).catch(()=>{});
 const body=await page.evaluate(()=>(document.body?.innerText||'').slice(0,5000)).catch(()=>'');
 return !(await isAuthRequired(page))&&!isLoginChallenge(body);
 };
 const job=authPromptQueue.then(work,work);
 authPromptQueue=job.then(()=>undefined,()=>undefined);
 return job;
}


export async function executeTask(
  browserContext: BrowserContext,
  task: Task,
  config: AppConfig,
  activeNoteVault: NoteVault = { global: '', byHost: {}, byTask: {} },
  deadlinesCollector: Deadline[] = []
): Promise<TaskResult> {
 const result:TaskResult={id:task.id,url:task.url,title:task.title||task.id,status:'ERROR',startedAt:new Date().toISOString(),questionsFound:0,questionsFilled:0,warnings:[],scoreObserved:null};
 const answerSourceMode=resolveAnswerSourceMode(config,task);
 // AI_PRIMARY is the default. A saved file path never silently overrides the AI solver.
 // Only load optional form data when the user explicitly chooses FORM_FILE.
 const filePaths=answerSourceMode==='FORM_FILE' ? [...(config.answerFilePaths||[]),...(task.answerFilePaths||[])] : [];
 if (answerSourceMode==='FORM_FILE' && !filePaths.length) {
   result.warnings.push('[FORM_FILE] Chưa chọn tệp dữ liệu form; AI sẽ xử lý các trường được hỗ trợ.');
 }
 let answerBank: Awaited<ReturnType<typeof loadAnswerBanks>> = {rows:[],warnings:[],sources:[]};
 if (filePaths.length) {
   try { answerBank=await loadAnswerBanks(filePaths); }
   catch(e) {
     result.status='NEEDS_REVIEW';
     result.warnings.push(`[FORM_FILE_ERROR] ${e instanceof Error ? e.message : String(e)}. Fix the optional form data file before this task runs.`);
     return result;
   }
 }

 const page=await browserContext.newPage();
 result.page=page;
  const effectiveMode = resolveEffectiveOperationMode(config, task);
  if (effectiveMode !== 'READ_ONLY') {
    const activeRO = contextActiveReadOnlyTasks.get(browserContext) || 0;
    if (activeRO === 0) {
      const prevHandler = contextBlockHandlers.get(browserContext);
      if (prevHandler) {
        await browserContext.unroute('**/*', prevHandler).catch(() => {});
        contextBlockHandlers.delete(browserContext);
      }
    }
  } else {
    const activeRO = (contextActiveReadOnlyTasks.get(browserContext) || 0) + 1;
    contextActiveReadOnlyTasks.set(browserContext, activeRO);
  }
  let contextBlockHandler: ((route: any) => Promise<void>) | null = null;
  let popupListener: ((popup: any) => void) | null = null;
  try {
   const originOpts = originTrustFromConfig(config);
   ensureAllowed(task.url, config.allowedHosts, originOpts);
   // Pilot-Gate Phase 5: refuse action/mutation endpoints BEFORE any network request is issued (all modes).
   if (isStateMutatingActionUrl(task.url)) {
    result.status = 'NEEDS_REVIEW';
    result.warnings.push(`${effectiveMode === 'READ_ONLY' ? '[READ_ONLY] ' : ''}Chặn điều hướng tới URL có thể thay đổi trạng thái (tạo lượt làm bài/lưu nháp/nộp/đăng xuất/ghi danh): ${redactSecrets(task.url)}; không gửi request nào`);
    return result;
   }
   if (effectiveMode === 'READ_ONLY') {
      result.readOnlyBlockedRequests = [];
      contextBlockHandler = async (route: any) => {
        const req = route.request();
        const method = req.method().toUpperCase();
        const reqUrl = req.url();
        if (isMutatingHttpMethod(method) || isStateMutatingActionUrl(reqUrl)) {
          result.readOnlyBlockedRequests!.push(method + ' ' + redactSecrets(reqUrl));
          warn('[READ_ONLY_BLOCK] Bat chan yeu cau ghi: ' + method + ' ' + redactSecrets(reqUrl));
          return route.abort('blockedbyclient');
        }
        if (req.isNavigationRequest()) {
          try {
            const response = await route.fetch({ maxRedirects: 0 });
            const status = response.status();
            if (status >= 300 && status < 400) {
              const loc = response.headers()['location'];
              if (loc) {
                const absLoc = new URL(loc, reqUrl).toString();
                if (isStateMutatingActionUrl(absLoc)) {
                  result.readOnlyBlockedRequests!.push('REDIRECT ' + absLoc);
                  warn('[READ_ONLY_BLOCK] Bat chan chuyen huong toi URL hanh vi: ' + redactSecrets(absLoc));
                  return route.abort('blockedbyclient');
                }
              }
            }
            return route.fulfill({ response });
          } catch {
            return route.abort('blockedbyclient');
          }
        }
        return route.continue();
      };
      contextBlockHandlers.set(browserContext, contextBlockHandler);
      await browserContext.route('**/*', contextBlockHandler);
      await page.route('**/*', contextBlockHandler);
      popupListener = (popup: any) => {
        if (contextBlockHandler) {
          popup.route('**/*', contextBlockHandler).catch(() => {});
        }
      };
      browserContext.on('page', popupListener);
      await page.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'serviceWorker', {
            get: () => undefined,
            configurable: false
          });
        } catch {}
      }).catch(() => {});
      await page.evaluate(() => {
        if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then(regs => {
            for (const r of regs) r.unregister();
          }).catch(() => {});
        }
      }).catch(() => {});
    }
   const dup=await checkDuplicateRisk(task.id,task.url);
  if(dup.isDuplicateRisk && !task.allowResubmit && !config.forceResubmit){
   warn(`  [CHẶN TRÙNG LẶP] ${dup.message}`);
   result.status='NEEDS_REVIEW';
   result.warnings.push(`ĐÃ CHẶN: ${dup.message}. Cần task.allowResubmit=true để thực hiện lại.`);
   return result;
  }
  const existingCheckpoint = await loadCheckpoint(task.id);
  const recordedAnswers: Record<string, any> = {};
  const answersByStep: Record<number, Record<string, any>> = {};
  if (existingCheckpoint?.answersRecorded) {
    Object.assign(recordedAnswers, existingCheckpoint.answersRecorded);
  }
  if (existingCheckpoint?.answersByStep) {
    Object.assign(answersByStep, existingCheckpoint.answersByStep);
  }
  let startingPageIndex = 0;
  let policyCleared = false;
  if (existingCheckpoint) {
    info(`  [Checkpoint] Phát hiện checkpoint cho ${task.id} (Bước: ${existingCheckpoint.stepsCompleted}/${existingCheckpoint.totalSteps || '?'})`);
  }
   try {
    await resilientGoto(page, task.url);
   } catch (gotoErr) {
    if (result.readOnlyBlockedRequests?.length) {
     result.status = 'NEEDS_REVIEW';
     result.warnings.push(`[READ_ONLY] Điều hướng bị chặn vì dẫn tới request thay đổi trạng thái: ${result.readOnlyBlockedRequests.join(', ')}`);
     return result;
    }
    throw gotoErr;
   }
  try {
    ensureAllowed(page.url(), config.allowedHosts, originOpts);
  } catch (redirectErr) {
    const redirectBody = await page.evaluate(() => (document.body?.innerText || '').slice(0, 12000)).catch(() => '');
    if (isApprovedSsoOrigin(page.url(), config) && ((await isAuthRequired(page)) || isLoginChallenge(redirectBody))) {
      result.status = 'WAITING_FOR_AUTH';
      result.warnings.push(`Trang chuyển hướng tới cổng xác thực SSO được phê duyệt (${new URL(page.url()).origin}); vui lòng đăng nhập thủ công`);
      return result;
    }
    result.status = 'NEEDS_REVIEW';
    result.warnings.push(
      `Chặn chuyển hướng tới origin ngoài danh sách cho phép (${page.url()}): ${redirectErr instanceof Error ? redirectErr.message : String(redirectErr)}`
    );
    return result;
  }
  result.title = (await page.title().catch(() => '')) || task.title || task.id;
  const existingGrade = await observeScore(page);
  if (existingGrade) result.scoreObserved = existingGrade.text;
  const detectedPlatform = await detectPlatform(page, config.allowedHosts, config.moodleHosts);
  info(`  Platform detected: ${detectedPlatform} / ${task.id}`);
  const currentDeadlines = await scanDeadlines(page, config.deadlineOffset || '+07:00');
  if (currentDeadlines[0]) result.deadline = currentDeadlines[0].dueAt;
  deadlinesCollector.push(...currentDeadlines);

  const authRequired=await isAuthRequired(page);
  const initialBody = await page.evaluate(() => (document.body?.innerText || '').slice(0, 12000)).catch(() => '');
  if (authRequired || isLoginChallenge(initialBody)) {
    const recovered=await resumeAfterManualChallenge(page,task,config);
    if(!recovered){
      result.status='WAITING_FOR_AUTH';
      result.warnings.push('Cần người dùng tự lấy và xác thực CAPTCHA/OTP/SSO; sau khi hoàn tất có thể khôi phục tác vụ');
      return result;
    }
    try { ensureAllowed(page.url(),config.allowedHosts,originOpts); }
    catch {result.status='NEEDS_REVIEW';result.warnings.push('Origin after authentication is outside the approved LMS scope');return result;}
  }

  if (effectiveMode === 'READ_ONLY') {
    const roGates = await observeAccess(page);
    const roWaiting = mostRestrictive(roGates);
    if (roWaiting) {
      result.accessGate = { kind: roWaiting.kind, reason: roWaiting.reason, remainingSeconds: roWaiting.remainingSeconds, recheckAfter: roWaiting.recheckAfter };
    }
    for (const frame of readableFrames(page, config.allowedHosts, originOpts)) {
      result.questionsFound += (await scanQuestions(frame)).length;
    }
    // Give background scripts a short window to attempt writes so an impure page is never reported as purely read.
    await page.waitForTimeout(400);
    result.status = 'NEEDS_REVIEW';
    result.warnings.push('[READ_ONLY] Chế độ chỉ đọc: chỉ quan sát metadata/hạn nộp/điểm số, không mở lượt làm bài và không điền biểu mẫu');
    return result;
  }

  const headingContext = await page
    .evaluate(() => Array.from(document.querySelectorAll('h1, h2, .page-header-headings')).map(e => (e.textContent || '').trim()).join(' '))
    .catch(() => '');
  const liveHeaderScope = classifyActivityScope(`${task.title || ''} ${result.title} ${headingContext}`);
  if (effectiveMode === 'ASSESSMENT_RESTRICTED' || liveHeaderScope.scope === 'ASSESSMENT_RESTRICTED') {
    result.status = 'NEEDS_REVIEW';
    result.warnings.push(
      `[ASSESSMENT_RESTRICTED] Đã chặn tự động thao tác trên bài kiểm tra/thi tính điểm (${liveHeaderScope.evidence})`
    );
    return result;
  }

  if (existingCheckpoint) {
    // If task.url is an overview/launch page (e.g. Moodle /mod/quiz/view.php) with no questions directly visible,
    // navigate to the saved attempt step URL (same allowed origin) or continue the existing attempt without starting a new one.
    if (!await hasQuestions(page, config.allowedHosts, originOpts) && !mostRestrictive(await observeAccess(page))) {
      if (existingCheckpoint.currentStepUrl && existingCheckpoint.currentStepUrl !== page.url()) {
        try {
          const stepUrl = ensureAllowed(existingCheckpoint.currentStepUrl, config.allowedHosts, originOpts);
          const taskOrigin = ensureAllowed(task.url, config.allowedHosts, originOpts).origin.toLowerCase();
          if (stepUrl.origin.toLowerCase() === taskOrigin) {
            await resilientGoto(page, existingCheckpoint.currentStepUrl);
          }
        } catch {}
        try {
          ensureAllowed(page.url(), config.allowedHosts, originOpts);
        } catch (stepRedirectErr) {
          if (isApprovedSsoOrigin(page.url(), config) && (await isAuthRequired(page))) {
            result.status = 'WAITING_FOR_AUTH';
            result.warnings.push(`Phiên đăng nhập hết hạn khi khôi phục checkpoint; chuyển tới SSO (${new URL(page.url()).origin})`);
            return result;
          }
          result.status = 'NEEDS_REVIEW';
          result.warnings.push(
            `Chuyển hướng ngoài origin cho phép khi khôi phục checkpoint: ${stepRedirectErr instanceof Error ? stepRedirectErr.message : String(stepRedirectErr)}`
          );
          return result;
        }
        if (await isAuthRequired(page)) {
          result.status = 'WAITING_FOR_AUTH';
          result.warnings.push('Phiên làm việc đã hết hạn khi khôi phục checkpoint; vui lòng đăng nhập lại');
          return result;
        }
      }
      if (!await hasQuestions(page, config.allowedHosts, originOpts)) {
        const resumeLaunch = await inspectQuizLaunchSurface(page, config.allowedHosts, task.title, originOpts);
        if (resumeLaunch.scope === 'ASSESSMENT_RESTRICTED') {
          result.status = 'NEEDS_REVIEW';
          result.warnings.push(`[ASSESSMENT_RESTRICTED] Dừng khôi phục trên bài kiểm tra tính điểm: ${resumeLaunch.scopeEvidence}`);
          return result;
        }
        if (resumeLaunch.hasContinueAttemptControl) {
          if (effectiveMode !== 'PRACTICE_ASSISTED' || resumeLaunch.scope !== 'PRACTICE_VERIFIED') {
            result.status = 'NEEDS_REVIEW';
            result.warnings.push(
              `Dừng khôi phục: tiếp tục lượt đang mở cần mode=\"PRACTICE_ASSISTED\" tường minh và phạm vi tự luyện đã xác minh (mode hiệu lực: ${effectiveMode ?? 'chưa đặt'}; phạm vi: ${resumeLaunch.scope} — ${resumeLaunch.scopeEvidence}); không tạo lượt mới thay thế`
            );
            return result;
          }
          await revealContinue(page, config.allowedHosts, originOpts);
          ensureAllowed(page.url(), config.allowedHosts, originOpts);
          policyCleared = true;
        } else if (resumeLaunch.hasNewAttemptControl || resumeLaunch.hasStartAttemptForm || resumeLaunch.exhaustedAttempts) {
          result.status = 'NEEDS_REVIEW';
          result.warnings.push(
            'Checkpoint phát hiện lượt làm bài trước không còn mở trên server (chỉ thấy nút tạo lượt mới hoặc đã hết lượt); dừng NEEDS_REVIEW để chống tạo lượt làm bài trùng lặp'
          );
          return result;
        }
      }
    }
    const resumeEval = await ResumeCoordinator.evaluateState(page, existingCheckpoint, config);
    if (resumeEval.state === 'WAITING_FOR_AUTH') {
      warn(`  [ResumeCoordinator] ${resumeEval.reason}`);
      result.status = 'WAITING_FOR_AUTH';
      result.warnings.push(resumeEval.reason);
      return result;
    }
    if (resumeEval.state === 'WAITING_FOR_ACCESS') {
      warn(`  [ResumeCoordinator] ${resumeEval.reason}`);
      result.status = 'WAITING_FOR_ACCESS';
      if (resumeEval.accessGate) {
        result.accessGate = { kind: resumeEval.accessGate.kind, reason: resumeEval.accessGate.reason, remainingSeconds: resumeEval.accessGate.remainingSeconds, recheckAfter: resumeEval.accessGate.recheckAfter };
      }
      result.warnings.push(resumeEval.reason);
      return result;
    }
    if (resumeEval.state === 'NEEDS_REVIEW' || resumeEval.state === 'COMPLETED_VERIFIED') {
      info(`  [ResumeCoordinator] ${resumeEval.reason}`);
      result.status = 'NEEDS_REVIEW';
      result.warnings.push(`Checkpoint: ${resumeEval.reason}`);
      return result;
    }
    if (resumeEval.state === 'STATE_MISMATCH') {
      warn(`  [ResumeCoordinator] Không thể khôi phục: ${resumeEval.reason}`);
      result.warnings.push(`Checkpoint: ${resumeEval.reason}`);
      result.status = 'NEEDS_REVIEW';
      return result;
    }
    if (resumeEval.state === 'NAVIGATION_REQUIRED') {
      info(`  [ResumeCoordinator] Tự động chuyển tiếp từ bước ${resumeEval.currentStep} đến bước ${resumeEval.targetStep}`);
      const advanced = await ResumeCoordinator.advanceToStep(page, existingCheckpoint, resumeEval.targetStep, config, task.nextButton);
      if (!advanced) {
        warn(`  [ResumeCoordinator] Chuyển tiếp bước không thành công`);
        result.status = 'NEEDS_REVIEW';
        result.warnings.push(`Không thể chuyển tiếp an toàn đến bước ${resumeEval.targetStep}`);
        return result;
      }
      startingPageIndex = resumeEval.targetStep - 1;
    } else if (resumeEval.state === 'RESUME_READY') {
      info(`  [ResumeCoordinator] ${resumeEval.reason}`);
      startingPageIndex = Math.max(0, resumeEval.currentStep - 1);
    }
    if (startingPageIndex > 0) {
      result.questionsFound = existingCheckpoint.questionsFound || 0;
      result.questionsFilled = existingCheckpoint.questionsFilled || 0;
    }
  } else {
    if (!await hasQuestions(page, config.allowedHosts, originOpts) &&
        /no more attempts are allowed|không còn lượt làm bài|bạn đã hoàn thành bài kiểm tra|your response has been recorded|câu trả lời của bạn đã được ghi nhận/i.test(initialBody)) {
      result.status = 'NEEDS_REVIEW';
      result.warnings.push('Hoạt động đã hoàn thành hoặc không còn lượt làm bài mới; chỉ ghi nhận kết quả, không tự động thực thi lại');
      return result;
    }
  }
  const visited = new Set<string>();
  let complete = true;
  let gateCleared = false;
  let scopeVerifiedRecord: TaskCheckpoint['scopeVerified'] = existingCheckpoint?.scopeVerified;
  let anySupported = false;
  let hasUnsupportedOrHumanOnly = false;
  let serverSavedSteps = existingCheckpoint?.serverSavedSteps ?? startingPageIndex;
  for (let pageIndex = startingPageIndex; pageIndex < (task.maxPages || 1); pageIndex++) {
    try {
      ensureAllowed(page.url(), config.allowedHosts, originOpts);
    } catch (loopOriginErr) {
      if (isApprovedSsoOrigin(page.url(), config) && (await isAuthRequired(page))) {
        result.status = 'WAITING_FOR_AUTH';
        result.warnings.push(`Chuyển hướng tới SSO được phê duyệt (${new URL(page.url()).origin})`);
      } else {
        result.status = 'NEEDS_REVIEW';
        result.warnings.push(
          `Origin không được phê duyệt (${page.url()}): ${loopOriginErr instanceof Error ? loopOriginErr.message : String(loopOriginErr)}`
        );
      }
      complete = false;
      break;
    }
    if (await isAuthRequired(page)) {
      result.status = 'WAITING_FOR_AUTH';
      result.warnings.push('Trang yêu cầu đăng nhập / xác thực tài khoản');
      complete = false;
      break;
    }
    const gates = await observeAccess(page);
    for (const g of gates.filter(g => !g.blocked)) result.warnings.push(`${g.kind}: ${g.reason}`);
    let waiting = mostRestrictive(gates);
    if (waiting && (config.accessWatchMinutes || 0) > 0) {
      info(`${task.id}: ${waiting.kind} — monitoring availability, no gate bypass or synthetic reading`);
      const observed = await watchUntilAccessible(() => observeAccess(page), config.accessWatchMinutes || 0);
      waiting = observed.ready ? undefined : observed.gate;
    }
    if (waiting) {
      result.status = 'WAITING_FOR_ACCESS';
      result.accessGate = { kind: waiting.kind, reason: waiting.reason, remainingSeconds: waiting.remainingSeconds, recheckAfter: waiting.recheckAfter };
      result.warnings.push(waiting.reason);
      await saveCheckpoint({
        taskId: task.id,
        url: task.url,
        currentStepUrl: page.url(),
        status: 'WAITING_FOR_ACCESS',
        stepsCompleted: pageIndex,
        totalSteps: task.maxPages || 1,
        questionsFound: result.questionsFound,
        questionsFilled: result.questionsFilled,
        answersRecorded: recordedAnswers,
        answersByStep: answersByStep,
        ...(scopeVerifiedRecord ? { scopeVerified: scopeVerifiedRecord } : {}),
        lastUpdated: new Date().toISOString()
      });
      break;
    }
    if (!existingCheckpoint && pageIndex === 0 && !await hasQuestions(page, config.allowedHosts, originOpts)) {
      const launchInspection = await inspectQuizLaunchSurface(page, config.allowedHosts, task.title, originOpts);
      const startDecision = await evaluateQuizStartPolicy({
        page,
        task,
        config,
        platform: detectedPlatform,
        inspection: launchInspection
      });
      if (startDecision.action === 'HALT_NEEDS_REVIEW') {
        result.status = 'NEEDS_REVIEW';
        result.warnings.push(startDecision.reason);
        complete = false;
        break;
      }
      let launched = false;
      if (startDecision.action === 'CONTINUE_EXISTING_ATTEMPT') {
        launched = await revealContinue(page, config.allowedHosts, originOpts);
      } else if (startDecision.action === 'START_NEW_ATTEMPT') {
        launched = await revealStart(page, config.allowedHosts, { ...originOpts, allowNewAttempt: true });
      }
      if (launched) {
        policyCleared = true;
        try {
          ensureAllowed(page.url(), config.allowedHosts, originOpts);
        } catch (afterLaunchErr) {
          if (isApprovedSsoOrigin(page.url(), config) && (await isAuthRequired(page))) {
            result.status = 'WAITING_FOR_AUTH';
            result.warnings.push(`Yêu cầu xác thực SSO sau khi mở hoạt động (${new URL(page.url()).origin})`);
          } else {
            result.status = 'NEEDS_REVIEW';
            result.warnings.push(
              `Origin không hợp lệ sau khi mở hoạt động: ${afterLaunchErr instanceof Error ? afterLaunchErr.message : String(afterLaunchErr)}`
            );
          }
          complete = false;
          break;
        }
        if (await isAuthRequired(page)) {
          result.status = 'WAITING_FOR_AUTH';
          result.warnings.push('Trang yêu cầu đăng nhập sau khi mở hoạt động');
          complete = false;
          break;
        }
        const gateAfterStart = mostRestrictive(await observeAccess(page));
        if (gateAfterStart) {
          result.status = 'WAITING_FOR_ACCESS';
          result.accessGate = { kind: gateAfterStart.kind, reason: gateAfterStart.reason, remainingSeconds: gateAfterStart.remainingSeconds, recheckAfter: gateAfterStart.recheckAfter };
          result.warnings.push(gateAfterStart.reason);
          break;
        }
      }
    }
    // Unified pre-solve gate: direct attempt URLs, checkpoint resume, Task Queue retries and page transitions all revalidate here.
    if (await hasQuestions(page, config.allowedHosts, originOpts)) {
      const gate = await evaluateAttemptExecutionGate({
        page,
        task,
        config,
        platform: detectedPlatform,
        checkpoint: existingCheckpoint,
        policyCleared
      });
      if (!gate.allowed) {
        result.status = 'NEEDS_REVIEW';
        result.warnings.push(`[ATTEMPT_GATE:${gate.code}] ${gate.reason}`);
        complete = false;
        break;
      }
      gateCleared = true;
      if (detectedPlatform === 'moodle' && effectiveMode === 'PRACTICE_ASSISTED') {
        const idInfo = extractQuizActivityIdentity(page.url());
        scopeVerifiedRecord = {
          scope: 'PRACTICE_VERIFIED',
          mode: 'PRACTICE_ASSISTED',
          origin: new URL(page.url()).origin,
          verifiedAt: new Date().toISOString(),
          taskId: task.id,
          cmid: idInfo.cmid || (scopeVerifiedRecord as any)?.cmid,
          quizId: idInfo.quizId || (scopeVerifiedRecord as any)?.quizId,
          attemptId: idInfo.attemptId || (scopeVerifiedRecord as any)?.attemptId,
          source: 'ATTEMPT_PAGE_VERIFIED'
        };
      }
    }
    const surfaces = await readSurfaces(page, config.allowedHosts, originOpts);
    let pageQuestions = 0;
    for (const { frame, url } of surfaces) {
      const framePlatform = await detectPlatform(frame, config.allowedHosts, config.moodleHosts);
      const unsupported = await scanUnsupported(frame);
      const pendingUnsupported=unsupported.filter(note=> !(task.advancedLmsAdapters?.dragdrop && note.startsWith('Drag-and-drop interaction detected')));
      if (pendingUnsupported.length) {
        hasUnsupportedOrHumanOnly = true;
        complete = false;
        result.warnings.push(...pendingUnsupported.map(x => `${framePlatform}: ${x}`));
      }
      const questions = await prepareAdvancedPracticeQuestions(frame,await scanQuestions(frame),task);
      if (!questions.length) continue;
      pageQuestions += questions.length;
      const actionable = questions.filter(q => q.kind !== 'unsupported' && !q.humanOnly);
      if (actionable.length > 0) anySupported = true;
      const fingerprint = url + '|' + questions.map(q => q.prompt + ':' + q.options.map(o => o.text).join('|')).join('||');
      if (visited.has(fingerprint)) {
        complete = false; result.warnings.push('Câu hỏi/trang bị lặp, cần kiểm tra thủ công'); break;
      }
      visited.add(fingerprint);
      result.questionsFound += questions.length;
      // Moodle File Manager paths are user-selected attachments, never generated or inferred by an AI model.
      const fileAnswers=actionable.map(q=>practiceAttachmentAnswer(q,task)).filter((a):a is NonNullable<typeof a>=>!!a);
      const aiEligible=actionable.filter(q=>q.kind!=='moodle-file');
      const {bankAnswers,unmatched}=partitionByAnswerSource(aiEligible,answerBank,answerSourceMode,framePlatform,url);
      if (bankAnswers.length) result.warnings.push(`[FORM_FILE] ${bankAnswers.length} trường form sử dụng dữ liệu tệp do người dùng chọn; ${unmatched.length} mục chuyển AI`);
      if (answerSourceMode==='FORM_FILE' && answerBank.rows.length && bankAnswers.length===0 && actionable.length) {
        result.warnings.push('[FORM_FILE] Không có trường form phù hợp hoặc đây là quiz; AI xử lý toàn bộ câu hỏi được hỗ trợ');
      }
      let aiAnswers: import('./types.js').Answer[] = [];
      if (unmatched.length) {
        try {aiAnswers=await solveQuestions(page, unmatched, config, frame, notesFor(activeNoteVault, task.id, task.url, task.note));}
        catch(e){
          complete=false;
          const message=e instanceof Error?e.message:String(e);
          result.warnings.push(`[AI_NEEDS_REVIEW] Cannot provide verified answers for ${unmatched.length} items: ${message}`);
        }
      }
      const answers = [...fileAnswers, ...bankAnswers, ...aiAnswers];
      const byId = new Map(answers.map(a => [a.id, a]));
      const stepAnswers: Record<string, any> = {};
      for (const q of questions) {
        if (q.kind === 'unsupported') {
          hasUnsupportedOrHumanOnly = true;
          complete = false;
          result.warnings.push(`UNSUPPORTED [${q.id}${q.sourceType ? `/${q.sourceType}` : ''}]: ${q.unsupportedReason || 'Loại câu hỏi chưa hỗ trợ; cần xem xét thủ công'}`);
          continue;
        }
        if (q.humanOnly) {
          hasUnsupportedOrHumanOnly = true;
          complete = false;
          result.warnings.push(`HUMAN_ONLY [${q.id}]: ${q.humanOnly}`);
          continue;
        }
        const answer = byId.get(q.id);
        if (!answer) { complete = false; result.warnings.push(`Chưa có câu trả lời: ${url}/${q.id}`); continue; }
        if (answer.confidence !== undefined && answer.confidence < 0.6) {
          result.warnings.push(`LOW_CONFIDENCE [${q.id}]: Model tự báo confidence=${answer.confidence.toFixed(2)} (<0.60); cần người học kiểm tra kỹ đáp án`);
        }
        try {
          await fillAnswer(frame, q, answer);
          result.questionsFilled++;
          const recorded = { selected: answer.selected, placements: answer.placements, text: answer.text, fileName: answer.fileName, ...(answer.localFilePath?{attachmentSource:'USER_SELECTED_LOCAL_FILE'}:{}) };
          stepAnswers[q.id] = recorded;
          recordedAnswers[q.id] = recorded;
        }
        catch (e) { complete = false; result.warnings.push(`Không điền được ${q.id}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      answersByStep[pageIndex + 1] = { ...(answersByStep[pageIndex + 1] || {}), ...stepAnswers };
    }
    if (!pageQuestions) { result.warnings.push('Không tìm thấy trường hỗ trợ trên trang hoặc iframe đã cấp quyền'); complete = false; break; }
    const preNavStepUrl = page.url();
    await saveCheckpoint({
      taskId: task.id,
      url: task.url,
      currentStepUrl: preNavStepUrl,
      status: 'RUNNING',
      stepsCompleted: pageIndex + 1,
      domFilledSteps: pageIndex + 1,
      serverSavedSteps,
      totalSteps: task.maxPages || 1,
      questionsFound: result.questionsFound,
      questionsFilled: result.questionsFilled,
      answersRecorded: recordedAnswers,
      answersByStep: answersByStep,
      ...(scopeVerifiedRecord ? { scopeVerified: scopeVerifiedRecord } : {}),
      lastUpdated: new Date().toISOString()
    });
    if (!complete) break;
    if (pageIndex === ((task.maxPages || 1) - 1)) {
      const next = await locateNext(page, config.allowedHosts, task.nextButton, originOpts);
      // Avoid falsely reporting READY when more pages exist beyond the configured limit.
      if (hasUnvisitedPages(pageIndex, task.maxPages || 1, Boolean(next))) {
        complete = false;
        result.warnings.push(`Reached maxPages=${task.maxPages || 1} but the site still has a Next page`);
      }
      break;
    }

    // Unified Observe -> Act -> Verify page navigation (Phase 4: AUD-114-05)
    const navResult = await executeVerifiedNavigation(page, config, task.nextButton, pageIndex + 1);
    if (!navResult.success) {
      if (navResult.state === 'SUBMIT_GUARD') {
        // Submit page reached safely; current step remains DOM-filled only until explicit user submit
        break;
      }
      if (navResult.state === 'AUTH_REQUIRED') {
        result.status = 'WAITING_FOR_AUTH';
      } else if (navResult.state === 'ACCESS_RESTRICTED') {
        result.status = 'WAITING_FOR_ACCESS';
      } else if (navResult.state === 'HOST_MISMATCH' || navResult.state === 'NEEDS_REVIEW') {
        result.status = 'NEEDS_REVIEW';
      } else if (navResult.state === 'ERROR') {
        // Server / HTTP error during page transition: roll back stepsCompleted to confirmed serverSavedSteps
        // so unpersisted DOM edits are never falsely recorded as server-saved.
        await saveCheckpoint({
          taskId: task.id,
          url: task.url,
          currentStepUrl: preNavStepUrl,
          status: 'PARTIAL',
          stepsCompleted: serverSavedSteps,
          domFilledSteps: pageIndex + 1,
          serverSavedSteps,
          lastSaveError: navResult.reason,
          totalSteps: task.maxPages || 1,
          questionsFound: result.questionsFound,
          questionsFilled: result.questionsFilled,
          answersRecorded: recordedAnswers,
          answersByStep: answersByStep,
          ...(scopeVerifiedRecord ? { scopeVerified: scopeVerifiedRecord } : {}),
          lastUpdated: new Date().toISOString()
        });
      }
      complete = false;
      result.warnings.push(`Dừng chuyển trang ở bước ${pageIndex + 1}: ${navResult.reason}`);
      break;
    }
    serverSavedSteps = pageIndex + 1;
    await saveCheckpoint({
      taskId: task.id,
      url: task.url,
      currentStepUrl: preNavStepUrl,
      status: 'RUNNING',
      stepsCompleted: pageIndex + 1,
      domFilledSteps: pageIndex + 1,
      serverSavedSteps,
      totalSteps: task.maxPages || 1,
      questionsFound: result.questionsFound,
      questionsFilled: result.questionsFilled,
      answersRecorded: recordedAnswers,
      answersByStep: answersByStep,
      ...(scopeVerifiedRecord ? { scopeVerified: scopeVerifiedRecord } : {}),
      lastUpdated: new Date().toISOString()
    });
  }
  if(!anySupported)complete=false;
  if(result.status!=='WAITING_FOR_ACCESS' && result.status!=='WAITING_FOR_AUTH' && result.status!=='NEEDS_REVIEW'){
   if(readyForReview({supported:anySupported,complete,filled:result.questionsFilled,found:result.questionsFound,waiting:false})){
    result.status='READY_FOR_REVIEW';
   }else if(hasUnsupportedOrHumanOnly && result.questionsFilled===0){
    result.status='NEEDS_REVIEW';
   }else{
    result.status='PARTIAL';
   }
  }
  if(result.questionsFilled!==result.questionsFound)result.warnings.push('Còn câu chưa điền; không được tự nộp');
 }catch(e){result.warnings.push(redactSecrets(e instanceof Error?e.message:String(e)));result.status='ERROR';}
 finally {
    const effMode = resolveEffectiveOperationMode(config, task);
    if (effMode === 'READ_ONLY') {
      const remainingRO = Math.max(0, (contextActiveReadOnlyTasks.get(browserContext) || 1) - 1);
      contextActiveReadOnlyTasks.set(browserContext, remainingRO);
    }
    if (popupListener) {
      browserContext.off('page', popupListener);
    }
    if (result.readOnlyBlockedRequests?.length) {
      result.warnings.push(`[READ_ONLY_WRITE_BLOCKED] Đã chặn ${result.readOnlyBlockedRequests.length} request có thể thay đổi trạng thái: ${result.readOnlyBlockedRequests.slice(0, 5).join(", ")}`);
      if (result.status === 'READY_FOR_REVIEW' || result.status === 'PARTIAL') result.status = 'NEEDS_REVIEW';
    }
    result.finishedAt = new Date().toISOString();
  }
 return result;
}

export async function createReadOnlyContext(browser: any, options: any = {}): Promise<BrowserContext> {
  return browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...options
  });
}

export async function prepareTask(task:Task,config:AppConfig):Promise<TaskResult> {
  const effectiveMode = resolveEffectiveOperationMode(config, task);
  if (effectiveMode === 'READ_ONLY' && config.operationMode !== 'READ_ONLY' && context) {
    const browser = context.browser();
    if (browser) {
      const roContext = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: true,
        viewport: { width: 1280, height: 900 }
      });
      try {
        return await executeTask(roContext, task, config, noteVault, deadlines);
      } finally {
        await roContext.close().catch(() => {});
      }
    }
  }
  return executeTask(context!, task, config, noteVault, deadlines);
}
async function parallelMap<T,U>(list:T[],parallel:number,fn:(item:T)=>Promise<U>):Promise<U[]> {
 const out=new Array<U>(list.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(parallel,list.length)},async()=>{
  while(cursor<list.length){const i=cursor++;out[i]=await fn(list[i]);}
 }));return out;
}
async function confirmOne(task:Task,r:TaskResult,config:AppConfig):Promise<void>{
 if(r.status!=='READY_FOR_REVIEW'){
  warn(`Bỏ qua nộp ${task.id}: trạng thái ${r.status}`);return;
 }
 info(`${task.id}: đã điền ${r.questionsFilled}/${r.questionsFound}; chưa nộp.`);
 let confirm=(await getCli().question(`Bài ${task.id} đã sẵn sàng. CHECK=xem lại trình duyệt, SUBMIT ${task.id}=nộp ngay, Enter=giữ chưa nộp: `)).trim();
 if(confirm.toUpperCase()==='CHECK'){
  info(`Kiểm tra ở cửa sổ trình duyệt: ${r.page?.url()||task.url}. Bạn không cần quan sát trong lúc agent chạy.`);
  confirm=(await getCli().question(`Sau khi kiểm tra, gõ SUBMIT ${task.id} để nộp hoặc Enter để GIỮ NGUYÊN: `)).trim();
 }
 if(confirm!==`SUBMIT ${task.id}`){r.status='NOT_SUBMITTED';return;}
 try {
  const page=r.page!;
  ensureAllowed(page.url(),config.allowedHosts,originTrustFromConfig(config));
  const submitName=task.submitButton||/^(Submit|Submit all and finish|Submit quiz|Submit assignment|Turn in|Nộp bài|Gửi bài|Hoàn thành và nộp)$/i;
  let submit=page.getByRole('button',{name:submitName,exact:typeof submitName==='string'});
  // Moodle's "Finish attempt ..." opens a summary page, not a final submission. Do this
  // intermediate navigation only after the explicit SUBMIT <taskId> confirmation above.
  if((await submit.count())===0){
   const finish=page.getByRole('button',{name:/^Finish attempt\s*(?:\.{3}|…)?$/i});
   if((await finish.count())===1){
    await finish.click();
    await page.waitForLoadState('domcontentloaded',{timeout:12000}).catch(()=>{});
    ensureAllowed(page.url(),config.allowedHosts,originTrustFromConfig(config));
    submit=page.getByRole('button',{name:submitName,exact:typeof submitName==='string'});
   }
  }
  if(await submit.count()!==1){r.status='NOT_SUBMITTED';r.warnings.push('Submit button not uniquely identified; leave to manual review');return;}
  await submit.click();
  // An explicit Moodle confirmation dialog may remain. Only click an unambiguous submit
  // confirmation inside a dialog that visibly describes final submission.
  const dialog=page.getByRole('dialog').filter({hasText:/submit all and finish|nộp bài|final submission/i});
  if((await dialog.count())===1){
   const final=dialog.getByRole('button',{name:/^(Submit all and finish|Nộp bài|Confirm submission|Xác nhận nộp)$/i});
   if((await final.count())===1)await final.click();
  }
  r.status='UNCONFIRMED';
  if(task.successText){
   await page.getByText(task.successText,{exact:false}).first().waitFor({timeout:12000});
   r.status='SUBMITTED';
   await clearCheckpoint(task.id);
  }
  if(task.scoreSelector){const score=page.locator(task.scoreSelector);if(await score.count()===1)r.scoreObserved=(await score.innerText()).trim().slice(0,150);}
  else {const grade=await observeScore(page);if(grade)r.scoreObserved=grade.text;}
 }catch(e){r.status='UNCONFIRMED';r.warnings.push(`Nộp/chờ xác nhận: ${e instanceof Error?e.message:String(e)}`);}
}
async function main():Promise<void>{
  await loadTheme();
  const configPath = process.argv[2] || '.private/browser-task.json';
  let config: AppConfig;
  if (!existsSync(configPath)) {
    header('BROWSER AGENT');
    renderBreadcrumb(['COMMAND DECK', 'BROWSER AGENT', 'SETUP REQUIRED']);
    renderErrorCard(
      'Chưa tìm thấy cấu hình tác vụ (.private/browser-task.json)',
      'Browser Agent cần danh sách website được phép và tác vụ để thực hiện.',
      'Khởi chạy Setup Wizard tương tác để tạo cấu hình'
    );
    const configured = await browserSetupInteractive();
    if (!configured || !existsSync(configPath)) {
      warn('Chưa hoàn tất cấu hình Browser Agent. Quay lại menu.');
      return;
    }
  }
  config = await loadConfig(configPath);
 noteVault=await loadNotes();
 await loadTheme();
 header('BROWSER AGENT');
 section('Session overview');
 entry('TASKS',String(config.tasks.length),'cyan');
 entry('PARALLEL TABS',String(config.parallelTabs),'aqua');
 entry('SUBMISSION','Approval per task','orange');
 entry('AI NOTES',noteVault.global||Object.keys(noteVault.byHost).length||Object.keys(noteVault.byTask).length?'Configured':'None','cyan');
 info('AI only on explicitly authorized tasks. CAPTCHA/MFA remains manual.');
 const cli = getCli();
 const accepted=(await cli.question('Gõ ACCEPT để bắt đầu, cho phép đọc nội dung bài và (nếu bật AI cloud) gửi nội dung cho nhà cung cấp: ')).trim();
 if(accepted!=='ACCEPT'){warn('Đã hủy.');return;}
 const currentAnswerSource=config.answerSourceMode||'AI_PRIMARY';
 const sourceChoice=(await cli.question(`Nguồn câu trả lời: AI_PRIMARY=AI giải toàn bộ (mặc định), FORM_FILE=dùng tệp để điền form [${currentAnswerSource}]: `)).trim().toUpperCase();
 if(sourceChoice && sourceChoice!=='AI_PRIMARY' && sourceChoice!=='FORM_FILE')throw new Error('Nguồn đáp án không hợp lệ');
 config.answerSourceMode=(sourceChoice||currentAnswerSource) as AppConfig['answerSourceMode'];
 // An explicit run-level choice takes precedence over per-task saved preferences for this run only.
 // The on-disk configuration is not rewritten.
 if(sourceChoice) for(const t of config.tasks) t.answerSourceMode=config.answerSourceMode;
 if(config.answerSourceMode==='FORM_FILE'){
   const answerFileInput=(await cli.question('Tệp dữ liệu form JSON/CSV/TSV/TXT/MD/XLSX/DOCX/PDF (Enter=giữ cấu hình): ')).trim();
   if(answerFileInput)config.answerFilePaths=[...(config.answerFilePaths||[]),answerFileInput];
   info('Tệp chỉ dùng ở form được hỗ trợ; các trang quiz vẫn ưu tiên AI.');
 }else{
   info('AI_PRIMARY: giải mọi câu hỏi được hỗ trợ bằng ModelRouter; mọi tệp lưu trong cấu hình đều bị bỏ qua.');
 }
 config.interactiveAuthRecovery=true;
 if(!config.confirmAttemptStart){
  config.confirmAttemptStart=async({taskId,title,buttonLabel,url})=>{
   info(`[XÁC NHẬN MỞ LƯỢT TỰ LUYỆN MỚI] ${taskId} — "${title}" (${url}) yêu cầu bấm "${buttonLabel}".`);
   const ans=(await cli.question(`Gõ chính xác START ${taskId} để xác nhận mở lượt tự luyện mới, hoặc Enter để GIỮ NGUYÊN (NEEDS_REVIEW): `)).trim();
   return ans===`START ${taskId}`;
  };
 }
 const mainOriginOpts=originTrustFromConfig(config);
 const accountDb=await listAccounts();
 const savedAccount=config.accountId?accountDb[config.accountId]:null;
 if(config.accountId && !savedAccount)throw new Error(`Unknown account profile: ${config.accountId}. Run npm run accounts first.`);
 const swOption = config.operationMode === 'READ_ONLY' ? 'block' : 'allow';

 context=savedAccount?await accountContext(config.accountId!,savedAccount,{serviceWorkers:swOption}):await chromium.launchPersistentContext(resolve('.private','chromium-profile'),{headless:false,viewport:{width:1280,height:900},acceptDownloads:true,serviceWorkers:swOption});
 if(savedAccount)await loginForContext(context,config.accountId!,savedAccount,q=>cli.question(q));
 for(const url of config.authUrls||[]){
  const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  info(`Đăng nhập thủ công tại ${url} (bao gồm MFA nếu có).`);
  await cli.question('Sau khi đăng nhập xong và quay về trang cho phép, nhấn Enter... ');
  await page.close();
 }
 for(const url of config.deadlinePages||[]){
  const page=await context.newPage();
  try{await page.goto(url,{waitUntil:'domcontentloaded'});ensureAllowed(page.url(),config.allowedHosts,mainOriginOpts);
      deadlines.push(...await scanDeadlines(page,config.deadlineOffset||'+07:00'));
  }catch(e){warn(`Không thể quét lịch ${url}: ${e instanceof Error?e.message:String(e)}`);}
  finally{await page.close();}
 }
 let tasks=config.tasks;
 if(config.autoDiscover){
  section('Automatic LMS discovery');
  const seeds=config.discoveryStartUrls?.length?config.discoveryStartUrls:(config.deadlinePages?.length?config.deadlinePages:tasks.map(t=>t.url));
  const found=await discoverActivities(context,seeds,config.allowedHosts,config.maxDiscoveryPages||25,config.deadlineOffset,mainOriginOpts);
  deadlines.push(...found.deadlines);
  const activities=found.activities;
  for(let i=0;i<activities.length;i++)entry(`${i+1}. ${activities[i].kind}`,activities[i].title.slice(0,65));
  for(const w of found.warnings)warn(w);
  if(activities.length){
   const pick=(await cli.question(`Select ALL, comma-separated indices (1..${activities.length}), or Enter to keep configured tasks: `)).trim();
   if(pick.toUpperCase()==='ALL') tasks=[...tasks,...activities.map(toTask)];
   else if(pick){
    const ids=pick.split(',').map(x=>Number(x.trim())-1).filter(x=>Number.isInteger(x)&&x>=0&&x<activities.length);
    tasks=[...tasks,...[...new Set(ids)].map(i=>toTask(activities[i]))];
   }
  }
 }
 tasks=[...new Map(tasks.map(t=>[t.url,t])).values()];
 if(!tasks.length){warn('No tasks selected. Calendar scan/report only.');}
 results=await parallelMap(tasks,config.parallelTabs,t=>prepareTask(t,config));
 printSummary(results,deadlines);
 for(let i=0;i<results.length;i++)await confirmOne(tasks[i],results[i],config);
 printSummary(results,deadlines);
 success('JSON report: '+await saveReport(results,deadlines));
 const action=(await cli.question('Session: Enter=KEEP saved login, LOGOUT=clear cookies, FORGET=remove local browser session: ')).trim().toUpperCase();
 if(action==='LOGOUT') {await context.clearCookies();info('Cookies cleared; website local storage may still retain session data. Use FORGET to remove it.');}
 else if(action==='FORGET'&&config.accountId){await context.close();context=undefined;await forgetSession(config.accountId);success('Saved browser profile deleted; account credentials retained in OS vault.');}
 else if(action==='FORGET'){await context.close();context=undefined;await (await import('node:fs/promises')).rm(resolve('.private','chromium-profile'),{recursive:true,force:true});}
 else info('Saved browser session retained for next run.');
}
const isDirectRun = Boolean(
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
);
if (isDirectRun) {
  main().catch(e=>{fail('Browser Agent: '+redactSecrets(String(e)));process.exitCode=1;}).finally(async()=>{
   await context?.close();close('SESSION CLOSED');cliInstance?.close();
  });
}
