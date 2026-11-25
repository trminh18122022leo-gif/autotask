import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/** Safe Quiz Attempt Start Policy (`AUD-LMS-04`, `START-01..10`)
 *
 * Enforces strict separation between:
 *   1. `READ_ONLY`            — Observe metadata, deadlines, grades, and gates only; 0 starts, 0 fills, 0 submits.
 *   2. `PRACTICE_ASSISTED`    — Permitted self-practice; resuming an already-open attempt is allowed, while starting
 *                               a NEW attempt requires verified self-practice scope AND separate explicit confirmation.
 *   3. `ASSESSMENT_RESTRICTED`— Graded exams / midterms / finals / restricted assessments; 0 starts, 0 fills, 0 submits.
 *
 * Default posture: NEVER auto-click "Attempt quiz now" / "Start attempt" / `startattempt.php` merely because the button exists.
 */
import type { Page } from 'playwright';
import { ensureAllowed, originTrustFromConfig, type OriginTrustOptions } from './config.js';
import { readableFrames } from './interaction.js';
import { resolveEffectiveOperationMode } from './operation-mode.js';
import type { TaskCheckpoint, ScopeVerificationBinding } from './task-manager.js';
import type { AppConfig, LmsOperationMode, Task, VerifiedAttemptIdentity } from './types.js';

export interface QuizActivityIdentity {
  origin: string;
  pathname: string;
  cmid?: string;
  quizId?: string;
  attemptId?: string;
}

/** Extracts canonical LMS activity coordinates (cmid, quizId, attemptId) for identity binding. */
export function extractQuizActivityIdentity(rawUrl: string): QuizActivityIdentity {
  try {
    const u = new URL(rawUrl);
    const origin = u.origin.toLowerCase();
    const pathname = u.pathname.toLowerCase();
    const cmid = u.searchParams.get('id') || u.searchParams.get('cmid') || undefined;
    const quizId = u.searchParams.get('q') || u.searchParams.get('quiz') || undefined;
    const attemptId = u.searchParams.get('attempt') || undefined;
    return { origin, pathname, cmid, quizId, attemptId };
  } catch {
    return { origin: '', pathname: rawUrl };
  }
}

export type QuizScopeClassification =
  | 'ASSESSMENT_RESTRICTED'
  | 'PRACTICE_VERIFIED'
  | 'UNKNOWN_SCOPE';

export interface QuizLaunchSurfaceInspection {
  hasContinueAttemptControl: boolean;
  continueLabel?: string;
  hasNewAttemptControl: boolean;
  newAttemptLabel?: string;
  hasStartAttemptForm: boolean;
  exhaustedAttempts: boolean;
  exhaustedReason?: string;
  scope: QuizScopeClassification;
  scopeEvidence: string;
}

export interface QuizStartDecision {
  action: 'START_NEW_ATTEMPT' | 'CONTINUE_EXISTING_ATTEMPT' | 'NO_LAUNCH_CONTROL' | 'HALT_NEEDS_REVIEW';
  reason: string;
  code:
    | 'ALLOWED_NEW_PRACTICE_ATTEMPT'
    | 'ALLOWED_CONTINUE_OPEN_ATTEMPT'
    | 'NO_LAUNCH_CONTROL'
    | 'READ_ONLY_MODE'
    | 'ASSESSMENT_RESTRICTED_SCOPE'
    | 'ORIGIN_TASK_MISMATCH'
    | 'ATTEMPTS_EXHAUSTED'
    | 'MODE_NOT_PRACTICE_ASSISTED'
    | 'UNKNOWN_PRACTICE_SCOPE'
    | 'AWAITING_START_CONFIRMATION';
}

export const CONTINUE_ATTEMPT_PATTERN =
  /^(Continue the last attempt|Continue your attempt|Continue attempt|Tiếp tục lần làm bài(?: cuối)?)$/i;

export const NEW_ATTEMPT_PATTERN =
  /^(Attempt quiz now|Start attempt|Re-attempt quiz|Bắt đầu làm bài|Làm bài|Làm lại bài|Start quiz|Start exercise|Begin practice)$/i;

const GRADED_ASSESSMENT_REGEX =
  /\b(midterm(?:\s+quiz|\s+exam|\s+test)?|final\s+(?:exam|test|quiz)|graded\s+(?:exam|quiz|test|assessment)|official\s+exam|proctored(?:\s+exam)?|summative\s+assessment|invigilated|exam\s+only|no\s+ai\s+allowed)\b|thi\s+giữa\s+kỳ|thi\s+cuối\s+kỳ|kiểm\s+tra\s+giữa\s+kỳ|kiểm\s+tra\s+cuối\s+kỳ|bài\s+thi\s+chính\s+thức|kiểm\s+tra\s+tính\s+điểm|lấy\s+điểm\s+quá\s+trình|cấm\s+sử\s+dụng\s+ai/i;

/** Gradebook / assessment-policy metadata. These signals are evaluated BEFORE any practice keyword and can never be
 *  neutralised by a "Practice"/"Self-practice" title or label (`PRACTICE-SAFE-01..03`). */
const GRADING_METADATA_SIGNALS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  {
    label: 'Grading method (Highest/Average/First/Last grade)',
    regex: /\bgrading\s+method\s*:\s*(?:highest|average|first|last)\b|phương\s+pháp\s+chấm\s+điểm\s*:\s*(?:điểm\s+cao\s+nhất|điểm\s+trung\s+bình|lần\s+(?:đầu|cuối))/i
  },
  {
    label: 'Grade to pass',
    regex: /\bgrade\s+to\s+pass\s*:\s*\d|điểm\s+đạt\s*:\s*\d/i
  },
  {
    label: 'Gradebook item / weight / category',
    regex: /\bgradebook\s+(?:item|category)\b|\bgrade\s+category\b|\bcourse\s+total\b|\bweight(?:ing)?\s*:\s*\d|sổ\s+điểm|tỷ\s+trọng|trọng\s+số/i
  },
  {
    label: 'Limited attempts',
    regex: /\battempts?\s+allowed\s*:\s*[1-9]\d*\b|số\s+lần\s+làm\s+bài\s*(?:cho\s+phép)?\s*:\s*[1-9]/i
  },
  {
    label: 'Timed / proctored assessment rules',
    regex: /\btime\s+limit\s*:\s*\d|giới\s+hạn\s+thời\s+gian\s*:\s*\d|\bsafe\s+exam\s+browser\b|\blockdown\s+browser\b/i
  },
  {
    label: 'Course assessment policy (counts towards course grade)',
    regex: /\b(?:counts?|contributes?)\s+(?:towards?|to)\s+(?:your\s+)?(?:final\s+|course\s+)?grade\b|tính\s+vào\s+điểm\s+(?:quá\s+trình|môn|học\s+phần)/i
  }
];

/** Practice labels alone are NEVER enough: a title such as "Practice Quiz" says nothing about grading. */
const PRACTICE_LABEL_REGEX =
  /\b(practice(?:\s+quiz|\s+test|\s+exercise)?|self[- ]practice|mock\s+quiz|sample\s+quiz|review\s+quiz|review\s+exercise|training\s+quiz|formative\s+practice|warm[- ]up\s+quiz)\b|luyện\s+tập|tự\s+luyện|ôn\s+tập|bài\s+tập\s+mẫu|thử\s+nghiệm/i;

/** Explicit statement that the activity yields no grade. Needed IN ADDITION to a practice label. */
const UNGRADED_EVIDENCE_REGEX =
  /\b(?:ungraded|non[- ]graded|not\s+graded|no\s+grade|permitted\s+self[- ]practice)\b|\b0(?:\.0+)?\s*points\b|không\s+tính\s+điểm|không\s+ghi\s+(?:vào\s+)?sổ\s+điểm/i;

const EXHAUSTED_ATTEMPTS_REGEX =
  /no more attempts are allowed|không còn lượt làm bài|bạn đã hết lượt làm bài|bạn đã hoàn thành bài kiểm tra|your response has been recorded|câu trả lời của bạn đã được ghi nhận/i;

/** Classifies whether an activity represents a graded/restricted assessment, verified self-practice, or unknown scope.
 *
 *  Evaluation order (fail-closed):
 *   1. Exam titles / grading metadata (Grading method, Grade to pass, Gradebook, limited attempts, timed/proctored, policy) -> ASSESSMENT_RESTRICTED
 *      — even when the same text also says "Practice".
 *   2. PRACTICE_VERIFIED only when a practice label AND an explicit ungraded statement are both present and no graded signal exists.
 *   3. Everything else (including title-only "Practice Quiz", empty/unloaded metadata) -> UNKNOWN_SCOPE.
 */
export function classifyActivityScope(textContext: string): {
  scope: QuizScopeClassification;
  evidence: string;
} {
  const normalized = textContext.replace(/\s+/g, ' ').trim();
  const gradedSignals: string[] = [];
  const gradedMatch = normalized.match(GRADED_ASSESSMENT_REGEX);
  if (gradedMatch) gradedSignals.push(`"${gradedMatch[0]}"`);
  for (const sig of GRADING_METADATA_SIGNALS) {
    const m = normalized.match(sig.regex);
    if (m) gradedSignals.push(`${sig.label} ("${m[0]}")`);
  }
  if (gradedSignals.length) {
    return {
      scope: 'ASSESSMENT_RESTRICTED',
      evidence: `Phát hiện dấu hiệu bài kiểm tra/thi tính điểm: ${gradedSignals.join('; ')}`
    };
  }
  const practiceMatch = normalized.match(PRACTICE_LABEL_REGEX);
  const ungradedMatch = normalized.match(UNGRADED_EVIDENCE_REGEX);
  if (practiceMatch && ungradedMatch) {
    return {
      scope: 'PRACTICE_VERIFIED',
      evidence: `Xác minh phạm vi tự luyện: nhãn ("${practiceMatch[0]}") + xác nhận không tính điểm ("${ungradedMatch[0]}") + không có tín hiệu chấm điểm xung đột`
    };
  }
  if (practiceMatch) {
    return {
      scope: 'UNKNOWN_SCOPE',
      evidence: `Chỉ có nhãn "${practiceMatch[0]}" nhưng thiếu xác nhận rõ ràng rằng hoạt động không tính điểm (tên hoạt động không đủ làm bằng chứng)`
    };
  }
  return {
    scope: 'UNKNOWN_SCOPE',
    evidence: 'Không có nhãn tự luyện (practice/self-practice/tự luyện) kèm xác nhận không tính điểm rõ ràng trên hoạt động'
  };
}

/** Inspects a quiz overview/launch page without clicking or mutating any control. */
export async function inspectQuizLaunchSurface(
  page: Page,
  hosts: readonly string[],
  taskTitle = '',
  originOptions?: OriginTrustOptions
): Promise<QuizLaunchSurfaceInspection> {
  let hasContinueAttemptControl = false;
  let continueLabel: string | undefined;
  let hasNewAttemptControl = false;
  let newAttemptLabel: string | undefined;
  let hasStartAttemptForm = false;
  const textParts: string[] = [taskTitle, await page.title().catch(() => '')];

  for (const frame of readableFrames(page, hosts, originOptions)) {
    const bodyText = await frame
      .evaluate(() => {
        const headingText = Array.from(document.querySelectorAll('h1, h2, h3, .page-header-headings, .quizinfo'))
          .map(el => (el.textContent || '').trim())
          .join(' ');
        const body = (document.body?.innerText || '').slice(0, 12000);
        return `${headingText}\n${body}`;
      })
      .catch(() => '');
    textParts.push(bodyText);

    if (!hasContinueAttemptControl) {
      for (const role of ['button', 'link'] as const) {
        const loc = frame.getByRole(role, { name: CONTINUE_ATTEMPT_PATTERN });
        if ((await loc.count().catch(() => 0)) === 1) {
          hasContinueAttemptControl = true;
          continueLabel =
            ((await loc.innerText().catch(() => '')) ||
              (await loc.getAttribute('value').catch(() => '')) ||
              'Continue attempt').trim();
          break;
        }
      }
    }

    if (!hasNewAttemptControl) {
      for (const role of ['button', 'link'] as const) {
        const loc = frame.getByRole(role, { name: NEW_ATTEMPT_PATTERN });
        if ((await loc.count().catch(() => 0)) === 1) {
          hasNewAttemptControl = true;
          newAttemptLabel =
            ((await loc.innerText().catch(() => '')) ||
              (await loc.getAttribute('value').catch(() => '')) ||
              'Attempt quiz now').trim();
          break;
        }
      }
    }

    const startFormCount = await frame
      .locator('form[action*="startattempt.php"]')
      .count()
      .catch(() => 0);
    if (startFormCount > 0) {
      hasStartAttemptForm = true;
      if (!hasNewAttemptControl) {
        const submitBtn = frame.locator('form[action*="startattempt.php"] button[type="submit"], form[action*="startattempt.php"] input[type="submit"]');
        if ((await submitBtn.count().catch(() => 0)) === 1) {
          hasNewAttemptControl = true;
          newAttemptLabel =
            ((await submitBtn.innerText().catch(() => '')) ||
              (await submitBtn.getAttribute('value').catch(() => '')) ||
              'startattempt.php').trim();
        }
      }
    }
  }

  const combinedText = textParts.join('\n');
  let exhaustedAttempts = false;
  let exhaustedReason: string | undefined;

  const exhMatch = combinedText.match(EXHAUSTED_ATTEMPTS_REGEX);
  if (exhMatch) {
    exhaustedAttempts = true;
    exhaustedReason = `Hoạt động không còn lượt làm bài ("${exhMatch[0]}")`;
  } else if (
    /attempts\s+allowed\s*:\s*1\b|số\s+lần\s+làm\s+bài\s*(?:cho\s+phép)?\s*:\s*1\b/i.test(combinedText) &&
    /\b(state|status|trạng\s+thái)\b[\s\S]{0,180}\b(finished|submitted|đã\s+nộp|hoàn\s+thành)\b/i.test(combinedText) &&
    !hasContinueAttemptControl
  ) {
    exhaustedAttempts = true;
    exhaustedReason = 'Giới hạn 1 lượt làm bài và lượt duy nhất đã ở trạng thái Finished/Submitted';
  }

  const { scope, evidence } = classifyActivityScope(combinedText);

  return {
    hasContinueAttemptControl,
    continueLabel,
    hasNewAttemptControl,
    newAttemptLabel,
    hasStartAttemptForm,
    exhaustedAttempts,
    exhaustedReason,
    scope,
    scopeEvidence: evidence
  };
}

/** In-process ledger of non-interactive start grants already consumed, keyed by `(taskId, origin+pathname)`.
 *  A stored `task.confirmStartNewAttempt=true` can open AT MOST ONE attempt per task/URL per process; it is never a blanket, permanent right. */
/** In-process ledger of non-interactive start grants already consumed, keyed by `(taskId, origin+pathname)`.
 *  A stored `task.confirmStartNewAttempt=true` can open AT MOST ONE attempt per task/URL per process; it is never a blanket, permanent right. */
const consumedStartGrants = new Set<string>();

let customLedgerFilePath: string | null = null;

/** Sets an explicit custom path for the durable grant ledger (used for test isolation). */
export function setDurableLedgerPath(customPath: string | null): void {
  customLedgerFilePath = customPath;
}

/** Resolves the authoritative path to the durable grant ledger.
 *  Priority:
 *  1. Custom injected path via setDurableLedgerPath()
 *  2. Environment variable AUTOTASK_LEDGER_PATH
 *  3. Default workspace file .private/durable-start-grants.json
 *  NEVER falls back to a shared system-wide temp path.
 */
export function getDurableLedgerPath(): string {
  if (customLedgerFilePath) {
    return path.resolve(customLedgerFilePath);
  }
  if (process.env.AUTOTASK_LEDGER_PATH) {
    return path.resolve(process.env.AUTOTASK_LEDGER_PATH);
  }
  return path.resolve('.private', 'durable-start-grants.json');
}

export interface DurableGrantRecord {
  taskId: string;
  grantKey: string;
  consumedAt: string;
  pid: number;
}

export type ReadDurableGrantsResult =
  | { status: 'OK'; grants: Record<string, DurableGrantRecord> }
  | { status: 'NOT_FOUND'; grants: Record<string, DurableGrantRecord> }
  | { status: 'ERROR'; error: 'READ_FAILED' | 'IS_DIRECTORY' | 'CORRUPT_EMPTY' | 'CORRUPT_JSON' | 'INVALID_SCHEMA'; details: string };

/** Reads and strictly validates the durable grant ledger.
 *  Fail-closed rule: UNKNOWN STORAGE STATE = ERROR (never treated as empty).
 */
export function readDurableGrants(): ReadDurableGrantsResult {
  const filePath = getDurableLedgerPath();
  if (!fs.existsSync(filePath)) {
    return { status: 'NOT_FOUND', grants: {} };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (err: any) {
    return { status: 'ERROR', error: 'READ_FAILED', details: `Failed to stat ledger file: ${err?.message || String(err)}` };
  }

  if (st.isDirectory()) {
    return { status: 'ERROR', error: 'IS_DIRECTORY', details: `Ledger path is a directory (EISDIR): ${filePath}` };
  }

  if (st.size === 0) {
    return { status: 'ERROR', error: 'CORRUPT_EMPTY', details: `Ledger file is abnormally empty (0 bytes): ${filePath}` };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    return { status: 'ERROR', error: 'READ_FAILED', details: `Failed to read ledger file: ${err?.message || String(err)}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return { status: 'ERROR', error: 'CORRUPT_JSON', details: `Malformed JSON in ledger: ${err?.message || String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'ERROR', error: 'INVALID_SCHEMA', details: 'Root of ledger JSON is not a plain object' };
  }

  const grantsMap: Record<string, any> = (parsed.grants && typeof parsed.grants === 'object' && !Array.isArray(parsed.grants))
    ? parsed.grants
    : parsed;

  for (const [key, val] of Object.entries(grantsMap)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      return { status: 'ERROR', error: 'INVALID_SCHEMA', details: `Grant entry '${key}' is not an object` };
    }
    const rec = val as Record<string, any>;
    if (typeof rec.taskId !== 'string' || rec.taskId.trim().length === 0) {
      return { status: 'ERROR', error: 'INVALID_SCHEMA', details: `Grant entry '${key}' missing required non-empty string taskId` };
    }
    if (typeof rec.grantKey !== 'string' || rec.grantKey !== key) {
      return { status: 'ERROR', error: 'INVALID_SCHEMA', details: `Grant entry '${key}' missing valid grantKey or does not match map key` };
    }
    if (typeof rec.consumedAt !== 'string' || isNaN(Date.parse(rec.consumedAt))) {
      return { status: 'ERROR', error: 'INVALID_SCHEMA', details: `Grant entry '${key}' missing valid ISO consumedAt string` };
    }
    if (rec.pid !== undefined && (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0)) {
      return { status: 'ERROR', error: 'INVALID_SCHEMA', details: `Grant entry '${key}' has invalid pid (must be positive integer)` };
    }
    // Safe legacy migration: backfill legacy records missing PID without dropping historical consent
    if (rec.pid === undefined) {
      rec.pid = 0;
    }
  }

  return { status: 'OK', grants: grantsMap as Record<string, DurableGrantRecord> };
}

/** Checks whether an OS process is alive without signaling side effects. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      return false; // Process does not exist
    }
    // EPERM or other errors mean process exists but permissions restrict signaling (still alive)
    return true;
  }
}

export interface ClaimGrantResult {
  success: boolean;
  reason?: 'ALREADY_CONSUMED' | 'STORAGE_ERROR';
  details?: string;
}

/** Atomically claims a start grant in the durable on-disk ledger.
 *  Uses Windows-safe lockfile with retries, writes to temp file, fsyncs to physical disk, and atomically commits.
 */
export function claimDurableGrant(grantKey: string, taskId: string): ClaimGrantResult {
  if (consumedStartGrants.has(grantKey)) {
    return { success: false, reason: 'ALREADY_CONSUMED', details: 'Grant already consumed in-process' };
  }

  const filePath = getDurableLedgerPath();
  const dir = path.dirname(filePath);

  // Verify parent directory
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err: any) {
    return { success: false, reason: 'STORAGE_ERROR', details: `Cannot create ledger directory: ${err?.message || String(err)}` };
  }

  if (fs.existsSync(filePath)) {
    try {
      const st = fs.statSync(filePath);
      if (st.isDirectory()) {
        return { success: false, reason: 'STORAGE_ERROR', details: `Target ledger path is a directory (EISDIR): ${filePath}` };
      }
    } catch (err: any) {
      return { success: false, reason: 'STORAGE_ERROR', details: `Stat failure on ledger: ${err?.message || String(err)}` };
    }
  }

  const lockPath = filePath + '.lock';
  let lockAcquired = false;
  const maxRetries = 25;
  const retryDelayMs = 20;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, time: Date.now() }));
      fs.closeSync(lockFd);
      lockAcquired = true;
      break;
    } catch (lockErr: any) {
      if (lockErr.code === 'EEXIST') {
        let isStaleDeadOwner = false;
        try {
          const lockStat = fs.statSync(lockPath);
          const ageMs = Date.now() - lockStat.mtimeMs;
          if (ageMs > 5000) {
            let lockData: any = null;
            try {
              const lockRaw = fs.readFileSync(lockPath, 'utf-8');
              lockData = JSON.parse(lockRaw);
            } catch {}

            // CRITICAL (LOCK-01): NEVER delete or steal a lock if the owner process is still alive!
            if (lockData && typeof lockData.pid === 'number') {
              if (!isProcessAlive(lockData.pid)) {
                // Owner process has definitely terminated/crashed AND lock is > 5s old
                isStaleDeadOwner = true;
              }
            } else if (ageMs > 10000) {
              // Unparseable corrupt lock older than 10s
              isStaleDeadOwner = true;
            }
          }
        } catch {}

        if (isStaleDeadOwner) {
          try { fs.unlinkSync(lockPath); } catch {}
        }

        // Non-spinning wait using Atomics.wait
        const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sleepBuf, 0, 0, retryDelayMs);
      } else {
        return { success: false, reason: 'STORAGE_ERROR', details: `Lock error: ${lockErr?.message || String(lockErr)}` };
      }
    }
  }

  if (!lockAcquired) {
    return { success: false, reason: 'STORAGE_ERROR', details: `Could not acquire lockfile: ${lockPath}` };
  }

  let tmpPath: string | null = null;
  try {
    const currentRead = readDurableGrants();
    if (currentRead.status === 'ERROR') {
      return { success: false, reason: 'STORAGE_ERROR', details: currentRead.details };
    }

    if (currentRead.grants[grantKey]) {
      consumedStartGrants.add(grantKey);
      return { success: false, reason: 'ALREADY_CONSUMED', details: `Grant '${grantKey}' already recorded on disk` };
    }

    // Prune stale local E2E test records (127.0.0.1 / localhost from dead PIDs or > 10m old) so the ledger stays compact
    const nowMs = Date.now();
    for (const [k, rec] of Object.entries(currentRead.grants)) {
      if (/^[^|]+\|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(k)) {
        const ageMs = nowMs - Date.parse(rec.consumedAt);
        if ((rec.pid > 0 && !isProcessAlive(rec.pid)) || ageMs > 10 * 60 * 1000) {
          delete currentRead.grants[k];
        }
      }
    }

    currentRead.grants[grantKey] = {
      taskId,
      grantKey,
      consumedAt: new Date().toISOString(),
      pid: process.pid
    };

    tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tmpPath, 'w');
    const payload = JSON.stringify(currentRead.grants, null, 2);
    fs.writeSync(fd, payload, 0, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    let renameSuccess = false;
    let renameErr: any = null;
    for (let r = 0; r < 5; r++) {
      try {
        fs.renameSync(tmpPath, filePath);
        renameSuccess = true;
        break;
      } catch (err: any) {
        renameErr = err;
        const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sleepBuf, 0, 0, 10);
      }
    }

    if (!renameSuccess) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      return {
        success: false,
        reason: 'STORAGE_ERROR',
        details: `Atomic rename failed (fail-closed, no unsafe in-place copy fallback): ${renameErr?.message || String(renameErr)}`
      };
    }

    consumedStartGrants.add(grantKey);
    return { success: true };
  } catch (err: any) {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return { success: false, reason: 'STORAGE_ERROR', details: `Atomic write failed: ${err?.message || String(err)}` };
  } finally {
    if (lockAcquired) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

/** Legacy / helper alias: returns boolean indicating write success. */
export function writeDurableGrant(grantKey: string, taskId: string): boolean {
  return claimDurableGrant(grantKey, taskId).success;
}

/** Explicitly clears the durable grant ledger file on disk (for test cleanup only). */
export function clearDurableGrantLedger(): void {
  const filePath = getDurableLedgerPath();
  try {
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      if (!st.isDirectory()) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

/** Test / operator helper: forget in-process start grants.
 *  CRITICAL SECURITY RULE (LEDGER-03): MUST NEVER delete durable on-disk grant file!
 */
export function resetStartGrantLedger(): void {
  consumedStartGrants.clear();
}

export function startGrantKey(taskId: string, rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${taskId}|${u.origin.toLowerCase()}${u.pathname}`;
  } catch {
    return `${taskId}|${rawUrl}`;
  }
}

/** Evaluates all mandatory pre-start safety checks before any quiz launch button may be clicked.
 *  The effective mode ALWAYS comes from the shared restriction-lattice resolver: a task can restrict but never expand the global mode. */
export async function evaluateQuizStartPolicy(args: {
  page: Page;
  task: Task;
  config: AppConfig;
  platform: string;
  inspection: QuizLaunchSurfaceInspection;
}): Promise<QuizStartDecision> {
  const { page, task, config, platform, inspection } = args;
  const originOpts = originTrustFromConfig(config);
  const effectiveMode: LmsOperationMode | undefined = resolveEffectiveOperationMode(config, task);

  // 1. Strict origin & task target match
  try {
    const liveUrl = ensureAllowed(page.url(), config.allowedHosts, originOpts);
    const targetUrl = ensureAllowed(task.url, config.allowedHosts, originOpts);
    if (liveUrl.origin.toLowerCase() !== targetUrl.origin.toLowerCase()) {
      return {
        action: 'HALT_NEEDS_REVIEW',
        code: 'ORIGIN_TASK_MISMATCH',
        reason: `Origin trang hiện tại (${liveUrl.origin}) không khớp origin của task (${targetUrl.origin})`
      };
    }
  } catch (err) {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'ORIGIN_TASK_MISMATCH',
      reason: err instanceof Error ? err.message : String(err)
    };
  }

  // 2. READ_ONLY mode (global or task) never starts or continues any quiz attempt
  if (effectiveMode === 'READ_ONLY') {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'READ_ONLY_MODE',
      reason: '[READ_ONLY] Chế độ chỉ đọc: chỉ quan sát metadata/điểm/hạn nộp, không mở hoặc điền bài làm'
    };
  }

  // 3. Explicit ASSESSMENT_RESTRICTED mode or graded exam DOM indicators ALWAYS block
  if (effectiveMode === 'ASSESSMENT_RESTRICTED' || inspection.scope === 'ASSESSMENT_RESTRICTED') {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'ASSESSMENT_RESTRICTED_SCOPE',
      reason: `[ASSESSMENT_RESTRICTED] Đã chặn tự động mở bài kiểm tra/thi tính điểm: ${inspection.scopeEvidence}`
    };
  }

  // 4. Exhausted attempts check
  if (inspection.exhaustedAttempts && !inspection.hasContinueAttemptControl) {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'ATTEMPTS_EXHAUSTED',
      reason: inspection.exhaustedReason || 'Hoạt động đã hết lượt làm bài cho phép'
    };
  }

  // 5. Already-open attempt (`Continue the last attempt`) is NOT harmless: it may be a graded/timed/limited-attempt exam.
  //    Fail closed unless effective mode is PRACTICE_ASSISTED AND scope is verified self-practice with zero conflicting signals.
  //    Never starts a replacement attempt.
  if (inspection.hasContinueAttemptControl) {
    if (effectiveMode !== 'PRACTICE_ASSISTED') {
      return {
        action: 'HALT_NEEDS_REVIEW',
        code: 'MODE_NOT_PRACTICE_ASSISTED',
        reason: `Chặn tiếp tục lượt đang mở (\"${inspection.continueLabel || 'Continue'}\"): cần mode=\"PRACTICE_ASSISTED\" tường minh (mode hiệu lực: ${effectiveMode ?? 'chưa đặt'})`
      };
    }
    if (inspection.scope !== 'PRACTICE_VERIFIED') {
      return {
        action: 'HALT_NEEDS_REVIEW',
        code: 'UNKNOWN_PRACTICE_SCOPE',
        reason: `Chặn tiếp tục lượt đang mở (\"${inspection.continueLabel || 'Continue'}\"): chưa đủ bằng chứng bài tự luyện (${inspection.scopeEvidence}); chuyển NEEDS_REVIEW, không tạo lượt mới thay thế`
      };
    }
    return {
      action: 'CONTINUE_EXISTING_ATTEMPT',
      code: 'ALLOWED_CONTINUE_OPEN_ATTEMPT',
      reason: `Tiếp tục lượt tự luyện đang mở sẵn (\"${inspection.continueLabel || 'Continue'}\") đã xác minh phạm vi tự luyện, không tạo lượt mới`
    };
  }

  // 6. No launch control on page
  if (!inspection.hasNewAttemptControl && !inspection.hasStartAttemptForm) {
    return {
      action: 'NO_LAUNCH_CONTROL',
      code: 'NO_LAUNCH_CONTROL',
      reason: 'Trang không có nút bắt đầu lượt làm bài mới'
    };
  }

  // 7. Starting a NEW attempt:
  //    a) Effective mode MUST explicitly be `PRACTICE_ASSISTED` (default undefined mode NEVER auto-starts!)
  if (effectiveMode !== 'PRACTICE_ASSISTED') {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'MODE_NOT_PRACTICE_ASSISTED',
      reason:
        `Chặn tự động bấm \"${inspection.newAttemptLabel || 'Attempt quiz now'}\": mở lượt mới bắt buộc khai báo mode=\"PRACTICE_ASSISTED\" (approvedForAIUse/aiPermitted một mình không đủ)`
    };
  }

  //    b) Activity scope MUST be verified self-practice (never start when scope is UNKNOWN)
  if (inspection.scope !== 'PRACTICE_VERIFIED') {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'UNKNOWN_PRACTICE_SCOPE',
      reason:
        `Chặn tự động bấm \"${inspection.newAttemptLabel || 'Attempt quiz now'}\": chưa đủ bằng chứng bài tự luyện (${inspection.scopeEvidence}); chuyển sang NEEDS_REVIEW`
    };
  }

  //    c) Fresh, separate consent for creating THIS new attempt.
  //       A live interactive callback ALWAYS wins: its answer is requested every time and a denial can never be
  //       overridden by a stored `task.confirmStartNewAttempt=true`.
  const grantKey = startGrantKey(task.id, page.url());
  let confirmed = false;
  let consentDetail = '';
  if (typeof config.confirmAttemptStart === 'function') {
    confirmed = Boolean(
      await config.confirmAttemptStart({
        taskId: task.id,
        url: page.url(),
        title: (await page.title().catch(() => '')) || task.title || task.id,
        buttonLabel: inspection.newAttemptLabel || 'Attempt quiz now',
        platform
      })
    );
    if (!confirmed) consentDetail = ' (người dùng từ chối ở phiên hiện tại; cờ confirmStartNewAttempt lưu sẵn không được dùng để ghi đè)';
  } else if (task.confirmStartNewAttempt === true) {
    confirmed = true;
  }

  if (!confirmed) {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'AWAITING_START_CONFIRMATION',
      reason:
        `AWAITING_START_CONFIRMATION: Bài tự luyện "${task.title || task.id}" yêu cầu xác nhận riêng biệt (xác nhận START tương tác hoặc confirmStartNewAttempt=true khi chạy không tương tác) trước khi tạo lượt làm bài mới ("${inspection.newAttemptLabel || 'Attempt quiz now'}")${consentDetail}`
    };
  }

  // Pre-claim ledger inspection (fail-closed on corrupt/unreadable ledger):
  // BOTH interactive and non-interactive paths MUST verify ledger integrity before granting start.
  const ledgerRead = readDurableGrants();
  if (ledgerRead.status === 'ERROR') {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'AWAITING_START_CONFIRMATION',
      reason: `Lỗi bảo mật lưu trữ (fail-closed): Không thể xác minh tính toàn vẹn của sổ cái xác nhận (${ledgerRead.details}). Chặn mở lượt mới để đảm bảo an toàn.`
    };
  }

  const isDurableConsumed = Boolean(ledgerRead.grants[grantKey]);
  if (consumedStartGrants.has(grantKey) || isDurableConsumed) {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'AWAITING_START_CONFIRMATION',
      reason: `AWAITING_START_CONFIRMATION: Quyền mở lượt làm bài cho task/URL này đã được tiêu thụ trước đó (${grantKey}). Cần cấp quyền mới cho lượt tiếp theo.`
    };
  }

  // Atomically claim the grant in the durable ledger for ALL paths (interactive callback & non-interactive flag)
  const claimRes = claimDurableGrant(grantKey, task.id);
  if (!claimRes.success) {
    return {
      action: 'HALT_NEEDS_REVIEW',
      code: 'AWAITING_START_CONFIRMATION',
      reason: `Không thể cấp quyền mở lượt mới (fail-closed): ${claimRes.details || 'Lỗi ghi sổ cái bền vững'}`
    };
  }

  (task as any).confirmStartNewAttempt = false; // single-use grant consumed immediately
  (task as any).startGrantConsumed = true;
  (task as any).consumedGrantKey = grantKey;
  (task as any).consumedGrantAt = new Date().toISOString();

  return {
    action: 'START_NEW_ATTEMPT',
    code: 'ALLOWED_NEW_PRACTICE_ATTEMPT',
    reason: `Đã xác minh đủ điều kiện PRACTICE_ASSISTED + phạm vi tự luyện + xác nhận mở lượt mới ("${inspection.newAttemptLabel || 'Attempt quiz now'}")`
  };
}

export interface AttemptGateDecision {
  allowed: boolean;
  code:
    | 'ALLOWED_POLICY_CLEARED'
    | 'ALLOWED_CHECKPOINT_SCOPE'
    | 'ALLOWED_OPERATOR_ATTESTATION'
    | 'ALLOWED_PAGE_SCOPE'
    | 'ALLOWED_NON_MOODLE_PLATFORM'
    | 'READ_ONLY_MODE'
    | 'ASSESSMENT_RESTRICTED_SCOPE'
    | 'MODE_NOT_PRACTICE_ASSISTED'
    | 'UNKNOWN_PRACTICE_SCOPE'
    | 'ORIGIN_TASK_MISMATCH'
    | 'ATTEMPT_FINISHED';
  reason: string;
}

/** Unified pre-solve gate. EVERY path into `scanQuestions -> solveQuestions -> fillAnswer` must pass through it:
 *  direct `/mod/quiz/attempt.php` URLs, checkpoint resume, Task Queue retries and Auto Discovery tasks.
 *
 *  - `policyCleared`: the attempt was reached through `evaluateQuizStartPolicy` in this very execution.
 *  - Moodle: requires effective `PRACTICE_ASSISTED`, no graded signal anywhere on the live page, and ONE of
 *    (a) valid checkpoint carrying `scopeVerified` for the same origin, (b) operator `task.scopeAttestation`, (c) live page itself verifies ungraded self-practice.
 *  - Other platforms (FAMI / English Discoveries / generic): READ_ONLY and ASSESSMENT_RESTRICTED are enforced earlier; no extra scope proof is demanded
 *    (documented limitation: scope there relies on operator mode + header classification, not on Moodle gradebook metadata).
 */
export async function evaluateAttemptExecutionGate(args: {
  page: Page;
  task: Task;
  config: AppConfig;
  platform: string;
  checkpoint?: TaskCheckpoint | null;
  policyCleared: boolean;
}): Promise<AttemptGateDecision> {
  const { page, task, config, platform, checkpoint, policyCleared } = args;
  const effectiveMode = resolveEffectiveOperationMode(config, task);

  // 1. Strict Mode Lattice & Fail-Closed Enforcement (Phase 3, FOLLOWUP-03)
  if (effectiveMode === 'READ_ONLY') {
    return { allowed: false, code: 'READ_ONLY_MODE', reason: '[READ_ONLY] Không được giải hoặc điền câu hỏi ở chế độ chỉ đọc' };
  }
  if (effectiveMode === 'ASSESSMENT_RESTRICTED') {
    return { allowed: false, code: 'ASSESSMENT_RESTRICTED_SCOPE', reason: '[ASSESSMENT_RESTRICTED] Không được giải hoặc điền câu hỏi ở chế độ bài đánh giá hạn chế' };
  }
  if (effectiveMode !== 'PRACTICE_ASSISTED') {
    return {
      allowed: false,
      code: 'MODE_NOT_PRACTICE_ASSISTED',
      reason: `Chặn giải/điền trên nền tảng ${platform}: cần mode="PRACTICE_ASSISTED" tường minh (mode hiệu lực: ${effectiveMode ?? 'chưa đặt'})`
    };
  }

  // 2. Current Page URL & Identity
  let currentUrl = '';
  let currentPath = '';
  let pageOrigin = '';
  try {
    const parsed = new URL(page.url());
    currentUrl = page.url();
    currentPath = parsed.pathname;
    pageOrigin = parsed.origin.toLowerCase();
  } catch {
    currentUrl = page.url();
    currentPath = '';
    pageOrigin = '';
  }

  // 3. Inspect Live DOM on EVERY navigation/call (Phase 1, FOLLOWUP-01)
  const pageText: string = await page
    .evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h1, h2, h3, .page-header-headings, .quizinfo, .quizgradefeedback, .grading-summary'))
        .map(el => (el.textContent || '').trim())
        .join(' ');
      return `${document.title}\n${heads}\n${(document.body?.innerText || '').slice(0, 12000)}`;
    })
    .catch(() => '');

  // 4. Check if attempt is finished/submitted
  if (/\/mod\/quiz\/review\.php$/i.test(currentPath) || /^\s*state\s*:?\s*(?:finished|submitted)\b/im.test(pageText)) {
    return { allowed: false, code: 'ATTEMPT_FINISHED', reason: 'Lượt làm bài đã kết thúc/được nộp; không điền hoặc tạo lượt thay thế (NEEDS_REVIEW)' };
  }

  // 5. Live Graded/Restricted Assessment Signals ALWAYS override any prior clearance (Phase 1, FOLLOWUP-01)
  const liveScope = classifyActivityScope(`${task.title || ''} ${pageText}`);
  if (liveScope.scope === 'ASSESSMENT_RESTRICTED') {
    return {
      allowed: false,
      code: 'ASSESSMENT_RESTRICTED_SCOPE',
      reason: `[ASSESSMENT_RESTRICTED] Phạm vi trang đã đổi hoặc phát hiện bài kiểm tra tính điểm trên DOM hiện tại: ${liveScope.evidence}`
    };
  }

  // 6. Identity Binding (Phase 2, FOLLOWUP-02)
  const taskIdentity = extractQuizActivityIdentity(task.url);
  const pageIdentity = extractQuizActivityIdentity(currentUrl);

  if (pageOrigin && taskIdentity.origin && pageOrigin !== taskIdentity.origin) {
    return {
      allowed: false,
      code: 'ORIGIN_TASK_MISMATCH',
      reason: `Origin trang hiện tại (${pageOrigin}) không khớp với task (${taskIdentity.origin})`
    };
  }

  const verifiedId: VerifiedAttemptIdentity | undefined =
    task.verifiedAttemptIdentity ||
    (checkpoint?.scopeVerified
      ? {
          canonicalOrigin: checkpoint.scopeVerified.origin,
          pathname: checkpoint.scopeVerified.pathname,
          cmid: checkpoint.scopeVerified.cmid,
          quizId: checkpoint.scopeVerified.quizId,
          attemptId: checkpoint.scopeVerified.attemptId,
          taskId: checkpoint.taskId
        }
      : undefined);

  // AUD-F2-02: Switching attemptId invalidates prior clearance
  if (pageIdentity.attemptId && verifiedId?.attemptId && pageIdentity.attemptId !== verifiedId.attemptId) {
    return {
      allowed: false,
      code: 'UNKNOWN_PRACTICE_SCOPE',
      reason: `Chặn do attempt ID thay đổi bất thường: trang hiện tại mang attemptId=${pageIdentity.attemptId}, khác với lượt làm đã xác minh (${verifiedId.attemptId})`,
    };
  }

  // 7. Policy Cleared on Overview in this run (Phase 1, AUD-F2-01)
  if (policyCleared) {
    if (pageIdentity.attemptId) {
      if (!pageIdentity.cmid) {
        // Attempt URL lacks cmid: requires verified identity or checkpoint binding to this attempt
        const hasVerifiedBinding = Boolean(
          (verifiedId?.attemptId && verifiedId.attemptId === pageIdentity.attemptId) ||
          (checkpoint?.scopeVerified?.attemptId && checkpoint.scopeVerified.attemptId === pageIdentity.attemptId)
        );
        if (!hasVerifiedBinding) {
          return {
            allowed: false,
            code: 'UNKNOWN_PRACTICE_SCOPE',
            reason: `Trang attempt (${pageIdentity.attemptId}) không có cmid và chưa có bằng chứng xác minh liên kết với quiz đã duyệt (${taskIdentity.cmid || "unknown"}); dừng an toàn để review (AUD-F2-01)`,
          };
        }
      } else if (taskIdentity.cmid && pageIdentity.cmid !== taskIdentity.cmid) {
        return {
          allowed: false,
          code: 'UNKNOWN_PRACTICE_SCOPE',
        reason: `Quiz ID/cmid trên trang (${pageIdentity.cmid}) không khớp với task đã duyệt (${taskIdentity.cmid})`,
        };
      }
    } else if (taskIdentity.cmid && pageIdentity.cmid && taskIdentity.cmid !== pageIdentity.cmid) {
      return {
        allowed: false,
        code: 'UNKNOWN_PRACTICE_SCOPE',
        reason: `Quiz ID/cmid trên trang (${pageIdentity.cmid}) không khớp với task đã duyệt (${taskIdentity.cmid})`,
      };
    }

    if (pageIdentity.attemptId && !task.verifiedAttemptIdentity) {
      task.verifiedAttemptIdentity = {
        canonicalOrigin: pageOrigin,
        pathname: pageIdentity.pathname,
        cmid: pageIdentity.cmid || taskIdentity.cmid,
        attemptId: pageIdentity.attemptId,
        taskId: task.id,
        verifiedAt: new Date().toISOString()
      };
    }

    return { allowed: true, code: 'ALLOWED_POLICY_CLEARED', reason: 'Đã qua QuizStartPolicy trong lần thực thi này và DOM hiện tại không có tín hiệu tính điểm' };
  }

  // 8. Non-Moodle platforms with PRACTICE_ASSISTED mode verified
  if (platform !== 'moodle') {
    return { allowed: true, code: 'ALLOWED_NON_MOODLE_PLATFORM', reason: `Nền tảng ${platform}: đã xác nhận mode PRACTICE_ASSISTED` };
  }

  // 9. Checkpoint Scope & Activity Identity Binding (Phase 2, FOLLOWUP-02)
  if (checkpoint?.scopeVerified && checkpoint.scopeVerified.scope === 'PRACTICE_VERIFIED') {
    const cpScope = checkpoint.scopeVerified;
    const cpOrigin = (cpScope.origin || '').toLowerCase();
    if (cpOrigin === pageOrigin && checkpoint.taskId === task.id) {
      const cpCmid = cpScope.cmid || extractQuizActivityIdentity(checkpoint.url).cmid;
      const cpAttemptId = cpScope.attemptId || extractQuizActivityIdentity(checkpoint.url).attemptId;

      // When current page is a specific attempt URL (/mod/quiz/attempt.php?attempt=XYZ):
      if (pageIdentity.attemptId) {
        if (cpAttemptId && cpAttemptId === pageIdentity.attemptId) {
          return {
            allowed: true,
            code: 'ALLOWED_CHECKPOINT_SCOPE',
            reason: `Checkpoint hợp lệ gắn kết đúng attempt (${cpAttemptId}) và cùng origin; DOM không có tín hiệu tính điểm`
          };
        }
        // Checkpoint does not bind to this attempt ID => cannot authorize!
      } else if (cpCmid && pageIdentity.cmid && cpCmid === pageIdentity.cmid) {
        return {
          allowed: true,
          code: 'ALLOWED_CHECKPOINT_SCOPE',
          reason: `Checkpoint hợp lệ gắn kết đúng cmid (${cpCmid}) và cùng origin; DOM không có tín hiệu tính điểm`
        };
      }
    }
  }

  // 10. Operator Attestation
  if (task.scopeAttestation === 'PERMITTED_SELF_PRACTICE') {
    return { allowed: true, code: 'ALLOWED_OPERATOR_ATTESTATION', reason: 'Người vận hành khai báo tường minh bài tự luyện được phép; DOM hiện tại không có tín hiệu tính điểm' };
  }

  // 11. Live Page Verification
  if (liveScope.scope === 'PRACTICE_VERIFIED') {
    return { allowed: true, code: 'ALLOWED_PAGE_SCOPE', reason: liveScope.evidence };
  }

  return {
    allowed: false,
    code: 'UNKNOWN_PRACTICE_SCOPE',
    reason: `Chặn giải/điền trên URL làm bài trực tiếp: chưa có bằng chứng bài tự luyện gắn kết (checkpoint không khớp attempt/quiz, không có scopeAttestation, trang không tự xác minh): ${liveScope.evidence}`
  };
}
