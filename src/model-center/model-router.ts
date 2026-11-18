/** Unified Model Router for AutoTask AI.
 * Single Source of Truth for model selection, capability-aware routing (Vision vs Text),
 * rate-limit/transient error fallback, and loop prevention.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  callModel,
  resolveProvider,
  setUsageTelemetryListener,
  type CallUsageMetrics,
  type ResolvedProvider,
  type PromptInput,
  type ProviderSpec
} from '../providers.js';
import { readProfilesDb, isFallbackEligible, sanitizeStoredProfile, getProfileKeySlots } from './routing.js';
import { GEMINI_AUTO_MODEL_POOL, VERIFIED_CAPABILITIES, resolveModelCapabilities, resolveProfileCapabilities, isOfficialEndpoint } from './catalog.js';
import type { ModelProfilesDb, StoredProfile } from './types.js';
import { redactSecrets } from '../security/redact.js';

export interface RouteCandidate {
  profileId: string;
  keySlot?: string;
  provider: string;
  model: string;
  supportsVision: boolean;
}

export interface RoutingPlan {
  primary: RouteCandidate;
  candidates: RouteCandidate[];
  source: 'MODEL_CENTER_DEFAULT' | 'TASK_OVERRIDE';
}

export interface RouterExecutionResult {
  output: string;
  initialProfile: string;
  finalProfile: string;
  keySlotUsed?: string;
  modelUsed?: string;
  attempts: number;
  fallbackCount: number;
  history: { profileId: string; keySlot?: string; model?: string; error?: string; latencyMs: number }[];
}

export interface RateLimitWaitInfo {
  waitMs: number;
  cycle: number;
  maxCycles: number;
  reason: string;
}

export function formatRateLimitWaitNotice(info: RateLimitWaitInfo): string {
  const secs = Math.max(0, Math.round(info.waitMs / 1000));
  return `[Rate Limit Guard] ⏳ Toàn bộ model đang chạm RPM — tạm ngưng ${secs}s rồi tự động gọi lại (${info.cycle}/${info.maxCycles})...`;
}

export interface RouteOptions {
  profileOverride?: string;
  modelOverride?: string;
  fallbackOverrides?: string[];
  taskRole?: 'planner' | 'solver' | 'verifier' | 'writer' | 'summarizer';
  requiresVision?: boolean;
  preferAccuracy?: boolean;
  maxAttemptsPerModel?: number;
  roundRobinIndex?: number;
  disableCooldown?: boolean;
  expandModelPool?: boolean;
  enableTelemetryRotation?: boolean;
  estimatedTokens?: number;
  waitOnRateLimit?: boolean;
  maxRateLimitWaitCycles?: number;
  rateLimitWaitMs?: number;
  onModelSwitch?: (from: string, to: string, reason: string) => void;
  onRateLimitWait?: (info: RateLimitWaitInfo) => void;
  db?: ModelProfilesDb;
  resolveFn?: (spec: ProviderSpec) => Promise<ResolvedProvider>;
}

export interface SafeProviderError extends Error {
  message: string;
  category: string;
  httpStatus?: number;
  providerId?: string;
  profileId?: string;
  safeCode?: string;
  retryable?: boolean;
  timestamp: string;
  code?: string;
  status?: number;
  statusCode?: number;
  statusMessage?: string;
  toJSON?: () => Record<string, any>;
}

export const SAFE_ERROR_CODES = new Set<string>([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_HTTP2_STREAM_ERROR',
  'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 'UNAUTHORIZED', 'FORBIDDEN',
  'BAD_REQUEST', 'INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT', 'TIMEOUT', 'MODEL_NOT_FOUND', 'INVALID_API_KEY'
]);

/** Sanitizes and strictly whitelists error codes to prevent token leakage via err.code */
export function sanitizeErrorCode(rawCode: unknown): string {
  if (rawCode === undefined || rawCode === null) return 'PROVIDER_ERROR';
  const str = String(rawCode).trim().toUpperCase();
  if (SAFE_ERROR_CODES.has(str)) {
    return str;
  }
  if (/^[1-5][0-9]{2}$/.test(str)) {
    return str;
  }
  return 'PROVIDER_ERROR';
}

/** Sanitizes provider error so no sensitive tokens escape public router boundaries */
export function sanitizeProviderError(err: unknown, profileId?: string, provider?: string): SafeProviderError {
  const rawMsg = err instanceof Error ? err.message : String(err || 'Unknown provider error');
  const cleanMsg = redactSecrets(rawMsg);
  const cleanErr = new Error(cleanMsg) as SafeProviderError;

  const anyErr = (err && typeof err === 'object') ? err as any : {};

  // 1. Safe fixed name and category (never copy arbitrary error name from SDK)
  cleanErr.name = 'SafeProviderError';
  const isRateLimit = cleanMsg.includes('429') || /rate[- ]limit|quota/i.test(cleanMsg);
  const isAuth = cleanMsg.includes('401') || cleanMsg.includes('403') || /unauthorized|forbidden|invalid api key/i.test(cleanMsg);
  const isServer = cleanMsg.includes('500') || cleanMsg.includes('502') || cleanMsg.includes('503') || cleanMsg.includes('504');

  const category = isRateLimit ? 'RATE_LIMIT' : (isAuth ? 'AUTHENTICATION' : (isServer ? 'SERVER_ERROR' : 'PROVIDER_ERROR'));
  cleanErr.category = category;

  // 2. Strict Whitelisted Code
  const safeCode = sanitizeErrorCode(anyErr.code);
  cleanErr.code = safeCode;
  cleanErr.safeCode = safeCode;

  // 3. Safe HTTP status
  const codeNum = typeof anyErr.code === 'number' ? anyErr.code : (typeof anyErr.code === 'string' && /^[1-5][0-9]{2}$/.test(anyErr.code) ? Number(anyErr.code) : undefined);
  const httpStatus = typeof anyErr.status === 'number' && anyErr.status >= 100 && anyErr.status <= 599
    ? anyErr.status
    : (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 100 && anyErr.statusCode <= 599
        ? anyErr.statusCode
        : (codeNum && codeNum >= 100 && codeNum <= 599 ? codeNum : undefined));
  if (httpStatus) {
    cleanErr.status = httpStatus;
    cleanErr.statusCode = httpStatus;
    cleanErr.httpStatus = httpStatus;
  }

  // 4. Safe statusMessage
  if (anyErr.statusMessage) {
    cleanErr.statusMessage = redactSecrets(String(anyErr.statusMessage));
  }

  // 5. Clean stack
  if (err instanceof Error && err.stack) {
    cleanErr.stack = redactSecrets(err.stack);
  }

  // 6. Clean nested cause (never link raw Error)
  if (anyErr.cause) {
    const rawCauseMsg = anyErr.cause instanceof Error ? anyErr.cause.message : String(anyErr.cause);
    const cleanCause = new Error(redactSecrets(rawCauseMsg));
    cleanCause.name = 'ProviderErrorCause';
    cleanErr.cause = cleanCause;
  }

  // 7. Identity & metadata
  cleanErr.profileId = profileId;
  cleanErr.providerId = provider;
  cleanErr.timestamp = new Date().toISOString();
  cleanErr.retryable = isRateLimit || isServer;
  (cleanErr as any).isFallbackEligible = cleanErr.retryable;

  // 8. Safe report serialization (controlled properties only)
  cleanErr.toJSON = () => ({
    name: cleanErr.name,
    message: cleanErr.message,
    category: cleanErr.category,
    safeCode: cleanErr.safeCode,
    httpStatus: cleanErr.httpStatus,
    statusCode: cleanErr.statusCode,
    profileId,
    provider,
    retryable: cleanErr.retryable,
    timestamp: cleanErr.timestamp
  });

  return cleanErr;
}

export type CooldownScope = 'PER_MINUTE' | 'DAILY' | 'OVERLOAD';

export interface CooldownEntry {
  expiresAt: number;
  scope: CooldownScope;
  subScope?: 'RPM' | 'TPM' | 'RPD' | 'TPD';
  dailyBucketKey?: string;
  reason?: string;
}

export type ClassifiedErrorScope = 'AUTH' | 'NOT_FOUND' | 'DAILY' | 'PER_MINUTE' | 'OVERLOAD' | 'TRANSIENT';

const DAILY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RPM_WAIT_MS = 60_000;
const MAX_RPM_WAIT_MS = 65_000;
const SHORT_COOLDOWN_CUTOFF_MS = 120_000;
const SLIDING_WINDOW_MS = 60_000;
const TELEMETRY_FILE_PATH = resolve('.private', 'key-telemetry.json');

export interface ModelRateLimits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export const DEFAULT_MODEL_RATE_LIMITS: Record<string, ModelRateLimits> = {
  'gemini-3.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3.1-flash-lite-preview': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-flash-lite-latest': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3-flash-preview': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.6-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.7-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.8-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-flash-latest': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash': { rpm: 10, tpm: 250_000, rpd: 250 },
  'gemini-2.5-pro': { rpm: 5, tpm: 250_000, rpd: 100 },
  'gemma-4-26b-a4b-it': { rpm: 30, tpm: 15_000, rpd: 14_400 },
  'gemma-4-31b-it': { rpm: 30, tpm: 15_000, rpd: 14_400 }
};

export interface SlotModelTelemetry {
  profileId: string;
  keySlot: string;
  model: string;
  requestTimestamps: number[];
  tokenTimestamps: { ts: number; prompt: number; output: number; total: number }[];
  dailyBucketKey: string;
  dailyRequests: number;
  dailyPromptTokens: number;
  dailyOutputTokens: number;
  dailyTotalTokens: number;
  emaLatencyMs?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastErrorReason?: string;
  remainingRequestsHeader?: number;
  remainingTokensHeader?: number;
  learnedLimits?: Partial<ModelRateLimits>;
}

export interface KeySlotTelemetryView {
  key: string;
  profileId: string;
  keySlot: string;
  model: string;
  usedRpm60s: number;
  usedTpm60s: number;
  usedRpdToday: number;
  usedTokensToday: number;
  usedPromptTokensToday: number;
  usedOutputTokensToday: number;
  avgLatencyMs?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastErrorReason?: string;
  limits: ModelRateLimits;
  cooldownScope?: CooldownScope;
  cooldownRemainingMs: number;
  dailyResetAtMs: number;
}

export function getPacificDayKey(nowMs = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** Computes exact next 00:00 Midnight Pacific Time timestamp in epoch ms (accounts for PST/PDT DST). */
export function getNextPacificMidnightMs(nowMs = Date.now()): number {
  const todayKey = getPacificDayKey(nowMs);
  // Step forward in 30-min increments up to 26h, then refine to 1-min precision
  let probe = nowMs;
  for (let i = 0; i < 52; i++) {
    probe += 30 * 60 * 1000;
    if (getPacificDayKey(probe) !== todayKey) {
      let lo = probe - 30 * 60 * 1000;
      let hi = probe;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (getPacificDayKey(mid) === todayKey) lo = mid;
        else hi = mid;
      }
      return hi;
    }
  }
  return nowMs + DAILY_COOLDOWN_MS;
}

export function getDefaultModelRateLimits(model: string): ModelRateLimits {
  const norm = model.trim().toLowerCase();
  if (DEFAULT_MODEL_RATE_LIMITS[norm]) return { ...DEFAULT_MODEL_RATE_LIMITS[norm] };
  if (norm.startsWith('gemma-')) return { rpm: 30, tpm: 15_000, rpd: 14_400 };
  if (norm.includes('flash-lite')) return { rpm: 15, tpm: 250_000, rpd: 500 };
  if (norm.includes('pro')) return { rpm: 5, tpm: 250_000, rpd: 100 };
  if (norm.includes('flash')) return { rpm: 5, tpm: 250_000, rpd: 20 };
  return { rpm: 30, tpm: 200_000, rpd: 1000 };
}

/** In-memory temporary cooldown tracker keyed by `${profileId}::${keySlot}::${model}` for quota/overload isolation. */
const profileCooldowns = new Map<string, CooldownEntry>();
const slotModelTelemetry = new Map<string, SlotModelTelemetry>();
const modelOverloadTracker = new Map<string, { failCount: number; firstFailAt: number; blockedUntil: number }>();
let lastGoodModelId: string | undefined;
let telemetryLoadedFromDisk = false;
let telemetryPersistTimer: ReturnType<typeof setTimeout> | null = null;

function ensureTelemetryLoaded(): void {
  if (telemetryLoadedFromDisk) return;
  telemetryLoadedFromDisk = true;
  try {
    if (!existsSync(TELEMETRY_FILE_PATH)) return;
    const raw = readFileSync(TELEMETRY_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { slots?: Record<string, SlotModelTelemetry>; lastGoodModelId?: string };
    const today = getPacificDayKey();
    if (parsed?.lastGoodModelId) lastGoodModelId = parsed.lastGoodModelId;
    if (parsed?.slots && typeof parsed.slots === 'object') {
      const cutoff = Date.now() - SLIDING_WINDOW_MS;
      for (const [k, s] of Object.entries(parsed.slots)) {
        if (!s || typeof s !== 'object') continue;
        const sameDay = s.dailyBucketKey === today;
        slotModelTelemetry.set(k, {
          profileId: String(s.profileId || ''),
          keySlot: String(s.keySlot || ''),
          model: String(s.model || ''),
          requestTimestamps: Array.isArray(s.requestTimestamps) ? s.requestTimestamps.filter(t => t >= cutoff) : [],
          tokenTimestamps: Array.isArray(s.tokenTimestamps) ? s.tokenTimestamps.filter(t => t && t.ts >= cutoff) : [],
          dailyBucketKey: today,
          dailyRequests: sameDay ? Number(s.dailyRequests || 0) : 0,
          dailyPromptTokens: sameDay ? Number(s.dailyPromptTokens || 0) : 0,
          dailyOutputTokens: sameDay ? Number(s.dailyOutputTokens || 0) : 0,
          dailyTotalTokens: sameDay ? Number(s.dailyTotalTokens || 0) : 0,
          emaLatencyMs: typeof s.emaLatencyMs === 'number' ? s.emaLatencyMs : undefined,
          lastSuccessAt: s.lastSuccessAt,
          lastErrorAt: s.lastErrorAt,
          lastErrorReason: s.lastErrorReason,
          learnedLimits: s.learnedLimits
        });
      }
    }
  } catch {}
}

function scheduleTelemetryPersist(): void {
  if (telemetryPersistTimer) return;
  telemetryPersistTimer = setTimeout(() => {
    telemetryPersistTimer = null;
    try {
      const dir = dirname(TELEMETRY_FILE_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const cutoff = now - SLIDING_WINDOW_MS;
      const serialized: Record<string, SlotModelTelemetry> = {};
      for (const [k, v] of slotModelTelemetry.entries()) {
        serialized[k] = {
          ...v,
          requestTimestamps: v.requestTimestamps.filter(t => t >= cutoff),
          tokenTimestamps: v.tokenTimestamps.filter(t => t.ts >= cutoff)
        };
      }
      writeFileSync(
        TELEMETRY_FILE_PATH,
        JSON.stringify({ updatedAt: new Date(now).toISOString(), lastGoodModelId, slots: serialized }, null, 2),
        'utf8'
      );
    } catch {}
  }, 300);
  if (typeof telemetryPersistTimer.unref === 'function') {
    telemetryPersistTimer.unref();
  }
}

function getOrCreateTelemetry(profileId: string, model: string, keySlot?: string): SlotModelTelemetry {
  const effectiveSlot = keySlot && keySlot.trim() ? keySlot.trim() : profileId;
  const key = getCooldownKey(profileId, model, effectiveSlot);
  const now = Date.now();
  const today = getPacificDayKey(now);
  let entry = slotModelTelemetry.get(key);
  if (!entry) {
    entry = {
      profileId,
      keySlot: effectiveSlot,
      model,
      requestTimestamps: [],
      tokenTimestamps: [],
      dailyBucketKey: today,
      dailyRequests: 0,
      dailyPromptTokens: 0,
      dailyOutputTokens: 0,
      dailyTotalTokens: 0
    };
    slotModelTelemetry.set(key, entry);
  }
  const cutoff = now - SLIDING_WINDOW_MS;
  entry.requestTimestamps = entry.requestTimestamps.filter(t => t >= cutoff);
  entry.tokenTimestamps = entry.tokenTimestamps.filter(t => t.ts >= cutoff);
  if (entry.dailyBucketKey !== today) {
    entry.dailyBucketKey = today;
    entry.dailyRequests = 0;
    entry.dailyPromptTokens = 0;
    entry.dailyOutputTokens = 0;
    entry.dailyTotalTokens = 0;
  }
  return entry;
}

export function recordKeySlotUsage(metrics: CallUsageMetrics, persistToDisk = true): void {
  if (!metrics.profileId || !metrics.model) return;
  const entry = getOrCreateTelemetry(metrics.profileId, metrics.model, metrics.keySlot);
  const ts = metrics.timestamp || Date.now();
  entry.requestTimestamps.push(ts);
  entry.tokenTimestamps.push({
    ts,
    prompt: metrics.promptTokens,
    output: metrics.outputTokens,
    total: metrics.totalTokens
  });
  entry.dailyRequests += 1;
  entry.dailyPromptTokens += metrics.promptTokens;
  entry.dailyOutputTokens += metrics.outputTokens;
  entry.dailyTotalTokens += metrics.totalTokens;
  entry.lastSuccessAt = ts;
  entry.emaLatencyMs = typeof entry.emaLatencyMs === 'number'
    ? Math.round(entry.emaLatencyMs * 0.7 + metrics.latencyMs * 0.3)
    : Math.round(metrics.latencyMs);
  if (metrics.remainingRequests !== undefined) entry.remainingRequestsHeader = metrics.remainingRequests;
  if (metrics.remainingTokens !== undefined) entry.remainingTokensHeader = metrics.remainingTokens;

  // If provider reports 0 remaining requests/tokens in headers, proactively trigger per-minute cooldown for this slot
  const key = getCooldownKey(metrics.profileId, metrics.model, metrics.keySlot);
  if (metrics.remainingRequests === 0) {
    profileCooldowns.set(key, {
      expiresAt: ts + (metrics.resetRequestsMs && metrics.resetRequestsMs > 0 ? metrics.resetRequestsMs : DEFAULT_RPM_WAIT_MS),
      scope: 'PER_MINUTE',
      subScope: 'RPM',
      reason: 'Header x-ratelimit-remaining-requests = 0'
    });
  } else if (metrics.remainingTokens === 0) {
    profileCooldowns.set(key, {
      expiresAt: ts + (metrics.resetTokensMs && metrics.resetTokensMs > 0 ? metrics.resetTokensMs : DEFAULT_RPM_WAIT_MS),
      scope: 'PER_MINUTE',
      subScope: 'TPM',
      reason: 'Header x-ratelimit-remaining-tokens = 0'
    });
  }

  if (persistToDisk) scheduleTelemetryPersist();
}

export function recordKeySlotErrorTelemetry(
  profileId: string,
  model: string,
  keySlot: string | undefined,
  reason: string,
  learnedLimit?: Partial<ModelRateLimits>,
  persistToDisk = true
): void {
  const entry = getOrCreateTelemetry(profileId, model, keySlot);
  entry.lastErrorAt = Date.now();
  entry.lastErrorReason = redactSecrets(reason).slice(0, 140);
  if (learnedLimit) {
    entry.learnedLimits = { ...(entry.learnedLimits || {}), ...learnedLimit };
  }
  if (persistToDisk) scheduleTelemetryPersist();
}

export function syncCooldownFromProbe(
  profileId: string,
  model: string,
  keySlot: string | undefined,
  state: 'AVAILABLE' | 'RPM_TPM_LIMITED' | 'DAILY_EXHAUSTED',
  retryAfterMs?: number
): void {
  const key = getCooldownKey(profileId, model, keySlot);
  const now = Date.now();
  if (state === 'AVAILABLE') {
    profileCooldowns.delete(key);
    modelOverloadTracker.delete(model);
    return;
  }
  if (state === 'DAILY_EXHAUSTED') {
    const nextMidnight = getNextPacificMidnightMs(now);
    profileCooldowns.set(key, {
      expiresAt: retryAfterMs && retryAfterMs > 0 ? Math.min(nextMidnight, now + retryAfterMs) : nextMidnight,
      scope: 'DAILY',
      subScope: 'RPD',
      dailyBucketKey: getPacificDayKey(now),
      reason: 'Quota Probe: DAILY_EXHAUSTED'
    });
    return;
  }
  profileCooldowns.set(key, {
    expiresAt: now + (retryAfterMs && retryAfterMs > 0 ? Math.min(SHORT_COOLDOWN_CUTOFF_MS, retryAfterMs) : DEFAULT_RPM_WAIT_MS),
    scope: 'PER_MINUTE',
    subScope: 'RPM',
    reason: 'Quota Probe: RPM_TPM_LIMITED'
  });
}

export function getKeySlotTelemetrySnapshot(): KeySlotTelemetryView[] {
  ensureTelemetryLoaded();
  const now = Date.now();
  const cutoff = now - SLIDING_WINDOW_MS;
  const today = getPacificDayKey(now);
  const dailyResetAtMs = getNextPacificMidnightMs(now);
  const views: KeySlotTelemetryView[] = [];

  for (const [key, entry] of slotModelTelemetry.entries()) {
    const reqs60 = entry.requestTimestamps.filter(t => t >= cutoff);
    const toks60 = entry.tokenTimestamps.filter(t => t.ts >= cutoff);
    const usedTpm60s = toks60.reduce((sum, x) => sum + x.total, 0);
    const sameDay = entry.dailyBucketKey === today;
    const baseLimits = getDefaultModelRateLimits(entry.model);
    const limits: ModelRateLimits = {
      rpm: entry.learnedLimits?.rpm ?? baseLimits.rpm,
      tpm: entry.learnedLimits?.tpm ?? baseLimits.tpm,
      rpd: entry.learnedLimits?.rpd ?? baseLimits.rpd
    };
    const cd = profileCooldowns.get(key);
    const cdActive = Boolean(cd && now < cd.expiresAt && !(cd.scope === 'DAILY' && cd.dailyBucketKey && cd.dailyBucketKey !== today));
    views.push({
      key,
      profileId: entry.profileId,
      keySlot: entry.keySlot,
      model: entry.model,
      usedRpm60s: reqs60.length,
      usedTpm60s,
      usedRpdToday: sameDay ? entry.dailyRequests : 0,
      usedTokensToday: sameDay ? entry.dailyTotalTokens : 0,
      usedPromptTokensToday: sameDay ? entry.dailyPromptTokens : 0,
      usedOutputTokensToday: sameDay ? entry.dailyOutputTokens : 0,
      avgLatencyMs: entry.emaLatencyMs,
      lastSuccessAt: entry.lastSuccessAt,
      lastErrorAt: entry.lastErrorAt,
      lastErrorReason: entry.lastErrorReason,
      limits,
      cooldownScope: cdActive ? cd!.scope : undefined,
      cooldownRemainingMs: cdActive ? Math.max(0, cd!.expiresAt - now) : 0,
      dailyResetAtMs
    });
  }
  return views;
}

// Register telemetry listener from real provider HTTP calls
setUsageTelemetryListener((metrics) => {
  recordKeySlotUsage(metrics, true);
});

export function getCooldownKey(profileId: string, model: string, keySlot?: string): string {
  const effectiveSlot = keySlot && keySlot !== profileId ? keySlot : undefined;
  return effectiveSlot ? `${profileId}::${effectiveSlot}::${model}` : `${profileId}::${model}`;
}

export function getProfileCooldowns(): Map<string, CooldownEntry> {
  return profileCooldowns;
}

export function resetProfileCooldowns(): void {
  profileCooldowns.clear();
  slotModelTelemetry.clear();
  modelOverloadTracker.clear();
  lastGoodModelId = undefined;
  telemetryLoadedFromDisk = true;
}

function classifyProviderError(err: unknown): {
  scope: ClassifiedErrorScope;
  subScope?: 'RPM' | 'TPM' | 'RPD' | 'TPD';
  retryAfterMs?: number;
  learnedLimit?: Partial<ModelRateLimits>;
} {
  const anyErr = (err && typeof err === 'object') ? err as any : {};
  const retryAfterMs = typeof anyErr.retryAfterMs === 'number' && Number.isFinite(anyErr.retryAfterMs) && anyErr.retryAfterMs > 0
    ? anyErr.retryAfterMs
    : undefined;
  const rawScope = typeof anyErr.rateLimitScope === 'string' ? anyErr.rateLimitScope : undefined;
  const rawSub = typeof anyErr.rateLimitSubScope === 'string' ? anyErr.rateLimitSubScope as any : undefined;
  const parsedQuotaVal = Number(anyErr.quotaLimitValue);
  const msg = err instanceof Error ? err.message : String(err || '');

  const buildLearned = (sub?: 'RPM' | 'TPM' | 'RPD' | 'TPD'): Partial<ModelRateLimits> | undefined => {
    if (!Number.isFinite(parsedQuotaVal) || parsedQuotaVal <= 0) return undefined;
    if (sub === 'RPM') return { rpm: parsedQuotaVal };
    if (sub === 'TPM') return { tpm: parsedQuotaVal };
    if (sub === 'RPD') return { rpd: parsedQuotaVal };
    return undefined;
  };

  if (rawScope === 'AUTH' || rawScope === 'NOT_FOUND' || rawScope === 'DAILY' || rawScope === 'PER_MINUTE' || rawScope === 'OVERLOAD') {
    const inferredSub = rawSub || (rawScope === 'DAILY' ? 'RPD' : (/tpm|token/i.test(msg) ? 'TPM' : (rawScope === 'PER_MINUTE' ? 'RPM' : undefined)));
    return { scope: rawScope, subScope: inferredSub, retryAfterMs, learnedLimit: buildLearned(inferredSub) };
  }

  const lower = msg.toLowerCase();
  const status = typeof anyErr.httpStatus === 'number'
    ? anyErr.httpStatus
    : (typeof anyErr.status === 'number' ? anyErr.status : undefined);

  if (status === 401 || status === 403 || !isFallbackEligible(err)) {
    return { scope: 'AUTH', retryAfterMs };
  }
  if (status === 404 || lower.includes('404') || lower.includes('no longer available') || lower.includes('not supported for generatecontent')) {
    return { scope: 'NOT_FOUND', retryAfterMs };
  }
  if (/per\s*day|daily|rpd|tpd|requestsperday/i.test(msg) || (retryAfterMs !== undefined && retryAfterMs > 300_000)) {
    const sub: 'RPD' | 'TPD' = /\btpd\b|tokens?\s*per\s*day/i.test(msg) ? 'TPD' : 'RPD';
    return { scope: 'DAILY', subScope: sub, retryAfterMs, learnedLimit: buildLearned(sub) };
  }
  if (status === 429 || /429|rate[- ]limit|resource_exhausted|quota|too many requests|per\s*minute|\brpm\b|\btpm\b/i.test(msg)) {
    const sub: 'RPM' | 'TPM' = /\btpm\b|tokens?\s*per\s*minute|tokensperminute/i.test(msg) ? 'TPM' : 'RPM';
    return { scope: 'PER_MINUTE', subScope: sub, retryAfterMs, learnedLimit: buildLearned(sub) };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504 || /500|502|503|504|overload|high demand|unavailable|timeout/i.test(lower)) {
    return { scope: 'OVERLOAD', retryAfterMs };
  }
  return { scope: 'TRANSIENT', retryAfterMs };
}

function rotateByOffset<T>(items: T[], offsetIndex?: number): T[] {
  if (typeof offsetIndex !== 'number' || items.length <= 1) return [...items];
  const offset = ((offsetIndex % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function sleepMs(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export class ModelRouter {
  /** Checks if a specific model profile supports vision using centralized profile capability resolution.
   * Never passes raw `StoredProfile.metadata` as trusted live-API provider metadata (`AUD-LMS-01`).
   */
  static isVisionCapable(profile: StoredProfile): boolean {
    const cleanProfile = sanitizeStoredProfile(profile) || profile;

    // 1. User declared capabilities on profile (explicit declaration via `userDeclaredCapabilities.vision`, classified as USER_DECLARED)
    if (cleanProfile.userDeclaredCapabilities?.vision !== undefined) {
      return Boolean(cleanProfile.userDeclaredCapabilities.vision);
    }

    // 2. Custom provider or non-official endpoint without explicit userDeclaredCapabilities: NEVER allow automatic vision!
    const isOfficial = isOfficialEndpoint(cleanProfile.provider, cleanProfile.endpoint);
    if (!isOfficial) {
      return false;
    }

    // 3. Resolve via strict profile capability resolver (sanitizes metadata; forged isTrustedLiveApi/provenance never reaches catalog)
    const resolved = resolveProfileCapabilities(cleanProfile);

    // 4. Strict vision routing: ONLY allow VERIFIED or genuine PROVIDER_REPORTED on official endpoints with vision: true
    if (resolved.capabilitySource === 'VERIFIED' && resolved.capabilities.vision) {
      return true;
    }
    if (resolved.capabilitySource === 'PROVIDER_REPORTED' && resolved.capabilities.vision) {
      return true;
    }

    // USER_DECLARED (without explicit userDeclaredCapabilities.vision), INFERRED, and UNKNOWN models are NEVER permitted for automatic vision routing
    return false;
  }

  /** Resolves the ordered, loop-free list of eligible candidate models */
  static async resolveCandidates(options: RouteOptions = {}): Promise<RoutingPlan> {
    const db = options.db || await readProfilesDb();
    const available = db.profiles || {};
    const availableIds = Object.keys(available);

    if (availableIds.length === 0) {
      throw new Error('Chưa có model AI nào được cấu hình trong Model Center. Chạy npm run models trước.');
    }

    const isOverride = Boolean(options.profileOverride && available[options.profileOverride]);
    const requestedModel = options.modelOverride?.trim() || undefined;
    const requestedModelLower = requestedModel?.toLowerCase();
    const isGeminiFamilyModel = Boolean(requestedModelLower && /^(gemini|gemma)-/.test(requestedModelLower));
    const primaryId = isOverride
      ? options.profileOverride!
      : (db.default && available[db.default] ? db.default : availableIds[0]);

    // Candidate fallback list: task override if specified, otherwise Model Center db.fallbacks
    const fallbackList = options.fallbackOverrides && options.fallbackOverrides.length > 0
      ? options.fallbackOverrides
      : (db.fallbacks || []);

    const visited = new Set<string>();
    const configuredKeys = new Set<string>();
    const candidates: RouteCandidate[] = [];
    const shouldExpandPool = options.expandModelPool ?? !options.db;

    // Helper to evaluate and push candidate deduplicated by (profileId, keySlot, model)
    const consider = (pId: string, modelOverride?: string, keySlotOverride?: string) => {
      const prof = available[pId];
      if (!prof) return;
      const targetModel = (modelOverride || prof.model || '').trim();
      if (!targetModel) return;
      const slots = keySlotOverride ? [keySlotOverride] : getProfileKeySlots(pId, prof);

      const effectiveProfile: StoredProfile = targetModel !== prof.model
        ? { ...prof, model: targetModel, userDeclaredCapabilities: undefined }
        : prof;
      const hasVision = ModelRouter.isVisionCapable(effectiveProfile);

      // Vision capability filter: If task requires vision, reject non-vision models (e.g. Gemma)
      if (options.requiresVision && !hasVision) {
        return;
      }

      for (const slotId of slots) {
        const dedupeKey = getCooldownKey(pId, targetModel, slotId);
        if (visited.has(dedupeKey)) continue;
        visited.add(dedupeKey);
        if (!modelOverride) {
          configuredKeys.add(dedupeKey);
        }

        candidates.push({
          profileId: pId,
          ...(slotId && slotId !== pId ? { keySlot: slotId } : {}),
          provider: prof.provider,
          model: targetModel,
          supportsVision: hasVision
        });
      }
    };

    // Interleaves slot #1 across profiles, then slot #2 across profiles, etc. for balanced rotation
    const considerInterleaved = (pIds: string[], modelOverride?: string) => {
      const slotLists = pIds.map(id => getProfileKeySlots(id, available[id]));
      const maxSlots = Math.max(0, ...slotLists.map(s => s.length));
      for (let sIdx = 0; sIdx < maxSlots; sIdx++) {
        for (let pIdx = 0; pIdx < pIds.length; pIdx++) {
          const slot = slotLists[pIdx][sIdx];
          if (slot) consider(pIds[pIdx], modelOverride, slot);
        }
      }
    };

    // 0. If caller/user explicitly chose a model, prioritize it across all compatible active profiles/key-slots first
    if (requestedModel) {
      const orderedIds = Array.from(new Set([primaryId, ...fallbackList, ...availableIds]));
      const compatIds = orderedIds.filter(id => {
        const prof = available[id];
        if (!prof || prof.verifiedStatus === 'FAILED') return false;
        const exactConfiguredMatch = prof.model.trim().toLowerCase() === requestedModelLower;
        const compatibleGemini = prof.provider === 'gemini' && isGeminiFamilyModel;
        return exactConfiguredMatch || compatibleGemini;
      });
      considerInterleaved(compatIds, requestedModel);
    }

    // 1–3. Try primary, fallback list, and remaining verified profiles (slot #1 first, then extra key slots)
    const activeOrderedIds = Array.from(new Set([
      primaryId,
      ...fallbackList,
      ...availableIds.filter(id => available[id]?.verifiedStatus === 'VERIFIED')
    ])).filter(id => Boolean(available[id]));
    considerInterleaved(activeOrderedIds);

    // 4. Expand verified Gemini keys/slots across GEMINI_AUTO_MODEL_POOL (interleaved per model across keys)
    if (shouldExpandPool) {
      const geminiIds: string[] = [];
      const seenGemini = new Set<string>();
      const pushIfEligibleGemini = (id: string, requireVerifiedFlag: boolean) => {
        if (seenGemini.has(id)) return;
        const prof = available[id];
        if (!prof || prof.provider !== 'gemini' || prof.verifiedStatus === 'FAILED') return;
        if (requireVerifiedFlag && prof.verifiedStatus !== 'VERIFIED') return;
        seenGemini.add(id);
        geminiIds.push(id);
      };

      pushIfEligibleGemini(primaryId, false);
      for (const fId of fallbackList) pushIfEligibleGemini(fId, false);
      for (const id of availableIds) pushIfEligibleGemini(id, true);

      for (const poolModel of GEMINI_AUTO_MODEL_POOL) {
        considerInterleaved(geminiIds, poolModel);
      }
    }

    // 5. Partition by cooldown state, proactive RPM/TPM sliding window, model overload circuit breaker & quota tier
    const isCustomDb = Boolean(options.db);
    const useCooldowns = !options.disableCooldown && (!isCustomDb || Boolean(options.expandModelPool) || Boolean(options.waitOnRateLimit) || Boolean(requestedModel) || Boolean(options.enableTelemetryRotation));
    const useTelemetryRouting = Boolean(options.enableTelemetryRotation ?? !isCustomDb);
    if (useTelemetryRouting && !isCustomDb) {
      ensureTelemetryLoaded();
    }
    if (useCooldowns && candidates.length > 1) {
      const now = Date.now();
      const todayKey = getPacificDayKey(now);
      const estReqTokens = Math.max(0, options.estimatedTokens ?? 0);
      const tier0ChosenHealthy: RouteCandidate[] = []; // Explicit user-chosen modelOverride
      const tier1Healthy: RouteCandidate[] = []; // Primary tier (Flash strong when preferAccuracy, or Flash-Lite)
      const tier2Healthy: RouteCandidate[] = []; // Secondary backup models
      const tier3Healthy: RouteCandidate[] = []; // Gemma 4 text/JSON high-RPD fallback
      const shortCooling: { candidate: RouteCandidate; expiresAt: number }[] = [];
      const dailyExhausted: RouteCandidate[] = [];

      for (const cand of candidates) {
        const key = getCooldownKey(cand.profileId, cand.model, cand.keySlot);
        const cd = profileCooldowns.get(key);
        const dailyResetCrossed = Boolean(cd && cd.scope === 'DAILY' && cd.dailyBucketKey && cd.dailyBucketKey !== todayKey);
        if (cd && now < cd.expiresAt && !dailyResetCrossed) {
          const remaining = cd.expiresAt - now;
          if (cd.scope === 'DAILY' || remaining > SHORT_COOLDOWN_CUTOFF_MS) {
            dailyExhausted.push(cand);
          } else {
            shortCooling.push({ candidate: cand, expiresAt: cd.expiresAt });
          }
          continue;
        }
        if (cd && (now >= cd.expiresAt || dailyResetCrossed)) {
          profileCooldowns.delete(key);
        }

        // Model-wide overload circuit breaker: skip globally overloaded model across all keys until cooldown lifts
        if (useTelemetryRouting) {
          const ov = modelOverloadTracker.get(cand.model);
          if (ov && now < ov.blockedUntil) {
            shortCooling.push({ candidate: cand, expiresAt: ov.blockedUntil });
            continue;
          }
          if (ov && now >= ov.blockedUntil && ov.blockedUntil > 0) {
            modelOverloadTracker.delete(cand.model);
          }

          // Proactive RPM / TPM / RPD rotation BEFORE hitting HTTP 429
          const tel = slotModelTelemetry.get(key);
          if (tel) {
            const cutoff = now - SLIDING_WINDOW_MS;
            const reqs60 = tel.requestTimestamps.filter(t => t >= cutoff);
            const toks60 = tel.tokenTimestamps.filter(t => t.ts >= cutoff);
            tel.requestTimestamps = reqs60;
            tel.tokenTimestamps = toks60;
            const sameDay = tel.dailyBucketKey === todayKey;
            const baseLimits = getDefaultModelRateLimits(cand.model);
            const limits: ModelRateLimits = {
              rpm: tel.learnedLimits?.rpm ?? baseLimits.rpm,
              tpm: tel.learnedLimits?.tpm ?? baseLimits.tpm,
              rpd: tel.learnedLimits?.rpd ?? baseLimits.rpd
            };

            if (sameDay && limits.rpd > 0 && tel.dailyRequests >= limits.rpd) {
              const resetMs = getNextPacificMidnightMs(now);
              profileCooldowns.set(key, {
                expiresAt: resetMs,
                scope: 'DAILY',
                subScope: 'RPD',
                dailyBucketKey: todayKey,
                reason: `Proactive RPD limit reached (${tel.dailyRequests}/${limits.rpd})`
              });
              dailyExhausted.push(cand);
              continue;
            }

            const usedTpm60s = toks60.reduce((sum, x) => sum + x.total, 0);
            const rpmHit = limits.rpm > 0 && reqs60.length >= limits.rpm;
            const tpmHit = limits.tpm > 0 && (
              usedTpm60s >= limits.tpm * 0.92 ||
              (usedTpm60s > 0 && estReqTokens > 0 && usedTpm60s + estReqTokens >= limits.tpm * 0.95)
            );
            if (rpmHit || tpmHit) {
              const oldestTs = Math.min(
                reqs60[0] ?? Infinity,
                toks60[0]?.ts ?? Infinity
              );
              const resetAt = Number.isFinite(oldestTs) ? Math.max(now + 3_000, oldestTs + SLIDING_WINDOW_MS) : now + 30_000;
              shortCooling.push({ candidate: cand, expiresAt: resetAt });
              continue;
            }
          }
        }

        if (requestedModelLower && cand.model.toLowerCase() === requestedModelLower) {
          tier0ChosenHealthy.push(cand);
        } else if (cand.model.startsWith('gemma-')) {
          tier3Healthy.push(cand);
        } else if (options.taskRole === 'planner' && !requestedModelLower && !isOverride && shouldExpandPool) {
          // For lightweight multi-step navigation planning, prioritize high-RPD flash-lite models in tier 1
          if (cand.model.includes('flash-lite')) {
            tier1Healthy.push(cand);
          } else {
            tier2Healthy.push(cand);
          }
        } else if (options.preferAccuracy && !isOverride) {
          // For accuracy-sensitive tasks (quiz solving), put full Flash/Pro reasoning models ahead of flash-lite
          if (cand.model.includes('flash-lite')) {
            tier2Healthy.push(cand);
          } else {
            tier1Healthy.push(cand);
          }
        } else if (configuredKeys.has(key) || cand.model.includes('flash-lite')) {
          tier1Healthy.push(cand);
        } else {
          tier2Healthy.push(cand);
        }
      }

      // Pin last-known-good model family to the front of tier1Healthy (preserving key-slot rotation across keys)
      if (useTelemetryRouting && lastGoodModelId && tier1Healthy.length > 1 && !requestedModelLower) {
        const pinned = tier1Healthy.filter(c => c.model === lastGoodModelId);
        if (pinned.length > 0 && pinned.length < tier1Healthy.length) {
          const rest = tier1Healthy.filter(c => c.model !== lastGoodModelId);
          tier1Healthy.length = 0;
          tier1Healthy.push(...pinned, ...rest);
        }
      }

      shortCooling.sort((a, b) => a.expiresAt - b.expiresAt);

      const rotateTier = (tier: RouteCandidate[]) => {
        if (tier.length <= 1 || typeof options.roundRobinIndex !== 'number') return tier;
        if (!isOverride) return rotateByOffset(tier, options.roundRobinIndex);
        // Even with explicit profileOverride, rotate all key slots belonging to that overridden profile
        const own = tier.filter(c => c.profileId === primaryId);
        const rest = tier.filter(c => c.profileId !== primaryId);
        return [...rotateByOffset(own, options.roundRobinIndex), ...rotateByOffset(rest, options.roundRobinIndex)];
      };

      const rotatedTier0 = rotateTier(tier0ChosenHealthy);
      const rotatedTier1 = rotateTier(tier1Healthy);
      const finalTier2 = (tier0ChosenHealthy.length === 0 && tier1Healthy.length === 0)
        ? rotateTier(tier2Healthy)
        : tier2Healthy;
      const orderedCooling = shortCooling.map(entry => entry.candidate);

      candidates.length = 0;
      candidates.push(...rotatedTier0, ...rotatedTier1, ...finalTier2, ...tier3Healthy, ...orderedCooling, ...dailyExhausted);
    }

    if (candidates.length === 0) {
      if (options.requiresVision) {
        throw new Error('Tác vụ yêu cầu xử lý hình ảnh (Vision), nhưng không có model nào hỗ trợ Vision được xác minh trong hệ thống. Hãy thêm model Vision chính thức hoặc khai báo capability trong Model Center.');
      }
      throw new Error('Không tìm thấy model khả dụng phù hợp với yêu cầu tác vụ.');
    }

    return {
      primary: candidates[0],
      candidates,
      source: (isOverride || Boolean(requestedModel)) ? 'TASK_OVERRIDE' : 'MODEL_CENTER_DEFAULT'
    };
  }

  /** Executes an AI prompt through the unified router with fallback, per-(profile,keySlot,model) cooldowns, proactive RPM/TPM rotation, and RPM pause/retry */
  static async execute(
    req: PromptInput,
    options: RouteOptions = {},
    callFn = callModel
  ): Promise<RouterExecutionResult> {
    const requiresVision = options.requiresVision || Boolean(req.imageBase64);
    const maxAttempts = Math.max(1, Math.min(3, options.maxAttemptsPerModel ?? 1));
    const isCustomDb = Boolean(options.db);
    const useCooldowns = !options.disableCooldown && (!isCustomDb || Boolean(options.expandModelPool) || Boolean(options.waitOnRateLimit) || Boolean(options.enableTelemetryRotation));
    const useTelemetryRouting = Boolean(options.enableTelemetryRotation ?? !isCustomDb);
    const shouldWaitOnRateLimit = options.waitOnRateLimit ?? !isCustomDb;
    const maxWaitCycles = shouldWaitOnRateLimit ? Math.max(0, options.maxRateLimitWaitCycles ?? 5) : 0;
    const labelWithModel = Boolean(options.expandModelPool ?? !isCustomDb);
    const estPromptTokens = options.estimatedTokens ?? (Math.ceil(((req.system?.length || 0) + (req.text?.length || 0)) / 4) + (req.imageBase64 ? 258 : 0));

    const history: { profileId: string; keySlot?: string; model?: string; error?: string; latencyMs: number }[] = [];
    const resolvedCache = new Map<string, ResolvedProvider>();
    let totalAttempts = 0;
    let fallbackCount = 0;
    let lastError: unknown;
    let initialProfile = '';
    let lastCandidateCount = 0;
    let lastAttemptedLabel: string | undefined;

    const formatLabel = (cand: RouteCandidate) => {
      const slotTag = cand.keySlot && cand.keySlot !== cand.profileId
        ? `#${cand.keySlot.replace(new RegExp(`^${cand.profileId}_*`), '') || cand.keySlot}`
        : '';
      return labelWithModel ? `${cand.profileId}${slotTag}/${cand.model}` : `${cand.profileId}${slotTag}`;
    };

    const clearExpiredCooldowns = () => {
      const now = Date.now();
      const todayKey = getPacificDayKey(now);
      for (const [key, entry] of profileCooldowns.entries()) {
        if (now >= entry.expiresAt || (entry.scope === 'DAILY' && entry.dailyBucketKey && entry.dailyBucketKey !== todayKey)) {
          profileCooldowns.delete(key);
        }
      }
      for (const [m, ov] of modelOverloadTracker.entries()) {
        if (now >= ov.blockedUntil && ov.blockedUntil > 0) {
          modelOverloadTracker.delete(m);
        }
      }
    };

    const waitForRateLimitRecovery = async (waitMs: number, cycle: number, reason: string) => {
      if (options.onRateLimitWait) {
        try {
          options.onRateLimitWait({ waitMs, cycle, maxCycles: maxWaitCycles, reason: redactSecrets(reason) });
        } catch {}
      }
      await sleepMs(waitMs);
      clearExpiredCooldowns();
      // If a fixed test delay <60s completed, clear PER_MINUTE/OVERLOAD entries so the retry cycle re-evaluates them cleanly
      if (waitMs < DEFAULT_RPM_WAIT_MS) {
        for (const [key, entry] of profileCooldowns.entries()) {
          if (entry.scope !== 'DAILY') {
            profileCooldowns.delete(key);
          }
        }
        modelOverloadTracker.clear();
      }
    };

    for (let waitCycle = 0; waitCycle <= maxWaitCycles; waitCycle++) {
      clearExpiredCooldowns();
      const plan = await ModelRouter.resolveCandidates({ ...options, estimatedTokens: estPromptTokens, requiresVision });
      if (!initialProfile) {
        initialProfile = plan.primary.profileId;
      }
      lastCandidateCount = plan.candidates.length;

      // Inspect cooldown & sliding-window status of candidates before firing calls
      const now = Date.now();
      const todayKey = getPacificDayKey(now);
      let hasHealthy = false;
      let minShortWaitRemaining = Infinity;
      let hasShortCooling = false;

      if (useCooldowns) {
        for (const cand of plan.candidates) {
          const cdKey = getCooldownKey(cand.profileId, cand.model, cand.keySlot);
          const cd = profileCooldowns.get(cdKey);
          const ov = useTelemetryRouting ? modelOverloadTracker.get(cand.model) : undefined;
          if (ov && now < ov.blockedUntil) {
            hasShortCooling = true;
            minShortWaitRemaining = Math.min(minShortWaitRemaining, ov.blockedUntil - now);
            continue;
          }
          if (!cd || now >= cd.expiresAt || (cd.scope === 'DAILY' && cd.dailyBucketKey && cd.dailyBucketKey !== todayKey)) {
            if (useTelemetryRouting) {
              const tel = slotModelTelemetry.get(cdKey);
              if (tel) {
                const cutoff = now - SLIDING_WINDOW_MS;
                const reqs60 = tel.requestTimestamps.filter(t => t >= cutoff);
                const toks60 = tel.tokenTimestamps.filter(t => t.ts >= cutoff);
                const baseLimits = getDefaultModelRateLimits(cand.model);
                const rpmLim = tel.learnedLimits?.rpm ?? baseLimits.rpm;
                const tpmLim = tel.learnedLimits?.tpm ?? baseLimits.tpm;
                const usedTpm = toks60.reduce((sum, x) => sum + x.total, 0);
                if ((rpmLim > 0 && reqs60.length >= rpmLim) || (tpmLim > 0 && usedTpm >= tpmLim * 0.92)) {
                  const oldestTs = Math.min(reqs60[0] ?? Infinity, toks60[0]?.ts ?? Infinity);
                  const rem = Number.isFinite(oldestTs) ? Math.max(3_000, oldestTs + SLIDING_WINDOW_MS - now) : 30_000;
                  hasShortCooling = true;
                  if (rem < minShortWaitRemaining) minShortWaitRemaining = rem;
                  continue;
                }
              }
            }
            hasHealthy = true;
            break;
          }
          const remaining = cd.expiresAt - now;
          if (cd.scope !== 'DAILY' && remaining <= SHORT_COOLDOWN_CUTOFF_MS) {
            hasShortCooling = true;
            if (remaining < minShortWaitRemaining) minShortWaitRemaining = remaining;
          }
        }

        if (!hasHealthy && hasShortCooling && shouldWaitOnRateLimit && waitCycle < maxWaitCycles) {
          const computedWait = typeof options.rateLimitWaitMs === 'number'
            ? Math.max(0, options.rateLimitWaitMs)
            : Math.min(MAX_RPM_WAIT_MS, Math.max(1_000, minShortWaitRemaining + 1_000));
          await waitForRateLimitRecovery(computedWait, waitCycle + 1, 'Tất cả model/key khả dụng đang trong cửa sổ giới hạn RPM/TPM.');
          continue;
        }
      } else {
        hasHealthy = true;
      }

      const hasRecoverableInPlan = hasHealthy || hasShortCooling;
      let hadRecoverableRateLimit = false;
      let cycleMinWaitMs = DEFAULT_RPM_WAIT_MS;

      for (let cIdx = 0; cIdx < plan.candidates.length; cIdx++) {
        const candidate = plan.candidates[cIdx];
        const key = getCooldownKey(candidate.profileId, candidate.model, candidate.keySlot);

        if (useCooldowns && hasRecoverableInPlan) {
          const activeCd = profileCooldowns.get(key);
          if (activeCd && Date.now() < activeCd.expiresAt && activeCd.scope === 'DAILY') {
            continue;
          }
        }

        const currentLabel = formatLabel(candidate);
        if (lastAttemptedLabel && lastAttemptedLabel !== currentLabel) {
          fallbackCount++;
          const rawReason = lastError instanceof Error ? lastError.message : String(lastError || 'Fallback');
          const reason = redactSecrets(rawReason);
          if (options.onModelSwitch) {
            try {
              options.onModelSwitch(lastAttemptedLabel, currentLabel, reason);
            } catch {}
          }
        }
        lastAttemptedLabel = currentLabel;

        const cacheKey = `${candidate.profileId}::${candidate.keySlot || candidate.profileId}`;
        let baseProvider = resolvedCache.get(cacheKey);
        if (!baseProvider) {
          try {
            const resolveCandidate = options.resolveFn || resolveProvider;
            baseProvider = await resolveCandidate({
              profileId: candidate.profileId,
              ...(candidate.keySlot ? { keySlot: candidate.keySlot } : {})
            });
            resolvedCache.set(cacheKey, baseProvider);
          } catch (initErr) {
            const cleanInitErr = sanitizeProviderError(initErr, candidate.profileId, candidate.provider);
            lastError = cleanInitErr;
            history.push({
              profileId: candidate.profileId,
              ...(candidate.keySlot ? { keySlot: candidate.keySlot } : {}),
              model: candidate.model,
              error: cleanInitErr.message,
              latencyMs: 0
            });
            if (!isFallbackEligible(initErr)) {
              throw cleanInitErr;
            }
            continue;
          }
        }

        const effectiveProvider: ResolvedProvider = {
          ...baseProvider,
          ...(candidate.model ? { model: candidate.model } : {}),
          profileId: candidate.profileId,
          keySlot: candidate.keySlot || candidate.profileId
        };

        // Adaptive fast-fail timeout when healthy backups remain so one stalled preview model never burns 140s
        const hasMoreBackups = cIdx + 1 < plan.candidates.length;
        const effectiveReq: PromptInput = (!req.timeoutMs && callFn === callModel && !isCustomDb && hasMoreBackups)
          ? { ...req, timeoutMs: requiresVision ? 35_000 : 22_000 }
          : req;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          totalAttempts++;
          const start = Date.now();
          try {
            if (req.imageBase64 && !candidate.supportsVision) {
              throw new Error(
                `Bảo mật Vision: Chặn gửi ảnh/tài liệu tới model "${candidate.model}" (profile "${candidate.profileId}") vì chưa xác minh hỗ trợ Vision.`
              );
            }
            const output = await callFn(effectiveProvider, effectiveReq);
            const latencyMs = Date.now() - start;
            history.push({
              profileId: candidate.profileId,
              ...(candidate.keySlot ? { keySlot: candidate.keySlot } : {}),
              model: candidate.model,
              latencyMs
            });

            profileCooldowns.delete(key);
            if (useTelemetryRouting) {
              modelOverloadTracker.delete(candidate.model);
              if (!candidate.model.startsWith('gemma-')) {
                lastGoodModelId = candidate.model;
              }
              if (options.enableTelemetryRotation && callFn !== callModel) {
                const estOut = Math.ceil(output.length / 4);
                recordKeySlotUsage({
                  profileId: candidate.profileId,
                  keySlot: candidate.keySlot || candidate.profileId,
                  provider: candidate.provider,
                  model: candidate.model,
                  promptTokens: estPromptTokens,
                  outputTokens: estOut,
                  totalTokens: estPromptTokens + estOut,
                  latencyMs,
                  timestamp: Date.now()
                }, !isCustomDb);
              }
            }

            return {
              output,
              initialProfile,
              finalProfile: candidate.profileId,
              ...(candidate.keySlot ? { keySlotUsed: candidate.keySlot } : {}),
              modelUsed: candidate.model,
              attempts: totalAttempts,
              fallbackCount,
              history
            };
          } catch (err) {
            const latencyMs = Date.now() - start;
            const msg = redactSecrets(err instanceof Error ? err.message : String(err));
            history.push({
              profileId: candidate.profileId,
              ...(candidate.keySlot ? { keySlot: candidate.keySlot } : {}),
              model: candidate.model,
              error: msg,
              latencyMs
            });
            lastError = err;

            if (!isFallbackEligible(err)) {
              throw sanitizeProviderError(err, candidate.profileId, candidate.provider);
            }

            const { scope, subScope, retryAfterMs, learnedLimit } = classifyProviderError(err);
            if (useTelemetryRouting) {
              recordKeySlotErrorTelemetry(candidate.profileId, candidate.model, candidate.keySlot, msg, learnedLimit, !isCustomDb);
            }

            if (scope === 'DAILY' || scope === 'NOT_FOUND') {
              if (useCooldowns) {
                const nowErr = Date.now();
                const nextReset = getNextPacificMidnightMs(nowErr);
                profileCooldowns.set(key, {
                  expiresAt: scope === 'DAILY' ? nextReset : nowErr + DAILY_COOLDOWN_MS,
                  scope: 'DAILY',
                  subScope,
                  dailyBucketKey: getPacificDayKey(nowErr),
                  reason: msg
                });
              }
              break;
            }

            if (scope === 'PER_MINUTE' || scope === 'OVERLOAD') {
              hadRecoverableRateLimit = true;
              const cdMs = scope === 'PER_MINUTE'
                ? (retryAfterMs ? Math.min(SHORT_COOLDOWN_CUTOFF_MS, Math.max(15_000, retryAfterMs)) : DEFAULT_RPM_WAIT_MS)
                : 30_000;
              if (retryAfterMs && retryAfterMs < MAX_RPM_WAIT_MS && retryAfterMs > cycleMinWaitMs) {
                cycleMinWaitMs = retryAfterMs + 1_000;
              }
              if (useCooldowns) {
                profileCooldowns.set(key, { expiresAt: Date.now() + cdMs, scope, subScope, reason: msg });
                if (scope === 'OVERLOAD' && useTelemetryRouting) {
                  const nowOv = Date.now();
                  const prevOv = modelOverloadTracker.get(candidate.model);
                  if (prevOv && nowOv - prevOv.firstFailAt <= 60_000) {
                    const failCount = prevOv.failCount + 1;
                    modelOverloadTracker.set(candidate.model, {
                      failCount,
                      firstFailAt: prevOv.firstFailAt,
                      blockedUntil: failCount >= 2 ? nowOv + 120_000 : 0
                    });
                  } else {
                    modelOverloadTracker.set(candidate.model, { failCount: 1, firstFailAt: nowOv, blockedUntil: 0 });
                  }
                }
              }
              // On 429 RPM/TPM or 503/timeout OVERLOAD when backup keys/models remain, switch immediately instead of wasting minutes retrying
              if (scope === 'PER_MINUTE' || (scope === 'OVERLOAD' && cIdx + 1 < plan.candidates.length)) {
                break;
              }
            }

            if (attempt < maxAttempts) {
              await sleepMs(Math.min(2000, 500 * attempt));
            }
          }
        }
      }

      if (hadRecoverableRateLimit && shouldWaitOnRateLimit && waitCycle < maxWaitCycles) {
        const waitMs = typeof options.rateLimitWaitMs === 'number'
          ? Math.max(0, options.rateLimitWaitMs)
          : Math.min(MAX_RPM_WAIT_MS, Math.max(DEFAULT_RPM_WAIT_MS, cycleMinWaitMs));
        const reason = redactSecrets(lastError instanceof Error ? lastError.message : String(lastError || 'HTTP 429 Rate Limit'));
        await waitForRateLimitRecovery(waitMs, waitCycle + 1, reason);
        continue;
      }

      break;
    }

    const lastErrClean = redactSecrets(lastError instanceof Error ? lastError.message : String(lastError));
    const finalErr = new Error(
      `Toàn bộ ${totalAttempts} lần gọi qua ${lastCandidateCount} model đều thất bại. Lỗi cuối: ${lastErrClean}`
    );
    (finalErr as any).isFallbackEligible = false;
    throw finalErr;
  }
}
