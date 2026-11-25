/** Task state tracking, checkpoints, duplicate detection and self-recovery. */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { recentReports } from './ui/dashboard.js';
import { scanQuestions } from './scanner.js';
import { redactObject, redactSecrets } from './security/redact.js';

export type ExtendedJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'WAITING_FOR_ACCESS'
  | 'WAITING_FOR_AUTH'
  | 'PAUSED'
  | 'NEEDS_REVIEW'
  | 'WAITING_FOR_APPROVAL'
  | 'SUBMITTED'
  | 'UNCONFIRMED';

export interface TaskCheckpoint {
  taskId: string;
  url: string;
  currentStepUrl?: string;
  status: ExtendedJobStatus;
  stepsCompleted: number;
  /** Steps filled & verified on browser DOM (may exceed serverSavedSteps before page-save POST completes) */
  domFilledSteps?: number;
  /** Steps confirmed persisted via successful server navigation / draft POST (HTTP < 400 + verified transition) */
  serverSavedSteps?: number;
  /** Last server or navigation save failure reason (e.g. HTTP 500 on processattempt.php) */
  lastSaveError?: string;
  totalSteps?: number;
  questionsFound: number;
  questionsFilled: number;
  modelUsed?: string;
  runtimeMs?: number;
  error?: string;
  cause?: string;
  answersRecorded?: Record<string, any>;
  answersByStep?: Record<number, Record<string, any>>;
  lastUpdated: string;
  website?: string;
  priority?: number;
  deadline?: string;
  fingerprint?: string;
  checksum?: string;
  /** Identity-bound verification record confirming this checkpoint belongs to a verified self-practice activity. */
  scopeVerified?: ScopeVerificationBinding;
}

export interface ScopeVerificationBinding {
  scope: 'PRACTICE_VERIFIED';
  mode: 'PRACTICE_ASSISTED';
  origin: string;
  pathname?: string;
  verifiedAt: string;
  taskId?: string;
  cmid?: string;
  quizId?: string;
  attemptId?: string;
  source?: 'VIEW_PAGE_INSPECTION' | 'OPERATOR_ATTESTATION' | 'ATTEMPT_PAGE_VERIFIED';
}

const CHECKPOINTS_DIR = resolve('.private', 'checkpoints');

/** Resolves an absolute, directory-traversal-proof path for a task's checkpoint */
export function getSafeCheckpointPath(taskId: string): string {
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('Task ID không hợp lệ');
  }
  let safeFileName: string;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    safeFileName = `${taskId}.json`;
  } else {
    // Hash dangerous or separator-containing task IDs to prevent path traversal
    const hash = createHash('sha256').update(taskId).digest('hex').slice(0, 32);
    const cleanPrefix = taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
    safeFileName = `${cleanPrefix}_${hash}.json`;
  }

  const resolved = resolve(CHECKPOINTS_DIR, safeFileName);
  const normalizedBase = resolve(CHECKPOINTS_DIR);
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error(`Phát hiện nguy cơ Path Traversal với taskId: "${taskId}"`);
  }
  return resolved;
}

/** Recursively strips sensitive passwords, auth tokens, session cookies, and query tokens from checkpoint */
export function sanitizeCheckpoint(data: TaskCheckpoint): TaskCheckpoint {
  const sanitized = redactObject(data);
  if (sanitized.url) {
    sanitized.url = redactSecrets(sanitized.url);
  }
  if (sanitized.currentStepUrl) {
    sanitized.currentStepUrl = redactSecrets(sanitized.currentStepUrl);
  }
  if (sanitized.error) {
    sanitized.error = redactSecrets(sanitized.error);
  }
  if (sanitized.cause) {
    sanitized.cause = redactSecrets(sanitized.cause);
  }
  if (sanitized.lastSaveError) {
    sanitized.lastSaveError = redactSecrets(sanitized.lastSaveError);
  }
  if (sanitized.answersRecorded) {
    const safeAnswers: Record<string, any> = {};
    for (const [key, val] of Object.entries(sanitized.answersRecorded)) {
      if (/password|pass|secret|token|cookie|auth|credential/i.test(key)) continue;
      if (typeof val === 'string' && /password|token|bearer|basic/i.test(val)) continue;
      safeAnswers[key] = redactObject(val);
    }
    sanitized.answersRecorded = safeAnswers;
  }
  if (sanitized.answersByStep) {
    const safeByStep: Record<number, Record<string, any>> = {};
    for (const [stepKey, stepAnswers] of Object.entries(sanitized.answersByStep)) {
      if (!stepAnswers || typeof stepAnswers !== 'object') continue;
      const safeAnswers: Record<string, any> = {};
      for (const [key, val] of Object.entries(stepAnswers)) {
        if (/password|pass|secret|token|cookie|auth|credential/i.test(key)) continue;
        if (typeof val === 'string' && /password|token|bearer|basic/i.test(val)) continue;
        safeAnswers[key] = redactObject(val);
      }
      safeByStep[Number(stepKey)] = safeAnswers;
    }
    sanitized.answersByStep = safeByStep;
  }
  return sanitized;
}

/** Atomically writes checkpoint to prevent corruption on crash or abrupt termination.
 * Uses atomic rename with retries for transient locks, fsync flush for durability, and computes integrity checksum.
 */
export async function saveCheckpoint(data: TaskCheckpoint): Promise<void> {
  await mkdir(CHECKPOINTS_DIR, { recursive: true });
  const sanitized = sanitizeCheckpoint(data);
  sanitized.lastUpdated = new Date().toISOString();

  // Compute integrity checksum over payload without checksum field
  const payloadForChecksum = { ...sanitized };
  delete payloadForChecksum.checksum;
  const checksum = createHash('sha256').update(JSON.stringify(payloadForChecksum)).digest('hex');
  sanitized.checksum = checksum;

  const file = getSafeCheckpointPath(sanitized.taskId);
  const tmpFile = `${file}.tmp.${process.pid}.${Date.now()}`;
  const serialized = JSON.stringify(sanitized, null, 2) + '\n';

  // 1. Write to temporary file with restrictive permissions and explicit fsync flush
  const { open, rename, unlink } = await import('node:fs/promises');
  const fileHandle = await open(tmpFile, 'w', 0o600);
  try {
    await fileHandle.writeFile(serialized, { encoding: 'utf8' });
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  // 2. Atomic rename with retry mechanism (handles transient Windows Defender / indexer locks)
  let renamed = false;
  let lastRenameError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rename(tmpFile, file);
      renamed = true;
      break;
    } catch (err) {
      lastRenameError = err;
      await new Promise(r => setTimeout(r, 40 * attempt));
    }
  }

  // 3. If atomic rename succeeded, completed
  if (renamed) return;

  // 4. If rename failed after retries, preserve existing valid checkpoint if present
  try {
    await unlink(tmpFile);
  } catch {}

  if (existsSync(file)) {
    throw new Error(`Atomic checkpoint write failed for ${sanitized.taskId}; preserved existing valid checkpoint on disk. Error: ${lastRenameError}`);
  }

  throw new Error(`Failed to save checkpoint for ${sanitized.taskId}: ${lastRenameError}`);
}

export async function loadCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
  try {
    const file = getSafeCheckpointPath(taskId);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.taskId) {
      return null;
    }

    // Verify integrity checksum if present
    if (parsed.checksum) {
      const copy = { ...parsed };
      const expectedChecksum = copy.checksum;
      delete copy.checksum;
      const computed = createHash('sha256').update(JSON.stringify(copy)).digest('hex');
      if (computed !== expectedChecksum) {
        // Corrupted file detected
        return null;
      }
    }

    return parsed as TaskCheckpoint;
  } catch {
    return null;
  }
}

/** Cleans up temporary orphaned files left behind by interrupted process crashes */
export async function cleanupOrphanCheckpoints(maxAgeMs = 300000): Promise<number> {
  if (!existsSync(CHECKPOINTS_DIR)) return 0;
  let cleaned = 0;
  try {
    const files = await readdir(CHECKPOINTS_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f.includes('.tmp.')) {
        const full = join(CHECKPOINTS_DIR, f);
        try {
          const stats = await import('node:fs/promises').then(fs => fs.stat(full));
          if (now - stats.mtimeMs > maxAgeMs) {
            await rm(full, { force: true });
            cleaned++;
          }
        } catch {}
      }
    }
  } catch {}
  return cleaned;
}

export async function clearCheckpoint(taskId: string): Promise<void> {
  try {
    const file = getSafeCheckpointPath(taskId);
    await rm(file, { force: true });
  } catch {}
}

export async function listAllCheckpoints(): Promise<TaskCheckpoint[]> {
  try {
    if (!existsSync(CHECKPOINTS_DIR)) return [];
    const files = (await readdir(CHECKPOINTS_DIR)).filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
    const list: TaskCheckpoint[] = [];
    for (const f of files) {
      try {
        const raw = await readFile(join(CHECKPOINTS_DIR, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.taskId) {
          list.push(parsed as TaskCheckpoint);
        }
      } catch {}
    }
    return list;
  } catch {
    return [];
  }
}

export interface DuplicateRiskAssessment {
  isDuplicateRisk: boolean;
  message?: string;
  previousStatus?: string;
  previousScore?: string | null;
  previousReportFile?: string;
}

/** Check if a task URL or ID was already completed in past reports to prevent duplicate submissions */
export async function checkDuplicateRisk(taskId: string, url: string): Promise<DuplicateRiskAssessment> {
  const reports = await recentReports(10);
  for (const r of reports) {
    for (const res of r.report.results) {
      if ((res.id === taskId || res.url === url) && (res.status === 'SUBMITTED' || res.scoreObserved)) {
        return {
          isDuplicateRisk: true,
          previousStatus: res.status,
          previousScore: res.scoreObserved,
          previousReportFile: r.file,
          message: `Tác vụ "${taskId}" đã được hoàn thành/nộp trong báo cáo ${r.file} (Điểm: ${res.scoreObserved || 'Đã nộp'}). Phát hiện nguy cơ nộp bài trùng lặp!`
        };
      }
    }
  }
  return { isDuplicateRisk: false };
}

/** Resilient browser navigation with retries and timeout recovery */
export async function resilientGoto(page: Page, url: string, maxAttempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      return;
    } catch (e) {
      lastErr = e;
      if (i < maxAttempts) {
        await page.waitForTimeout(1500 * i);
      }
    }
  }
  throw new Error(`Navigation thất bại sau ${maxAttempts} lần thử: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export interface ResumeVerificationResult {
  canResume: boolean;
  reason: string;
  matchedQuestions?: number;
  verifiedValuesCount?: number;
  uncertainState?: boolean;
}

export interface VerifyResumeOptions {
  step?: number;
  skipMissingQuestions?: boolean;
}

/** Verifies live DOM against checkpoint before resuming to avoid duplicate submissions or out-of-sync execution */
export async function verifyResumeState(
  page: Page,
  checkpoint: TaskCheckpoint,
  options?: VerifyResumeOptions
): Promise<ResumeVerificationResult> {
  const currentUrl = page.url();
  try {
    const parsedCurrent = new URL(currentUrl);
    const parsedTarget = new URL(checkpoint.url);
    if (parsedCurrent.hostname !== parsedTarget.hostname) {
      return {
        canResume: false,
        uncertainState: true,
        reason: `Trang hiện tại (${parsedCurrent.hostname}) khác với hostname trong checkpoint (${parsedTarget.hostname})`
      };
    }
  } catch (e) {
    return { canResume: false, uncertainState: true, reason: `URL không hợp lệ: ${currentUrl}` };
  }

  // Detect irreversible, submitted or unconfirmed state
  if (checkpoint.status === 'COMPLETED' || checkpoint.status === 'SUBMITTED' || checkpoint.status === 'UNCONFIRMED') {
    return {
      canResume: false,
      uncertainState: true,
      reason: `Biểu mẫu đã ở trạng thái ${checkpoint.status}. Không tự động gửi lại để tránh trùng lặp.`
    };
  }

  try {
    const bodyText = (await page.locator('body').innerText({ timeout: 3000 })).toLowerCase();
    const submittedKeywords = [
      'câu trả lời của bạn đã được ghi nhận',
      'your response has been recorded',
      'đã nộp bài',
      'submitted successfully',
      'đã hoàn thành bài kiểm tra',
      'attempts allowed: 1',
      'đã gửi',
      'bạn đã làm bài này'
    ];
    for (const kw of submittedKeywords) {
      if (bodyText.includes(kw)) {
        return {
          canResume: false,
          uncertainState: true,
          reason: `Trang hiển thị trạng thái đã hoàn thành/nộp bài ("${kw}"). Không tự động gửi lại để tránh trùng lặp.`
        };
      }
    }
  } catch {}

  // Live DOM verification of questions and populated values
  try {
    const qs = await scanQuestions(page);
    let recordedAnswers = checkpoint.answersRecorded || {};

    if (options?.step !== undefined && checkpoint.answersByStep && Object.keys(checkpoint.answersByStep).length > 0) {
      recordedAnswers = checkpoint.answersByStep[options.step] || {};
    } else if (!options?.step && checkpoint.answersByStep && Object.keys(checkpoint.answersByStep).length > 0) {
      // Step not explicitly specified: detect matching step by comparing DOM question IDs
      const domIds = new Set(qs.map(q => q.id));
      let bestStep = 1;
      let maxMatches = -1;
      for (const [sKey, sAnswers] of Object.entries(checkpoint.answersByStep)) {
        const sKeys = Object.keys(sAnswers);
        const matches = sKeys.filter(k => domIds.has(k)).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          bestStep = Number(sKey);
        }
      }
      if (maxMatches > 0 && checkpoint.answersByStep[bestStep]) {
        recordedAnswers = checkpoint.answersByStep[bestStep];
      }
    }

    const recordedEntries = Object.entries(recordedAnswers);

    // CASE R-08: If checkpoint has no recorded answers, this is a fresh start on this page
    if (recordedEntries.length === 0) {
      return {
        canResume: true,
        verifiedValuesCount: 0,
        matchedQuestions: 0,
        reason: 'Tác vụ mới hoặc chưa có câu trả lời nào được ghi nhận trong checkpoint'
      };
    }

    let verifiedValuesCount = 0;
    let matchedQuestions = 0;

    for (const [key, recorded] of recordedEntries) {
      // Find matching question from scanQuestions or direct DOM element
      let q = qs.find(item => item.id === key);

      const rawExpectedSel = Array.isArray(recorded)
        ? recorded[0]
        : (Array.isArray(recorded?.selected) ? recorded.selected[0] : (typeof recorded === 'string' ? recorded : ''));
      const matchedOpt = q?.options?.find(o => o.id === rawExpectedSel || o.value === rawExpectedSel || o.text === rawExpectedSel);
      const expectedOptHint = matchedOpt ? { id: matchedOpt.id, text: matchedOpt.text, value: matchedOpt.value } : null;

      // Verify DOM state for this question
      const evalResult = await page.evaluate(({ qId, key, recorded, expectedOptHint }) => {
        // Query inputs by data-atqa-id, name, or id
        const query = `[data-atqa-id="${qId}"], [name="${key}"], #${CSS.escape(key)}`;
        const elements = Array.from(document.querySelectorAll<HTMLElement>(query));

        if (elements.length === 0) {
          // If neither selector found element, search for any input matching choice or radio group
          const anyRadio = document.querySelector<HTMLInputElement>(`input[name="${key}"], input[value="${key}"]`);
          if (anyRadio) elements.push(anyRadio);
        }

        if (elements.length === 0) {
          return { verified: false, reason: `Không tìm thấy phần tử cho câu hỏi "${key}" trên DOM hiện tại` };
        }

        // Find the actual form control among matched elements, or search inside container if a container was matched
        let targetControl = elements.find(el => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox') as HTMLInputElement | undefined;
        if (!targetControl) {
          for (const el of elements) {
            const nestedInput = el.querySelector<HTMLInputElement>('input, textarea, select, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="textbox"]');
            if (nestedInput) {
              targetControl = nestedInput;
              break;
            }
          }
        }
        const first = targetControl || (elements[0] as HTMLInputElement);
        const type = (first.type || '').toLowerCase();
        const role = (first.getAttribute('role') || '').toLowerCase();

        // 1. Radio verification
        if (type === 'radio' || role === 'radio' || elements.some(el => (el as HTMLInputElement).type === 'radio' || el.getAttribute('role') === 'radio')) {
          const groupName = first.name;
          const allRadios = groupName
            ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"], [role="radio"][name="${groupName}"]`))
            : elements.filter(el => (el as HTMLInputElement).type === 'radio' || el.getAttribute('role') === 'radio') as HTMLInputElement[];

          const checkedRadios = allRadios.filter(r => r.checked || r.getAttribute('aria-checked') === 'true');
          if (checkedRadios.length === 0) {
            return { verified: false, reason: `Câu hỏi radio "${key}" đã ghi nhận đáp án nhưng trên DOM chưa có lựa chọn nào được chọn` };
          }

          const expectedSelected = Array.isArray(recorded)
            ? recorded
            : (Array.isArray(recorded?.selected)
                ? recorded.selected
                : (recorded?.selected ? [recorded.selected] : (typeof recorded === 'string' ? [recorded] : [])));

          const checkedChoices = checkedRadios.map(r => r.dataset.atqaChoice || r.value || r.id || (r.parentElement?.textContent || '').trim());
          const hasMatch = expectedSelected.some((exp: string) =>
            checkedChoices.includes(exp) ||
            checkedRadios.some(c => c.value === exp || c.dataset.atqaChoice === exp || (c.parentElement?.textContent || '').includes(exp))
          );

          if (!hasMatch) {
            return { verified: false, reason: `Lựa chọn radio trên DOM (${checkedChoices.join(', ')}) khác với checkpoint ("${expectedSelected.join(', ')}")` };
          }
          return { verified: true };
        }

        // 2. Checkbox verification
        if (type === 'checkbox' || role === 'checkbox' || elements.some(el => (el as HTMLInputElement).type === 'checkbox')) {
          const groupName = first.name;
          const allBoxes = groupName
            ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${groupName}"], [role="checkbox"][name="${groupName}"]`))
            : elements.filter(el => (el as HTMLInputElement).type === 'checkbox' || el.getAttribute('role') === 'checkbox') as HTMLInputElement[];

          const checkedBoxes = allBoxes.filter(r => r.checked || r.getAttribute('aria-checked') === 'true');
          const expectedSelected = Array.isArray(recorded)
            ? recorded
            : (Array.isArray(recorded?.selected)
                ? recorded.selected
                : (typeof recorded === 'string' ? [recorded] : []));

          if (expectedSelected.length > 0 && checkedBoxes.length === 0) {
            return { verified: false, reason: `Câu hỏi checkbox "${key}" đã ghi nhận đáp án nhưng trên DOM chưa có hộp kiểm nào được chọn` };
          }

          const checkedChoices = checkedBoxes.map(c => c.dataset.atqaChoice || c.value || c.id);
          const allMatch = expectedSelected.every((exp: string) =>
            checkedChoices.includes(exp) ||
            checkedBoxes.some(c => c.value === exp || (c.parentElement?.textContent || '').includes(exp))
          );

          if (!allMatch || checkedBoxes.length !== expectedSelected.length) {
            return { verified: false, reason: `Tập hợp hộp kiểm đã chọn trên DOM không khớp với checkpoint` };
          }
          return { verified: true };
        }

        // 3. Text, Textarea & Contenteditable verification
        if (type === 'text' || type === 'search' || type === 'email' || type === 'number' || type === 'tel' || type === 'date' || type === 'time' || type === 'url' || first.tagName === 'TEXTAREA' || role === 'textbox' || first.getAttribute('contenteditable') === 'true') {
          const expectedText = (typeof recorded === 'string' ? recorded : (typeof recorded?.text === 'string' ? recorded.text : '')).trim();
          const actualText = (first.value ?? first.innerText ?? first.textContent ?? '').trim();

          if (expectedText && !actualText) {
            return { verified: false, reason: `Trường nhập liệu "${key}" đang để trống trên DOM, khác checkpoint ("${expectedText}")` };
          }
          if (expectedText !== actualText) {
            return { verified: false, reason: `Nội dung trường "${key}" trên DOM ("${actualText}") khác với checkpoint ("${expectedText}")` };
          }
          return { verified: true };
        }

        // 4. Select dropdown verification
        if (first.tagName === 'SELECT') {
          const sel = first as unknown as HTMLSelectElement;
          const expected = (typeof recorded === 'string' ? recorded : (typeof recorded?.text === 'string' ? recorded.text : (Array.isArray(recorded?.selected) ? String(recorded.selected[0] ?? '') : ''))).trim();
          const selectedOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : undefined;
          const actualVal = (selectedOpt?.value || '').trim();
          const actualText = (selectedOpt?.text || '').trim();
          const actualIdx = String(sel.selectedIndex);

          if (sel.selectedIndex < 0 || (!actualVal && !actualText)) {
            return { verified: false, reason: `Chưa có lựa chọn nào được chọn trong dropdown select "${key}"` };
          }
          const matchesDirect = expected === actualVal || expected === actualText;
          const matchesHint = Boolean(
            expectedOptHint &&
            ((expectedOptHint.value !== undefined && actualVal === expectedOptHint.value.trim()) ||
             (expectedOptHint.text && actualText === expectedOptHint.text.trim()) ||
             (expectedOptHint.id === actualIdx && actualVal !== ''))
          );
          if (!matchesDirect && !matchesHint) {
            return { verified: false, reason: `Lựa chọn dropdown select "${key}" trên DOM ("${actualText || actualVal}") khác với checkpoint ("${expected}")` };
          }
          return { verified: true };
        }

        // 5. File upload verification (AUDIT-01 Remediation)
        if (type === 'file' || (first.tagName === 'INPUT' && (first as HTMLInputElement).type === 'file')) {
          const fileInput = first as HTMLInputElement;
          const files = fileInput.files;
          const fileList = files ? Array.from(files) : [];
          const expectedFile = (typeof recorded === 'string'
            ? recorded
            : (typeof recorded?.fileName === 'string'
                ? recorded.fileName
                : (typeof recorded?.text === 'string' ? recorded.text : ''))).trim();

          // Check if server-side rendered a file chip/indicator scoped to the current question container
          const container = first.parentElement ? (first.parentElement.closest('.question, [data-atqa-id], fieldset, [role="group"], .form-group') || first.parentElement) : document.body;
          const chipElements = Array.from(container.querySelectorAll('.file-preview, .upload-chip, .file-uploaded, .filename, [data-uploaded-file]'));
          const chipHasFile = Boolean(expectedFile && chipElements.some(el => (el.textContent || '').includes(expectedFile)));

          if (fileList.length === 0 && !chipHasFile) {
            return {
              verified: false,
              reason: `Trường upload tệp "${key}" chưa có tệp nào được đính kèm trên DOM trình duyệt`
            };
          }

          if (expectedFile && fileList.length > 0) {
            const hasExpectedFile = fileList.some(f => f.name === expectedFile || f.name.endsWith(expectedFile) || expectedFile.endsWith(f.name));
            if (!hasExpectedFile && !chipHasFile) {
              const actualNames = fileList.map(f => f.name).join(', ');
              return {
                verified: false,
                reason: `Tên tệp đã đính kèm trên DOM ("${actualNames}") không khớp với checkpoint ("${expectedFile}")`
              };
            }
          }

          return { verified: true };
        }

        // Strict fail-closed default for unhandled control types
        return {
          verified: false,
          reason: `Loại điều khiển form ("${type || first.tagName.toLowerCase()}") chưa được xác minh an toàn trên DOM`
        };
      }, { qId: q ? q.id : key, key, recorded, expectedOptHint }).catch(err => ({
        verified: false,
        reason: `Lỗi đọc DOM cho "${key}": ${err instanceof Error ? err.message : String(err)}`
      }));

      if (!evalResult.verified) {
        return {
          canResume: false,
          uncertainState: true,
          verifiedValuesCount,
          matchedQuestions,
          reason: evalResult.reason || `Giá trị trên DOM cho "${key}" không khớp với checkpoint`
        };
      }

      matchedQuestions++;
      verifiedValuesCount++;
    }

    if (verifiedValuesCount === recordedEntries.length) {
      return {
        canResume: true,
        reason: `Xác minh thành công DOM: ${verifiedValuesCount}/${recordedEntries.length} câu hỏi khớp chính xác giá trị đã điền`,
        matchedQuestions,
        verifiedValuesCount
      };
    } else {
      return {
        canResume: false,
        uncertainState: true,
        reason: `Chỉ xác minh được ${verifiedValuesCount}/${recordedEntries.length} giá trị trên DOM`,
        matchedQuestions,
        verifiedValuesCount
      };
    }
  } catch (e) {
    return {
      canResume: false,
      uncertainState: true,
      reason: `Không thể đọc DOM trang để xác minh checkpoint: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
