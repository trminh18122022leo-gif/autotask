/** Structured, secret-redacted per-run logger for AutoTask AI Autonomous Agent */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentContext, AgentGoalStatus, AgentStep } from './types.js';
import { redactSecrets } from '../security/redact.js';

export const DEFAULT_RUN_LOGS_DIR = resolve('.private', 'logs');
const MAX_SAVED_LOGS = 50;

export interface ModelEventLog {
  timestamp: string;
  phase: 'planner' | 'quiz_solve' | 'quiz_verify' | 'summarize';
  event: 'response' | 'switch' | 'rpm_wait' | 'error';
  model?: string;
  profileId?: string;
  from?: string;
  to?: string;
  reason?: string;
  latencyMs?: number;
  detail?: string;
}

export interface QuizQuestionLogEntry {
  id: string;
  stableId?: string;
  kind: string;
  promptSnippet: string;
  reasoning?: string;
  selectedIds?: string[];
  selectedOptionTexts?: string[];
  text?: string;
  confidence?: number;
  source: 'ai' | 'fallback' | 'skipped';
  domVerified?: boolean;
  fillError?: string;
}

export interface QuizSolveLogRecord {
  timestamp: string;
  quizTitle: string;
  entryUrl: string;
  finalUrl?: string;
  modelUsed?: string;
  profileUsed?: string;
  questionsFound: number;
  questionsFilled: number;
  aiSolvedCount: number;
  fallbackCount: number;
  fillFailures: number;
  domMismatchCount: number;
  submitted: boolean;
  scoreObserved?: string;
  warnings: string[];
  items: QuizQuestionLogEntry[];
}

export interface AgentStepLogEntry {
  stepIndex: number;
  timestamp: string;
  durationMs?: number;
  thought: string;
  tool: string;
  argsSummary: string;
  success?: boolean;
  modelUsed?: string;
  profileUsed?: string;
  observationSnippet: string;
  urlAfter?: string;
}

export interface AgentRunLog {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  goal: string;
  intent?: string;
  targetCourse?: string;
  targetWebUrl?: string;
  accountId?: string;
  status: AgentGoalStatus | 'RUNNING';
  modelCalls: number;
  finalUrl?: string;
  summary?: string;
  modelEvents: ModelEventLog[];
  steps: AgentStepLogEntry[];
  quizDetails: QuizSolveLogRecord[];
}

function isLocalhostTarget(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function sanitizeArgs(tool: string, args: Record<string, any> | undefined, knownSecrets: string[]): string {
  if (!args) return '{}';
  const copy: Record<string, any> = { ...args };
  if ('password' in copy) copy.password = '[REDACTED_PASSWORD]';
  if ('apiKey' in copy) copy.apiKey = '[REDACTED]';
  if (tool === 'browser.fill' || tool === 'browser.type') {
    const sel = String(copy.selector || '').toLowerCase();
    if (/pass|pwd|secret|token|otp/.test(sel)) {
      copy.value = '[REDACTED_PASSWORD]';
    }
  }
  return redactSecrets(JSON.stringify(copy), knownSecrets).slice(0, 320);
}

function buildRunId(intent?: string): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const tag = (intent || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  return `${stamp}_${tag}_${rand}`;
}

export function formatRunLogMarkdown(log: AgentRunLog): string {
  const lines: string[] = [];
  lines.push(`# AutoTask Agent Run Log: ${log.runId}`);
  lines.push(`- **Thời gian**: ${log.startedAt}${log.finishedAt ? ` -> ${log.finishedAt}` : ''} (${((log.durationMs || 0) / 1000).toFixed(1)}s)`);
  lines.push(`- **Trạng thái**: ${log.status} | **AI calls**: ${log.modelCalls}`);
  lines.push(`- **Mục tiêu**: ${log.goal}`);
  if (log.intent || log.targetCourse || log.targetWebUrl) {
    lines.push(`- **Ngữ cảnh**: intent=${log.intent || '-'} | course=${log.targetCourse || '-'} | web=${log.targetWebUrl || '-'}`);
  }
  if (log.finalUrl) lines.push(`- **URL cuối**: ${log.finalUrl}`);
  lines.push('');

  if (log.modelEvents.length > 0) {
    lines.push(`## Model Routing & Quota Events (${log.modelEvents.length})`);
    for (const ev of log.modelEvents) {
      if (ev.event === 'switch') {
        lines.push(`- [${ev.phase}] 🔄 Switch \`${ev.from}\` -> \`${ev.to}\`: ${ev.reason || ''}`);
      } else if (ev.event === 'rpm_wait') {
        lines.push(`- [${ev.phase}] ⏳ RPM Wait: ${ev.reason || ''}`);
      } else if (ev.event === 'error') {
        lines.push(`- [${ev.phase}] ✖ Error (${ev.profileId || '-'}/${ev.model || '-'}): ${ev.detail || ev.reason || ''}`);
      } else {
        lines.push(`- [${ev.phase}] ✔ \`${ev.model || '-'}\` (${ev.profileId || '-'}, ${ev.latencyMs ?? '-'}ms)`);
      }
    }
    lines.push('');
  }

  if (log.steps.length > 0) {
    lines.push(`## ReAct Steps (${log.steps.length})`);
    for (const st of log.steps) {
      const icon = st.success === false ? '✖' : '✔';
      const meta = [st.modelUsed, st.durationMs !== undefined ? `${st.durationMs}ms` : ''].filter(Boolean).join(', ');
      lines.push(`### Step ${st.stepIndex} [${icon}] \`${st.tool}\`${meta ? ` (${meta})` : ''}`);
      if (st.thought) lines.push(`- **Thought**: ${st.thought}`);
      lines.push(`- **Args**: \`${st.argsSummary}\``);
      if (st.observationSnippet) lines.push(`- **Observation**: ${st.observationSnippet}`);
      if (st.urlAfter) lines.push(`- **URL After**: ${st.urlAfter}`);
    }
    lines.push('');
  }

  if (log.quizDetails.length > 0) {
    lines.push(`## Chi tiết Giải Quiz / Bài tập (${log.quizDetails.length})`);
    for (const qz of log.quizDetails) {
      lines.push(`### ${qz.quizTitle || qz.entryUrl}`);
      lines.push(`- Model: \`${qz.modelUsed || '-'}\` (${qz.profileUsed || '-'}) | Điền: ${qz.questionsFilled}/${qz.questionsFound} | AI chuẩn: ${qz.aiSolvedCount} | Fallback: ${qz.fallbackCount} | Lỗi điền DOM: ${qz.fillFailures} | Nộp: ${qz.submitted ? 'Có' : 'Chưa'}`);
      if (qz.scoreObserved) lines.push(`- Kết quả / Điểm quan sát: ${qz.scoreObserved}`);
      if (qz.warnings.length > 0) lines.push(`- Cảnh báo: ${qz.warnings.join(' ; ')}`);
      for (const item of qz.items) {
        const chosen = item.selectedOptionTexts?.length
          ? item.selectedOptionTexts.join(' | ')
          : (item.text ?? item.selectedIds?.join(', ') ?? '(trống)');
        const conf = typeof item.confidence === 'number' ? ` [conf=${item.confidence.toFixed(2)}]` : '';
        const verifyTag = item.domVerified === false ? ' ⚠DOM_MISMATCH' : (item.domVerified === true ? ' ✔DOM' : '');
        const srcTag = item.source === 'fallback' ? ' ⚠FALLBACK' : (item.source === 'skipped' ? ' ⏭SKIPPED' : '');
        lines.push(`  - **${item.id}** (${item.kind})${conf}${srcTag}${verifyTag}: ${item.promptSnippet}`);
        if (item.reasoning) lines.push(`    - *Lý luận*: ${item.reasoning}`);
        lines.push(`    - *Đáp án chọn*: ${chosen}${item.fillError ? ` (Lỗi điền: ${item.fillError})` : ''}`);
      }
      lines.push('');
    }
  }

  if (log.summary) {
    lines.push(`## Final Summary`);
    lines.push(log.summary);
  }

  return lines.join('\n').trim() + '\n';
}

export class AgentRunLogger {
  readonly log: AgentRunLog;
  readonly jsonPath: string;
  readonly mdPath: string;
  private readonly dir: string;
  private readonly explicitLogDir: boolean;
  private readonly knownSecrets: string[];
  private readonly disabled: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    goal: string;
    ctx: AgentContext;
    knownSecrets?: string[];
    logDir?: string;
  }) {
    this.knownSecrets = opts.knownSecrets || [];
    this.explicitLogDir = Boolean(opts.logDir || opts.ctx.config.logDir);
    this.dir = resolve(opts.logDir || opts.ctx.config.logDir || DEFAULT_RUN_LOGS_DIR);
    this.disabled = Boolean(opts.ctx.config.disableLogs);
    const runId = buildRunId(opts.ctx.config.userIntent);
    this.jsonPath = join(this.dir, `${runId}.json`);
    this.mdPath = join(this.dir, `${runId}.md`);
    this.log = {
      runId,
      startedAt: new Date().toISOString(),
      goal: redactSecrets(opts.goal, this.knownSecrets),
      intent: opts.ctx.config.userIntent,
      targetCourse: opts.ctx.config.targetCourse,
      targetWebUrl: opts.ctx.config.targetWebUrl,
      accountId: opts.ctx.activeAccountId,
      status: 'RUNNING',
      modelCalls: 0,
      modelEvents: [],
      steps: [],
      quizDetails: []
    };
  }

  shouldPersist(activeUrl?: string): boolean {
    if (this.disabled) return false;
    if (this.explicitLogDir) return true;
    // Prevent automated localhost tests from writing to `.private/logs/` unless an explicit `logDir` is specified
    if (isLocalhostTarget(this.log.targetWebUrl) || isLocalhostTarget(activeUrl) || isLocalhostTarget(this.log.finalUrl)) {
      return false;
    }
    return true;
  }

  syncContext(ctx: AgentContext): void {
    this.log.intent = ctx.config.userIntent || this.log.intent;
    this.log.targetCourse = ctx.config.targetCourse || this.log.targetCourse;
    this.log.targetWebUrl = ctx.config.targetWebUrl || this.log.targetWebUrl;
    this.log.accountId = ctx.activeAccountId || this.log.accountId;
    if (ctx.activeUrl) this.log.finalUrl = redactSecrets(ctx.activeUrl, this.knownSecrets);
  }

  recordModelEvent(ev: Omit<ModelEventLog, 'timestamp'>): void {
    this.log.modelEvents.push({
      timestamp: new Date().toISOString(),
      ...ev,
      reason: ev.reason ? redactSecrets(ev.reason, this.knownSecrets).slice(0, 240) : undefined,
      detail: ev.detail ? redactSecrets(ev.detail, this.knownSecrets).slice(0, 240) : undefined
    });
  }

  recordStep(step: AgentStep, plannerMeta?: { modelUsed?: string; profileUsed?: string }): void {
    this.log.steps.push({
      stepIndex: step.stepIndex,
      timestamp: step.timestamp,
      durationMs: step.durationMs,
      thought: redactSecrets(step.thought || '', this.knownSecrets).slice(0, 400),
      tool: step.toolCall.tool,
      argsSummary: sanitizeArgs(step.toolCall.tool, step.toolCall.args, this.knownSecrets),
      success: step.result?.success,
      modelUsed: plannerMeta?.modelUsed,
      profileUsed: plannerMeta?.profileUsed,
      observationSnippet: redactSecrets(step.result?.observationText || '', this.knownSecrets).slice(0, 450),
      urlAfter: step.result?.urlAfter ? redactSecrets(step.result.urlAfter, this.knownSecrets) : undefined
    });
  }

  recordQuizSolve(record: Omit<QuizSolveLogRecord, 'timestamp'>): void {
    this.log.quizDetails.push({
      timestamp: new Date().toISOString(),
      ...record,
      quizTitle: redactSecrets(record.quizTitle || '', this.knownSecrets),
      scoreObserved: record.scoreObserved ? redactSecrets(record.scoreObserved, this.knownSecrets) : undefined,
      warnings: record.warnings.map(w => redactSecrets(w, this.knownSecrets)),
      items: record.items.map(it => ({
        ...it,
        promptSnippet: redactSecrets(it.promptSnippet, this.knownSecrets).slice(0, 240),
        reasoning: it.reasoning ? redactSecrets(it.reasoning, this.knownSecrets).slice(0, 260) : undefined,
        text: it.text ? redactSecrets(it.text, this.knownSecrets).slice(0, 300) : undefined,
        selectedOptionTexts: it.selectedOptionTexts?.map(t => redactSecrets(t, this.knownSecrets)),
        fillError: it.fillError ? redactSecrets(it.fillError, this.knownSecrets).slice(0, 200) : undefined
      }))
    });
  }

  async flush(activeUrl?: string): Promise<string | undefined> {
    if (!this.shouldPersist(activeUrl)) return undefined;
    const job = async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.jsonPath, JSON.stringify(this.log, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await writeFile(this.mdPath, formatRunLogMarkdown(this.log), { encoding: 'utf8', mode: 0o600 });
      await pruneOldLogs(this.dir).catch(() => {});
    };
    this.writeQueue = this.writeQueue.then(job, job);
    await this.writeQueue;
    return this.mdPath;
  }

  async finalize(params: {
    status: AgentGoalStatus;
    summary: string;
    durationMs: number;
    modelCalls: number;
    finalUrl?: string;
  }): Promise<string | undefined> {
    this.log.finishedAt = new Date().toISOString();
    this.log.status = params.status;
    this.log.summary = redactSecrets(params.summary || '', this.knownSecrets);
    this.log.durationMs = params.durationMs;
    this.log.modelCalls = params.modelCalls;
    if (params.finalUrl) {
      this.log.finalUrl = redactSecrets(params.finalUrl, this.knownSecrets);
    }
    return this.flush(params.finalUrl);
  }
}

async function pruneOldLogs(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const jsonFiles = entries.filter(f => f.endsWith('.json'));
  if (jsonFiles.length <= MAX_SAVED_LOGS) return;
  const withStats = await Promise.all(
    jsonFiles.map(async name => {
      const full = join(dir, name);
      const st = await stat(full).catch(() => null);
      return { name, mtimeMs: st?.mtimeMs || 0 };
    })
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of withStats.slice(MAX_SAVED_LOGS)) {
    const base = stale.name.replace(/\.json$/, '');
    await unlink(join(dir, `${base}.json`)).catch(() => {});
    await unlink(join(dir, `${base}.md`)).catch(() => {});
  }
}

export interface RunLogSummaryItem {
  runId: string;
  startedAt: string;
  status: string;
  goal: string;
  durationMs?: number;
  quizCount: number;
  mdPath: string;
  jsonPath: string;
}

export async function listRecentRunLogs(limit = 10, logDir = DEFAULT_RUN_LOGS_DIR): Promise<RunLogSummaryItem[]> {
  try {
    const entries = await readdir(logDir);
    const jsonFiles = entries.filter(f => f.endsWith('.json')).sort().reverse();
    const out: RunLogSummaryItem[] = [];
    for (const file of jsonFiles.slice(0, limit)) {
      try {
        const raw = await readFile(join(logDir, file), 'utf8');
        const parsed = JSON.parse(raw) as AgentRunLog;
        out.push({
          runId: parsed.runId,
          startedAt: parsed.startedAt,
          status: parsed.status,
          goal: parsed.goal,
          durationMs: parsed.durationMs,
          quizCount: parsed.quizDetails?.length || 0,
          jsonPath: join(logDir, file),
          mdPath: join(logDir, file.replace(/\.json$/, '.md'))
        });
      } catch {
        // Ignore malformed log file
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function readRunLog(idOrIndex: string | number = 1, logDir = DEFAULT_RUN_LOGS_DIR): Promise<AgentRunLog | null> {
  const recent = await listRecentRunLogs(MAX_SAVED_LOGS, logDir);
  if (recent.length === 0) return null;

  let target: RunLogSummaryItem | undefined;
  const idx = typeof idOrIndex === 'number' ? idOrIndex : (/^\d+$/.test(String(idOrIndex).trim()) ? Number(idOrIndex) : -1);
  if (idx >= 1 && idx <= recent.length) {
    target = recent[idx - 1];
  } else {
    const q = String(idOrIndex).trim().toLowerCase();
    target = recent.find(r => r.runId.toLowerCase().includes(q));
  }
  if (!target) return null;
  const raw = await readFile(target.jsonPath, 'utf8');
  return JSON.parse(raw) as AgentRunLog;
}
