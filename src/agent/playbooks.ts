/** Adaptive Playbook Memory: learns verified navigation & task recipes across sessions without storing secrets or raw passwords. */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentContext, AgentExecutionResult } from './types.js';
import { redactSecrets } from '../security/redact.js';

export type PlaybookIntent =
  | 'CHECK_DEADLINES'
  | 'SOLVE_QUIZ'
  | 'DOWNLOAD_RESOURCES'
  | 'LIST_COURSES'
  | 'LOGIN'
  | 'GENERAL';

export interface PlaybookStepHint {
  tool: string;
  summary: string;
  targetUrl?: string;
}

export interface AgentPlaybook {
  id: string;
  title: string;
  host: string;
  targetWebUrl: string;
  intent: PlaybookIntent;
  courseCode?: string;
  courseName?: string;
  courseUrl?: string;
  keywords: string[];
  authStrategy?: string;
  steps: PlaybookStepHint[];
  successCount: number;
  lastUsedAt: string;
  updatedAt: string;
}

export interface PlaybookStore {
  version: number;
  playbooks: Record<string, AgentPlaybook>;
}

const DEFAULT_PLAYBOOKS_PATH = resolve('.private', 'playbooks.json');
const MAX_PLAYBOOKS = 100;
const SENSITIVE_QUERY_KEYS = new Set([
  'sesskey', 'ticket', 'code', 'state', 'access_token', 'id_token',
  'refresh_token', 'token', 'password', 'pwd', 'auth', 'sig', 'signature'
]);
const STOP_WORDS = new Set([
  'va', 'cua', 'cho', 'voi', 'cac', 'bai', 'mon', 'hoc', 'xem', 'hay', 'vao',
  'lam', 'di', 'nhe', 'giup', 'toi', 'minh', 'la', 'thi', 'neu', 'con', 'sau',
  'do', 'den', 'ma', 'duoc', 'luon', 'het', 'tat', 'ca', 'nay', 'kia', 'nua',
  'lai', 'trong', 'ngoai', 'tren', 'duoi', 'tu', 'dong', 'hoa', 'phan', 'tuan',
  'check', 'the', 'and', 'for', 'with', 'into', 'from', 'lms'
]);

export function stripVietnameseAccents(input: string): string {
  return (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function tokenizeNormalized(input: string): string[] {
  const norm = stripVietnameseAccents(input);
  const rawTokens = norm.match(/[a-z0-9]{2,}/g) || [];
  return Array.from(new Set(rawTokens.filter(t => !STOP_WORDS.has(t))));
}

/** Builds short Vietnamese subject acronyms, e.g. "Xác suất thống kê" -> "xstk". */
export function buildVietnameseAcronym(phrase?: string): string | undefined {
  if (!phrase) return undefined;
  const cleaned = stripVietnameseAccents(phrase)
    .replace(/\b[a-z]{2,4}\s*\d{2,4}[a-z]?\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2 || words.length > 8) return undefined;
  const acronym = words.map(w => w[0]).join('');
  return acronym.length >= 2 ? acronym : undefined;
}

export function sanitizePlaybookUrl(rawUrl?: string): string | undefined {
  if (!rawUrl || !rawUrl.trim()) return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isLocalhostHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

const NON_COURSE_CODE_PREFIXES = new Set([
  'HTTP', 'HTTPS', 'UTF', 'IPV', 'SHA', 'BASE', 'OAUTH', 'PORT', 'HTML', 'JSON', 'ECMA', 'IEEE', 'RFC'
]);

/** Extracts normalized uppercase course code (e.g. "MI1111", "IT3080", "CS50") from free text. */
export function extractCourseCode(text?: string): string | undefined {
  if (!text) return undefined;
  const matches = text.matchAll(/\b([a-zA-Z]{2,4})\s*(\d{2,4}[a-zA-Z]?)\b/g);
  for (const m of matches) {
    const prefix = m[1].toUpperCase();
    if (NON_COURSE_CODE_PREFIXES.has(prefix)) continue;
    return `${prefix}${m[2].toUpperCase()}`;
  }
  return undefined;
}

/**
 * Registers a URL or hostname (plus institutional SSO subdomains and optional extra hosts)
 * into `allowedHosts` without duplicates.
 */
export function registerAllowedUrlHost(
  allowedHosts: string[],
  rawUrlOrHost?: string,
  extraHosts?: string[]
): string | undefined {
  let host: string | undefined;
  if (rawUrlOrHost && rawUrlOrHost.trim()) {
    const trimmed = rawUrlOrHost.trim();
    try {
      const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
      host = parsed.hostname.toLowerCase();
    } catch {
      // Ignore malformed URLs
    }
  }

  const addHost = (h?: string) => {
    const clean = (h || '').trim().toLowerCase();
    if (clean && !allowedHosts.includes(clean)) {
      allowedHosts.push(clean);
    }
  };

  if (host) {
    addHost(host);
    if (!isLocalhostHost(host)) {
      const parts = host.split('.');
      if (parts.length >= 2 && !parts.every(p => /^\d+$/.test(p))) {
        const isCcSld = parts.length >= 3 && ['edu', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[parts.length - 2]);
        const rootDomain = isCcSld ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
        for (const sub of ['id', 'sso', 'cas', 'adfs', 'auth', 'login']) {
          addHost(`${sub}.${rootDomain}`);
        }
      }
    }
  }

  if (Array.isArray(extraHosts)) {
    for (const extra of extraHosts) addHost(extra);
  }

  return host;
}

/**
 * Matches a course from a scraped course list against a user query/targetCourse
 * using course codes, Vietnamese unaccented text, and Vietnamese subject acronyms (e.g. "xstk").
 */
export function findBestMatchingCourse<T extends { name?: string; url?: string; code?: string }>(
  courses: T[],
  query?: string
): T | undefined {
  if (!query || !query.trim() || !Array.isArray(courses) || courses.length === 0) return undefined;
  const targetCode = extractCourseCode(query);
  const targetNorm = stripVietnameseAccents(query);
  const targetTokens = tokenizeNormalized(query);

  return courses.find(c => {
    const cNameNorm = stripVietnameseAccents(c.name || '');
    const cCodeUpper = (c.code || extractCourseCode(c.name) || '').toUpperCase();
    if (targetCode && (cCodeUpper === targetCode || cNameNorm.includes(targetCode.toLowerCase()))) {
      return true;
    }
    const cAcronym = buildVietnameseAcronym(c.name);
    if (cAcronym && (cAcronym === targetNorm || targetTokens.includes(cAcronym))) {
      return true;
    }
    if (targetNorm.length >= 2 && cNameNorm.includes(targetNorm)) {
      return true;
    }
    return targetTokens.length > 0 && targetTokens.every(tok => cNameNorm.includes(tok));
  });
}

function slugifyIdPart(text: string): string {
  return stripVietnameseAccents(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'item';
}

export async function readPlaybookStore(storePath: string = DEFAULT_PLAYBOOKS_PATH): Promise<PlaybookStore> {
  try {
    const raw = await readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PlaybookStore>;
    if (parsed && typeof parsed.playbooks === 'object' && parsed.playbooks !== null) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        playbooks: parsed.playbooks
      };
    }
  } catch {
    // Missing or unreadable file returns empty store
  }
  return { version: 1, playbooks: {} };
}

export async function savePlaybookStore(store: PlaybookStore, storePath: string = DEFAULT_PLAYBOOKS_PATH): Promise<void> {
  // Trim oldest playbooks if store exceeds cap
  const entries = Object.entries(store.playbooks);
  if (entries.length > MAX_PLAYBOOKS) {
    entries.sort((a, b) => (b[1].lastUsedAt || '').localeCompare(a[1].lastUsedAt || ''));
    store.playbooks = Object.fromEntries(entries.slice(0, MAX_PLAYBOOKS));
  }
  await mkdir(dirname(storePath), { recursive: true });
  const payload = JSON.stringify(store, null, 2);
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, payload, 'utf8');
  try {
    await rename(tmpPath, storePath);
  } catch {
    await writeFile(storePath, payload, 'utf8');
    await unlink(tmpPath).catch(() => {});
  }
}

export async function listPlaybooks(storePath: string = DEFAULT_PLAYBOOKS_PATH): Promise<AgentPlaybook[]> {
  const store = await readPlaybookStore(storePath);
  return Object.values(store.playbooks).sort((a, b) =>
    (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '')
  );
}

export async function deletePlaybook(idOrAll: string, storePath: string = DEFAULT_PLAYBOOKS_PATH): Promise<{ removed: number }> {
  const store = await readPlaybookStore(storePath);
  const key = idOrAll.trim();
  if (!key) return { removed: 0 };
  if (key.toLowerCase() === 'all') {
    const count = Object.keys(store.playbooks).length;
    store.playbooks = {};
    await savePlaybookStore(store, storePath);
    return { removed: count };
  }
  if (!store.playbooks[key]) return { removed: 0 };
  delete store.playbooks[key];
  await savePlaybookStore(store, storePath);
  return { removed: 1 };
}

function resolveCourseDetails(ctx: AgentContext, goal: string): {
  courseCode?: string;
  courseName?: string;
  courseUrl?: string;
} {
  const targetCourse = ctx.config.targetCourse;
  let courseCode = extractCourseCode(targetCourse) || extractCourseCode(goal);
  let courseName = targetCourse?.trim();
  let courseUrl: string | undefined;

  const collectedCourses = Array.isArray(ctx.collectedFindings?.courses)
    ? (ctx.collectedFindings.courses as { name?: string; url?: string; code?: string }[])
    : [];

  // 1. Prefer course URL actually visited during this successful run
  const visitedCourseUrls: string[] = [];
  for (const step of ctx.history) {
    const candidateUrls = [step.result?.urlAfter, step.result?.data?.url, step.toolCall?.args?.url];
    for (const raw of candidateUrls) {
      const clean = sanitizePlaybookUrl(typeof raw === 'string' ? raw : undefined);
      if (clean && /\/course\/view\.php|\/courses\//i.test(clean)) {
        visitedCourseUrls.push(clean);
      }
    }
  }

  const visitedUrlSet = new Set(visitedCourseUrls);
  let matched = collectedCourses.find(c => {
    const clean = sanitizePlaybookUrl(c.url);
    return Boolean(clean && visitedUrlSet.has(clean));
  });

  if (!matched && collectedCourses.length > 0 && (courseCode || targetCourse)) {
    matched = findBestMatchingCourse(collectedCourses, targetCourse || courseCode);
  }

  if (matched) {
    courseName = matched.name?.trim() || courseName;
    courseCode = courseCode || matched.code?.toUpperCase() || extractCourseCode(matched.name);
    courseUrl = sanitizePlaybookUrl(matched.url);
  } else if (visitedCourseUrls.length > 0) {
    courseUrl = visitedCourseUrls[visitedCourseUrls.length - 1];
  }

  return { courseCode, courseName, courseUrl };
}

export function distillSteps(ctx: AgentContext, knownSecrets: string[]): {
  steps: PlaybookStepHint[];
  usedAccountLogin: boolean;
} {
  const hints: PlaybookStepHint[] = [];
  const seenNavTargets = new Set<string>();
  let usedAccountLogin = false;

  for (const step of ctx.history.slice(ctx.currentTurnStartIndex ?? 0)) {
    if (!step.result?.success) continue;
    const tool = step.toolCall.tool;
    if (tool === 'agent.reportResult' || tool === 'agent.summarize' || tool === 'account.saveCredentials') {
      continue;
    }

    if (tool === 'account.login') {
      usedAccountLogin = true;
    }

    // Collapse repeated consecutive browser.observe calls or redundant back navigation steps
    if (tool === 'browser.observe' && hints.length > 0 && hints[hints.length - 1].tool === 'browser.observe') {
      continue;
    }
    if (tool === 'browser.back') {
      // Remove the preceding exploratory click on a completed/expired quiz if we bounced immediately back
      if (hints.length > 0 && hints[hints.length - 1].tool === 'browser.click') {
        hints.pop();
      }
      continue;
    }

    let summary: string = tool;
    let targetUrl: string | undefined;

    if (tool === 'account.login') {
      summary = 'Tự động đăng nhập (SSO/OAuth2/form) tới Dashboard';
    } else if (tool === 'browser.navigate' || tool === 'browser.open') {
      targetUrl = sanitizePlaybookUrl(step.result.urlAfter || step.toolCall.args?.url);
      if (targetUrl && (/\/mod\/(?:quiz|assign)\//i.test(targetUrl) || step.result.data?.quizStatus?.isErrorPage || step.result.observationText?.includes('Error |'))) {
        continue;
      }
      if (targetUrl && seenNavTargets.has(targetUrl)) {
        continue;
      }
      if (targetUrl) seenNavTargets.add(targetUrl);
      summary = targetUrl ? `Điều hướng tới ${targetUrl}` : 'Mở trang mục tiêu';
    } else if (tool === 'browser.extractStructuredData') {
      const dataType = String(step.toolCall.args?.type || 'all');
      summary = `Trích xuất dữ liệu cấu trúc (${dataType})`;
    } else if (tool === 'browser.click') {
      const clickLabel = String(step.toolCall.args?.text || step.toolCall.args?.selector || '').trim().slice(0, 60);
      targetUrl = sanitizePlaybookUrl(step.result.urlAfter);
      if (targetUrl && (/\/mod\/(?:quiz|assign)\//i.test(targetUrl) || step.result.data?.quizStatus?.isErrorPage || step.result.observationText?.includes('Error |'))) {
        continue;
      }
      if (targetUrl && seenNavTargets.has(targetUrl)) {
        continue;
      }
      if (targetUrl) seenNavTargets.add(targetUrl);
      summary = clickLabel ? `Nhấp "${clickLabel}"` : 'Nhấp phần tử điều hướng';
    } else if (tool === 'browser.fill' || tool === 'browser.type') {
      const sel = String(step.toolCall.args?.selector || '').toLowerCase();
      const isSensitiveField = /pass|pwd|secret|token|otp|mail|user|account|email/.test(sel);
      summary = isSensitiveField ? 'Điền thông tin trường biểu mẫu bảo mật' : `Điền trường biểu mẫu`;
    } else if (tool === 'quiz.solve') {
      const autoSub = Boolean(step.toolCall.args?.autoSubmit);
      summary = autoSub ? 'Tự động giải và nộp bài quiz (autoSubmit=true)' : 'Quét và điền đáp án quiz';
    }

    const cleanSummary = redactSecrets(summary, knownSecrets);
    if (hints.length > 0 && hints[hints.length - 1].tool === tool && hints[hints.length - 1].summary === cleanSummary) {
      continue;
    }

    hints.push({ tool, summary: cleanSummary, ...(targetUrl ? { targetUrl } : {}) });
    if (hints.length >= 6) break;
  }

  return { steps: hints, usedAccountLogin };
}

function buildKeywords(params: {
  host: string;
  intent: PlaybookIntent;
  courseCode?: string;
  courseName?: string;
  goal: string;
  knownSecrets: string[];
}): string[] {
  const kw = new Set<string>();
  const cleanHost = params.host.toLowerCase();
  kw.add(cleanHost);
  for (const part of cleanHost.split('.')) {
    if (part.length >= 2 && !['edu', 'com', 'org', 'net', 'www', 'lms'].includes(part)) {
      kw.add(part);
    }
  }
  if (cleanHost.includes('hust')) kw.add('hust');
  if (cleanHost.includes('vnu')) kw.add('vnu');

  if (params.courseCode) {
    kw.add(params.courseCode.toLowerCase());
  }
  if (params.courseName) {
    const cleanCourseName = redactSecrets(params.courseName, params.knownSecrets);
    const normCourse = stripVietnameseAccents(cleanCourseName).trim();
    if (normCourse) kw.add(normCourse);
    for (const tok of tokenizeNormalized(cleanCourseName)) kw.add(tok);
    const acronym = buildVietnameseAcronym(cleanCourseName);
    if (acronym) kw.add(acronym);
  }

  // Extract safe non-credential tokens from the user goal (excluding raw email/password phrasing)
  const scrubbedGoal = redactSecrets(params.goal, params.knownSecrets)
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, ' ')
    .replace(/(?:mật\s*khẩu|password|pass|pwd|\bmk\b)\s*(?:là|:|=)?\s*\S+/gi, ' ');
  for (const tok of tokenizeNormalized(scrubbedGoal).slice(0, 12)) {
    kw.add(tok);
  }

  return Array.from(kw).slice(0, 24);
}

/**
 * Learns/updates a verified scenario playbook after an agent run completes with `status === 'DONE'`.
 * Returns the saved playbook or `null` if skipped (e.g. non-DONE status or localhost test without explicit store path).
 */
export async function learnPlaybookFromRun(
  goal: string,
  ctx: AgentContext,
  result: AgentExecutionResult,
  knownSecrets: string[] = []
): Promise<AgentPlaybook | null> {
  if (result.status !== 'DONE') return null;

  const storePath = ctx.config.playbookStorePath || DEFAULT_PLAYBOOKS_PATH;
  const rawEntryUrl = sanitizePlaybookUrl(ctx.config.targetWebUrl || result.finalUrl || ctx.activeUrl);
  if (!rawEntryUrl) return null;

  let host = '';
  let entryOriginUrl = rawEntryUrl;
  try {
    const u = new URL(rawEntryUrl);
    host = u.hostname.toLowerCase();
    entryOriginUrl = u.origin;
  } catch {
    return null;
  }

  const isLocalhostUrl = (candidate?: string): boolean => {
    if (!candidate) return false;
    try {
      return isLocalhostHost(new URL(candidate).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  // Guard: never let automated localhost unit tests pollute `.private/playbooks.json` unless explicit storePath passed
  if (
    !ctx.config.playbookStorePath &&
    (isLocalhostHost(host) || isLocalhostUrl(result.finalUrl) || isLocalhostUrl(ctx.activeUrl))
  ) {
    return null;
  }

  const intent: PlaybookIntent = (ctx.config.userIntent as PlaybookIntent) || 'GENERAL';
  const { courseCode, courseName, courseUrl } = resolveCourseDetails(ctx, goal);
  const { steps, usedAccountLogin } = distillSteps(ctx, knownSecrets);
  if (steps.length === 0) return null;
  if (!ctx.config.playbookStorePath && steps.some(s => isLocalhostUrl(s.targetUrl))) {
    return null;
  }

  const idSuffix = courseCode
    ? slugifyIdPart(courseCode)
    : (courseName ? slugifyIdPart(courseName) : 'site');
  const playbookId = `${slugifyIdPart(host)}__${intent.toLowerCase()}__${idSuffix}`;

  const cleanCourseName = courseName ? redactSecrets(courseName, knownSecrets) : undefined;
  const titleParts = [host, intent];
  if (courseCode || cleanCourseName) titleParts.push(courseCode || cleanCourseName!);
  const title = titleParts.join(' • ');

  const store = await readPlaybookStore(storePath);
  const existing = store.playbooks[playbookId];
  const now = new Date().toISOString();

  const mergedKeywords = Array.from(new Set([
    ...(existing?.keywords || []),
    ...buildKeywords({ host, intent, courseCode, courseName: cleanCourseName, goal, knownSecrets })
  ])).slice(0, 28);

  const playbook: AgentPlaybook = {
    id: playbookId,
    title,
    host,
    targetWebUrl: entryOriginUrl,
    intent,
    ...(courseCode ? { courseCode } : (existing?.courseCode ? { courseCode: existing.courseCode } : {})),
    ...(cleanCourseName ? { courseName: cleanCourseName } : (existing?.courseName ? { courseName: existing.courseName } : {})),
    ...(courseUrl ? { courseUrl } : (existing?.courseUrl ? { courseUrl: existing.courseUrl } : {})),
    keywords: mergedKeywords,
    authStrategy: usedAccountLogin ? 'account.login (tự động nhận diện SSO/ADFS/form)' : existing?.authStrategy,
    steps,
    successCount: (existing?.successCount || 0) + 1,
    lastUsedAt: now,
    updatedAt: now
  };

  store.playbooks[playbookId] = playbook;
  await savePlaybookStore(store, storePath);
  return playbook;
}

export interface PlaybookMatch {
  playbook: AgentPlaybook;
  score: number;
}

/** Matches casual or formal user prompts against saved verified playbooks. */
export async function findMatchingPlaybooks(
  goal: string,
  opts?: {
    targetWebUrl?: string;
    targetCourse?: string;
    userIntent?: string;
    storePath?: string;
    limit?: number;
  }
): Promise<PlaybookMatch[]> {
  const storePath = opts?.storePath || DEFAULT_PLAYBOOKS_PATH;
  const store = await readPlaybookStore(storePath);
  const all = Object.values(store.playbooks);
  if (all.length === 0) return [];

  const normGoal = stripVietnameseAccents(goal);
  const goalTokens = new Set(tokenizeNormalized(goal));
  const goalCourseCode = extractCourseCode(opts?.targetCourse) || extractCourseCode(goal);

  let targetHost = '';
  if (opts?.targetWebUrl) {
    try { targetHost = new URL(opts.targetWebUrl).hostname.toLowerCase(); } catch {}
  }

  const matches: PlaybookMatch[] = [];
  for (const pb of all) {
    let score = 0;

    // 1. Host / platform affinity
    if (targetHost && pb.host === targetHost) {
      score += 35;
    } else if (normGoal.includes(pb.host) || (pb.host.includes('hust') && normGoal.includes('hust'))) {
      score += 25;
    }

    // 2. Exact course code match (highest precision)
    if (goalCourseCode && pb.courseCode && pb.courseCode.toUpperCase() === goalCourseCode) {
      score += 60;
    }

    // 3. Keyword / acronym / course-name overlap
    const courseAcronym = buildVietnameseAcronym(pb.courseName);
    let keywordHits = 0;
    for (const kw of pb.keywords) {
      if (!kw) continue;
      if (kw.includes(' ')) {
        if (normGoal.includes(kw)) {
          keywordHits++;
          score += 50;
        }
      } else if (goalTokens.has(kw)) {
        keywordHits++;
        if (courseAcronym && kw === courseAcronym) {
          score += 45;
        } else {
          score += kw.length >= 3 && !pb.host.includes(kw) ? 20 : 12;
        }
      }
    }

    // Require at least course code or non-host keyword or host+intent match to avoid false positives
    const hasSubjectSignal = Boolean(goalCourseCode && pb.courseCode === goalCourseCode) || keywordHits > 0;
    if (!hasSubjectSignal && !targetHost) {
      continue;
    }

    // 4. Intent alignment
    if (opts?.userIntent && opts.userIntent === pb.intent) {
      score += 25;
    } else if (opts?.userIntent && pb.intent !== 'GENERAL' && opts.userIntent !== pb.intent) {
      score -= 10;
    }

    if (score >= 30) {
      matches.push({ playbook: pb, score });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.playbook.successCount !== a.playbook.successCount) {
      return b.playbook.successCount - a.playbook.successCount;
    }
    return (b.playbook.lastUsedAt || '').localeCompare(a.playbook.lastUsedAt || '');
  });

  return matches.slice(0, opts?.limit ?? 2);
}

/** Builds a compact, token-efficient prompt hint block for matched playbooks. */
export function formatPlaybookPromptBlock(playbooks: AgentPlaybook[]): string {
  if (!playbooks || playbooks.length === 0) return '';
  const lines: string[] = [
    '## KỊCH BẢN ĐÃ GHI NHỚ PHÙ HỢP (PLAYBOOK HINT — LUÔN KIỂM TRA DOM THỰC TẾ KHI CHẠY):'
  ];

  for (const pb of playbooks.slice(0, 2)) {
    const coursePart = pb.courseName || pb.courseCode || 'Chung';
    const urlPart = pb.courseUrl ? ` | URL trực tiếp: ${pb.courseUrl}` : ` | Web: ${pb.targetWebUrl}`;
    const recipe = pb.steps.map(s => s.targetUrl ? `${s.tool}(${s.targetUrl})` : s.tool).join(' -> ');
    lines.push(`- [${pb.title}] (thành công ${pb.successCount} lần): Môn "${coursePart}"${urlPart}`);
    if (recipe) {
      lines.push(`  + Lộ trình tham khảo: ${recipe}`);
    }
  }
  lines.push('  + Lưu ý an toàn: Kịch bản chỉ là gợi ý định hướng tới trang môn học; luôn lấy URL bài quiz/bài tập THẬT từ DOM của trang môn học thay vì đoán ID.');
  return lines.join('\n');
}
