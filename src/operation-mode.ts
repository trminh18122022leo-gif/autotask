/** Shared operation-mode resolver and state-mutating URL detector (Pilot-Gate Phase 2 / Phase 5).
 *
 * Restriction lattice (most restrictive first):  READ_ONLY  >  ASSESSMENT_RESTRICTED  >  PRACTICE_ASSISTED  >  (unset)
 * A task may only RESTRICT the global mode, NEVER expand it. Every entrypoint (Browser Agent, QuizStartPolicy,
 * Resume Coordinator, Task Queue, Auto Discovery) must call `resolveEffectiveOperationMode()` instead of `task.mode ?? config.operationMode`.
 */
import type { AppConfig, LmsOperationMode, Task } from './types.js';

const RESTRICTION_RANK: Record<LmsOperationMode, number> = {
  READ_ONLY: 3,
  ASSESSMENT_RESTRICTED: 2,
  PRACTICE_ASSISTED: 1
};

/** Rank of a mode in the restriction lattice (higher = more restrictive; unset = 0). */
export function restrictionRank(mode: LmsOperationMode | undefined): number {
  return mode ? RESTRICTION_RANK[mode] ?? 3 : 0;
}

/** Returns the most restrictive of the global and task modes. Unknown values fail closed to READ_ONLY. */
export function resolveEffectiveOperationMode(
  config: Pick<AppConfig, 'operationMode'> | undefined,
  task?: Pick<Task, 'mode'> | undefined
): LmsOperationMode | undefined {
  const candidates = [config?.operationMode, task?.mode];
  let best: LmsOperationMode | undefined;
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const mode: LmsOperationMode = raw in RESTRICTION_RANK ? raw : 'READ_ONLY';
    if (restrictionRank(mode) > restrictionRank(best)) best = mode;
  }
  return best;
}

/** True when `taskMode` would expand permissions beyond `globalMode` (e.g. global READ_ONLY + task PRACTICE_ASSISTED). */
export function isModeEscalation(globalMode: LmsOperationMode | undefined, taskMode: LmsOperationMode | undefined): boolean {
  if (!globalMode || !taskMode) return false;
  return restrictionRank(taskMode) < restrictionRank(globalMode);
}

const MUTATING_PATH_REGEX =
  /\/(?:mod\/quiz\/(?:startattempt|processattempt|finishattempt|autosave)\.php|login\/logout\.php|mod\/assign\/(?:submit|editsubmission)\.php|course\/(?:enrol|unenrol)\.php|enrol\/[^/]+\/unenrolself\.php|user\/(?:editadvanced|edit)\.php|lib\/ajax\/service\.php|grade\/edit\/(?:tree\/action|tree\/grade)\.php|mod\/forum\/(?:post|delete)\.php|admin\/cron\.php)(?:$|[/?#])/i;

const MUTATING_QUERY_REGEX =
  /(?:^|[?&])(?:delete|unenrol|unenrolself|confirm|finishattempt|savechanges|submit)=|(?:^|[?&])action=(?:delete|submit|finish|enrol|unenrol|start|startattempt|save|remove|confirm|mutate|update|clear|reset)(?:&|$)/i;

/** Allowlist of verified read-only Moodle AJAX services safe for READ_ONLY mode. */
export const SAFE_READ_ONLY_AJAX_METHODS = new Set([
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_course_get_recent_courses',
  'core_calendar_get_action_events_by_timesort',
  'media_videojs_get_language',
  'core_output_load_template_with_dependencies'
]);

const DANGEROUS_AJAX_METHOD_PATTERN =
  /(?:quiz|attempt|submit|save|delete|unenrol|grade|edit|post|write|update|add|create|mutate)/i;

/** Verifies whether an AJAX request to Moodle service endpoints is strictly a safe read-only query.
 * Allows verified metadata methods in READ_ONLY mode.
 * Fails closed on any unknown method or mutating action.
 */
export function isSafeReadOnlyAjaxRequest(method: string, rawUrl: string, postData?: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const pathname = parsed.pathname;
  const isServiceNoLogin = /\/lib\/ajax\/service-nologin\.php$/i.test(pathname);
  const isService = /\/lib\/ajax\/service\.php$/i.test(pathname);

  if (!isService && !isServiceNoLogin) {
    return false;
  }

  // Extract all methods requested
  const methodsFound: string[] = [];

  // 1. From URL search params 'info'
  const infoParam = parsed.searchParams.get('info');
  if (infoParam) {
    for (const m of infoParam.split(',')) {
      const trimmed = m.trim();
      if (trimmed) methodsFound.push(trimmed);
    }
  }

  // 2. From POST body if present
  if (postData && typeof postData === 'string') {
    try {
      const parsedBody = JSON.parse(postData);
      if (Array.isArray(parsedBody)) {
        for (const item of parsedBody) {
          if (item && typeof item.methodname === 'string') {
            methodsFound.push(item.methodname.trim());
          }
        }
      } else if (parsedBody && typeof parsedBody.methodname === 'string') {
        methodsFound.push(parsedBody.methodname.trim());
      }
    } catch {
      // If body is unparseable, fail closed unless valid methods were in URL
    }
  }

  // Handle service-nologin.php with GET
  if (isServiceNoLogin && (method || 'GET').toUpperCase() === 'GET') {
    if (methodsFound.length === 0) {
      return !MUTATING_QUERY_REGEX.test(parsed.search);
    }
    return methodsFound.every(m => !DANGEROUS_AJAX_METHOD_PATTERN.test(m));
  }

  // For service.php or any other AJAX: must have at least one method declared,
  // and EVERY method must be in SAFE_READ_ONLY_AJAX_METHODS and not match dangerous patterns
  if (methodsFound.length === 0) {
    return false;
  }

  return methodsFound.every(m => SAFE_READ_ONLY_AJAX_METHODS.has(m));
}

/** Detects URLs whose mere navigation may create an attempt, save a draft, submit, enrol/unenrol, or log out. */
export function isStateMutatingActionUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true; // unparsable => fail closed
  }
  if (MUTATING_PATH_REGEX.test(parsed.pathname + parsed.search)) return true;
  if (MUTATING_QUERY_REGEX.test(parsed.search)) return true;
  return false;
}

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for HTTP methods that may mutate server state. */
export function isMutatingHttpMethod(method: string): boolean {
  return !SAFE_HTTP_METHODS.has((method || 'GET').toUpperCase());
}
