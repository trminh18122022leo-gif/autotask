/** Live Multi-Provider Quota, Telemetry & Rate-Limit Inspector (per API key & per model of each key). */
import { createHash } from 'node:crypto';
import { readProfilesDb, getProfileKeySlots } from './routing.js';
import {
  GEMINI_AUTO_MODEL_POOL,
  VERIFIED_CAPABILITIES,
  inferCapabilities,
  PROVIDER_REGISTRY,
  fetchLiveModels,
  isOfficialEndpoint,
  getStaticModels
} from './catalog.js';
import {
  resolveProvider,
  parseProviderHttpError,
  parseRetryDelayMs,
  extractRateLimitHeaders,
  type ProviderSpec,
  type ResolvedProvider
} from '../providers.js';
import {
  getKeySlotTelemetrySnapshot,
  syncCooldownFromProbe,
  getNextPacificMidnightMs,
  getDefaultModelRateLimits,
  recordKeySlotUsage,
  type RateLimitSource
} from './model-router.js';
import type { ModelProfilesDb, ProviderId, ProviderKind } from './types.js';
import { redactSecrets } from '../security/redact.js';
import { paint, badge, renderSparkline, renderMeterBar } from '../ui/tokyo.js';

function detectProviderKeyPrefix(rawKey: string): ProviderId | undefined {
  const k = rawKey.trim();
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return 'gemini';
  if (/^gsk_[0-9A-Za-z_-]{20,}$/.test(k)) return 'groq';
  if (/^sk-ant-[0-9A-Za-z_-]{20,}$/.test(k)) return 'anthropic';
  if (/^sk-[0-9A-Za-z_-]{20,}$/.test(k)) return 'openai';
  return undefined;
}

export type ModelQuotaState =
  | 'AVAILABLE'
  | 'RPM_TPM_LIMITED'
  | 'DAILY_EXHAUSTED'
  | 'NOT_FOUND'
  | 'AUTH_ERROR'
  | 'ERROR';

export interface GeminiModelSpec {
  id: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportedGenerationMethods?: string[];
}

export interface ModelQuotaProbeResult {
  model: string;
  state: ModelQuotaState;
  rateLimitSubScope?: 'RPM' | 'TPM' | 'RPD' | 'TPD';
  httpStatus?: number;
  latencyMs: number;
  knownTierLimits: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  usedRpm60s?: number;
  usedTpm60s?: number;
  usedRpdToday?: number;
  usedTokensToday?: number;
  rpmLimit?: number;
  tpmLimit?: number;
  rpdLimit?: number;
  rpmRemaining?: number;
  tpmRemaining?: number;
  rpdRemaining?: number;
  limitSource?: RateLimitSource;
  avgLatencyMs?: number;
  cooldownRemainingSec?: number;
  probed?: boolean;
  quotaId?: string;
  quotaMetric?: string;
  quotaLimitValue?: string;
  retryAfterText?: string;
  detail?: string;
}

export interface ProfileQuotaSummary {
  profileId: string;
  keySlot?: string;
  keySlotIndex?: number;
  provider?: ProviderId;
  providerName?: string;
  configuredModel: string;
  keyHint: string;
  keyFingerprint?: string;
  keyValid: boolean;
  keyStatusLabel?: string;
  listedModelsCount: number;
  availableModelsCount?: number;
  rateLimitedModelsCount?: number;
  exhaustedModelsCount?: number;
  totalRequestsToday?: number;
  totalTokensToday?: number;
  results: ModelQuotaProbeResult[];
}

export interface QuotaCheckReport {
  checkedAt: string;
  vietnamResetTimeText: string;
  nextResetInText?: string;
  profiles: ProfileQuotaSummary[];
  sharedProjectSuspected: boolean;
  sharedProjectReason?: string;
}

export interface SingleKeySpecReport {
  provider: ProviderId;
  providerName: string;
  keyHint: string;
  keyValid: boolean;
  vietnamResetTimeText: string;
  nextResetInText: string;
  listedModelsCount: number;
  models: {
    id: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportsVision: boolean;
    supportsThinking?: boolean;
    tierLimits: string;
    rpmLimit?: number;
    tpmLimit?: number;
    rpdLimit?: number;
  }[];
  probedSample?: ModelQuotaProbeResult[];
  note?: string;
}

export interface CheckAllQuotaOptions {
  providerFilter?: ProviderId;
  profileId?: string;
  keySlot?: string;
  includeAllListedModels?: boolean;
  models?: string[];
  db?: ModelProfilesDb;
  resolveFn?: (spec: ProviderSpec) => Promise<ResolvedProvider>;
}

const REFERENCE_QUOTAS: Record<string, string> = {
  'gemini-3.5-flash-lite': '15 RPM | 250K TPM | 500 RPD',
  'gemini-3.1-flash-lite': '15 RPM | 250K TPM | 500 RPD',
  'gemini-3.1-flash-lite-preview': '15 RPM | 250K TPM | 500 RPD',
  'gemini-flash-lite-latest': '15 RPM | 250K TPM | 500 RPD',
  'gemini-3-flash-preview': '5 RPM | 250K TPM | 20 RPD',
  'gemini-3.6-flash': '5 RPM | 250K TPM | 20 RPD',
  'gemini-3.7-flash': '5 RPM | 250K TPM | 20 RPD',
  'gemini-3.8-flash': '5 RPM | 250K TPM | 20 RPD',
  'gemini-3.5-flash': '5 RPM | 250K TPM | 20 RPD',
  'gemini-flash-latest': '5 RPM | 250K TPM | 20 RPD',
  'gemini-2.5-flash': '10 RPM | 250K TPM | 250 RPD',
  'gemini-2.5-flash-lite': '15 RPM | 250K TPM | 1K RPD',
  'gemini-3.1-pro-preview': 'Paid/Preview | Pro reasoning',
  'gemini-3-pro-preview': 'Paid/Preview | Pro reasoning',
  'gemini-2.5-pro': '5 RPM | 250K TPM | 100 RPD',
  'gemini-2.0-flash': '15 RPM | 1M TPM | 1.5K RPD',
  'gemini-2.0-flash-lite': '30 RPM | 1M TPM | 1.5K RPD',
  'gemma-4-26b-a4b-it': '30 RPM | 15K TPM | 14.4K RPD',
  'gemma-4-31b-it': '30 RPM | 15K TPM | 14.4K RPD',
  'llama-3.3-70b-versatile': '30 RPM | 12K TPM | 1K RPD',
  'llama-3.1-8b-instant': '30 RPM | 6K TPM | 14.4K RPD',
  'mixtral-8x7b-32768': '30 RPM | 5K TPM | 14.4K RPD'
};

/** Computes today/next midnight Pacific Time in Vietnam local time (UTC+7) accounting for PST/PDT. */
export function getPacificMidnightResetInVietnam(now = new Date()): string {
  const ptHourParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset'
  }).formatToParts(now);
  const tzOffsetStr = ptHourParts.find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = tzOffsetStr.match(/GMT([+-]\d+)/);
  const ptOffsetHours = match ? Number(match[1]) : -8; // -8 (PST) or -7 (PDT)
  const vnResetHour = (0 - ptOffsetHours) + 7; // 00:00 PT -> UTC+7
  const seasonLabel = ptOffsetHours === -7 ? 'PDT mùa hè' : 'PST mùa đông';
  return `${String(vnResetHour).padStart(2, '0')}:00 giờ Việt Nam (00:00 Midnight PT — ${seasonLabel})`;
}

export function formatDurationCountdownVN(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSec = Math.floor(safeMs / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs} giờ ${mins} phút`;
  if (mins > 0) return `${mins} phút ${secs} giây`;
  return `${secs} giây`;
}

export function formatTokenShort(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 || n % 1_000 === 0 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatLimitsLabel(rpm: number, tpm: number, rpd: number, model: string): string {
  return REFERENCE_QUOTAS[model] || `${rpm} RPM | ${formatTokenShort(tpm)} TPM | ${formatTokenShort(rpd)} RPD`;
}

function maskKeyHint(apiKey: string): string {
  const clean = apiKey.trim();
  if (clean.length <= 10) return '***';
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 10);
}

function isUsableChatModel(provider: ProviderId, modelId: string): boolean {
  const norm = modelId.trim().toLowerCase();
  if (!norm) return false;
  if (/(?:embedding|aqa|imagen|veo|tts|whisper|dall-e|moderation|realtime|transcribe|robotics|computer-use|deep-research|audio)/i.test(norm)) {
    return false;
  }
  if (provider === 'gemini') {
    return norm.startsWith('gemini-') || norm.startsWith('gemma-');
  }
  if (provider === 'openai') {
    return /^(?:gpt-|o1|o3|o4|chatgpt)/i.test(norm);
  }
  return true;
}

async function listOpenAiStyleModels(endpoint: string, apiKey: string): Promise<{ ok: boolean; ids: string[]; error?: string }> {
  const modelsUrl = endpoint.replace(/\/$/, '').replace(/\/chat\/completions$/i, '') + '/models';
  try {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, ids: [], error: `HTTP ${res.status}` };
    const json = await res.json() as { data?: any[] };
    const ids = (Array.isArray(json.data) ? json.data : [])
      .map(m => String(m?.id || '').trim())
      .filter(Boolean);
    return { ok: true, ids };
  } catch (err: any) {
    return { ok: false, ids: [], error: redactSecrets(err?.message || String(err), [apiKey]) };
  }
}

async function listGeminiModels(endpoint: string, apiKey: string): Promise<{
  ok: boolean;
  count: number;
  specs: Map<string, GeminiModelSpec>;
  error?: string;
}> {
  const base = endpoint.replace(/\/$/, '');
  const specs = new Map<string, GeminiModelSpec>();
  try {
    const res = await fetch(`${base}/models?pageSize=100`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) {
      return { ok: false, count: 0, specs, error: `HTTP ${res.status}` };
    }
    const json = await res.json() as { models?: any[] };
    const list = Array.isArray(json.models) ? json.models : [];
    for (const m of list) {
      const rawName = String(m?.name || '');
      const id = rawName.replace(/^models\//i, '').trim();
      if (!id) continue;
      const cap = inferCapabilities(id);
      specs.set(id.toLowerCase(), {
        id,
        displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
        inputTokenLimit: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : cap.contextWindow,
        outputTokenLimit: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : undefined,
        supportsThinking: typeof m.thinking === 'boolean' ? m.thinking : undefined,
        supportsVision: cap.vision,
        supportedGenerationMethods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : undefined
      });
    }
    return { ok: true, count: list.length, specs };
  } catch (err: any) {
    return { ok: false, count: 0, specs, error: redactSecrets(err?.message || String(err), [apiKey]) };
  }
}

interface ModelProbeRequest {
  provider: ProviderId;
  kind: ProviderKind;
  endpoint: string;
  apiKey: string;
  model: string;
  spec?: GeminiModelSpec;
  routerTarget?: { profileId: string; keySlot?: string };
}

async function probeSingleModelForKey(req: ModelProbeRequest): Promise<ModelQuotaProbeResult> {
  const { provider, kind, endpoint, apiKey, model, spec, routerTarget } = req;
  const defLim = getDefaultModelRateLimits(model, provider);
  const cap = VERIFIED_CAPABILITIES[model] || inferCapabilities(model);
  const baseMeta = {
    inputTokenLimit: spec?.inputTokenLimit ?? cap.contextWindow,
    outputTokenLimit: spec?.outputTokenLimit,
    supportsVision: spec?.supportsVision ?? cap.vision,
    supportsThinking: spec?.supportsThinking,
    probed: true
  };
  const baseKnownTier = formatLimitsLabel(defLim.rpm, defLim.tpm, defLim.rpd, model);
  const start = Date.now();

  let url = endpoint.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any;

  if (kind === 'gemini') {
    url = `${url}/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key'] = apiKey;
    body = {
      contents: [{ role: 'user', parts: [{ text: '1' }] }],
      generationConfig: { maxOutputTokens: 16 }
    };
  } else if (kind === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: '1' }]
    };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    body = {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: '1' }]
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const latencyMs = Math.max(1, Date.now() - start);
    const hdrInfo = extractRateLimitHeaders(res.headers);

    if (res.ok) {
      const jsonBody: any = await res.json().catch(() => null);
      const rpmLim = hdrInfo.limitRequests ?? defLim.rpm;
      const tpmLim = hdrInfo.limitTokens ?? defLim.tpm;
      const rpdLim = hdrInfo.limitRequestsDaily ?? defLim.rpd;
      const limitSource: RateLimitSource =
        hdrInfo.limitRequests !== undefined || hdrInfo.limitTokens !== undefined ? 'API_HEADER' : 'TIER_DEFAULT';

      let pTok = 2;
      let cTok = 1;
      let tTok = 3;
      if (kind === 'gemini' && jsonBody?.usageMetadata) {
        pTok = Number(jsonBody.usageMetadata.promptTokenCount || 2);
        cTok = Number(jsonBody.usageMetadata.candidatesTokenCount || 2);
        tTok = Number(jsonBody.usageMetadata.totalTokenCount || pTok + cTok);
      } else if (kind === 'anthropic' && jsonBody?.usage) {
        pTok = Number(jsonBody.usage.input_tokens || 2);
        cTok = Number(jsonBody.usage.output_tokens || 1);
        tTok = pTok + cTok;
      } else if (jsonBody?.usage) {
        pTok = Number(jsonBody.usage.prompt_tokens || 2);
        cTok = Number(jsonBody.usage.completion_tokens || 1);
        tTok = Number(jsonBody.usage.total_tokens || pTok + cTok);
      }

      if (routerTarget) {
        syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'AVAILABLE', undefined, {
          ...(limitSource === 'API_HEADER'
            ? {
                learnedLimit: {
                  ...(hdrInfo.limitRequests ? { rpm: hdrInfo.limitRequests } : {}),
                  ...(hdrInfo.limitTokens ? { tpm: hdrInfo.limitTokens } : {}),
                  ...(hdrInfo.limitRequestsDaily ? { rpd: hdrInfo.limitRequestsDaily } : {})
                },
                limitSource: 'API_HEADER'
              }
            : {}),
          remainingRequests: hdrInfo.remainingRequests,
          remainingTokens: hdrInfo.remainingTokens
        });
        recordKeySlotUsage(
          {
            profileId: routerTarget.profileId,
            keySlot: routerTarget.keySlot || routerTarget.profileId,
            provider,
            model,
            promptTokens: pTok,
            outputTokens: cTok,
            totalTokens: tTok,
            latencyMs,
            timestamp: Date.now(),
            ...hdrInfo
          },
          true
        );
      }

      return {
        model,
        state: 'AVAILABLE',
        httpStatus: res.status,
        latencyMs,
        knownTierLimits: limitSource === 'API_HEADER' ? formatLimitsLabel(rpmLim, tpmLim, rpdLim, model) : baseKnownTier,
        rpmLimit: rpmLim,
        tpmLimit: tpmLim,
        rpdLimit: rpdLim,
        ...(hdrInfo.remainingRequests !== undefined ? { rpmRemaining: hdrInfo.remainingRequests } : {}),
        ...(hdrInfo.remainingTokens !== undefined ? { tpmRemaining: hdrInfo.remainingTokens } : {}),
        limitSource,
        ...baseMeta
      };
    }

    const rawText = await res.text().catch(() => '');
    const retryHdr = res.headers?.get?.('retry-after') ?? null;
    const parsedErr = parseProviderHttpError(res.status, rawText, retryHdr, [apiKey], res.headers);
    const retryMs = parsedErr.retryAfterMs ?? parseRetryDelayMs(retryHdr, rawText);

    const learned: Partial<{ rpm: number; tpm: number; rpd: number }> = {};
    if (parsedErr.limitRequests !== undefined) learned.rpm = parsedErr.limitRequests;
    if (parsedErr.limitTokens !== undefined) learned.tpm = parsedErr.limitTokens;
    if (parsedErr.limitRequestsDaily !== undefined) learned.rpd = parsedErr.limitRequestsDaily;
    for (const v of parsedErr.violations || []) {
      const qVal = Number(v.quotaValue);
      if (Number.isFinite(qVal) && qVal > 0) {
        if (v.rateLimitSubScope === 'RPM') learned.rpm = qVal;
        else if (v.rateLimitSubScope === 'TPM') learned.tpm = qVal;
        else if (v.rateLimitSubScope === 'RPD') learned.rpd = qVal;
      }
    }
    const parsedQuotaVal = Number(parsedErr.quotaLimitValue);
    if (Number.isFinite(parsedQuotaVal) && parsedQuotaVal > 0) {
      if (parsedErr.rateLimitSubScope === 'RPM' && learned.rpm === undefined) learned.rpm = parsedQuotaVal;
      if (parsedErr.rateLimitSubScope === 'TPM' && learned.tpm === undefined) learned.tpm = parsedQuotaVal;
      if (parsedErr.rateLimitSubScope === 'RPD' && learned.rpd === undefined) learned.rpd = parsedQuotaVal;
    }

    const hasHeaderLimits = parsedErr.limitRequests !== undefined || parsedErr.limitTokens !== undefined;
    const hasLearned = Object.keys(learned).length > 0;
    const limitSource: RateLimitSource = hasHeaderLimits ? 'API_HEADER' : hasLearned ? 'API_ERROR' : 'TIER_DEFAULT';
    const rpmLim = learned.rpm ?? defLim.rpm;
    const tpmLim = learned.tpm ?? defLim.tpm;
    const rpdLim = learned.rpd ?? defLim.rpd;

    let state: ModelQuotaState = 'ERROR';
    if (parsedErr.rateLimitScope === 'AUTH') {
      state = 'AUTH_ERROR';
    } else if (parsedErr.rateLimitScope === 'NOT_FOUND') {
      state = 'NOT_FOUND';
    } else if (parsedErr.rateLimitScope === 'DAILY') {
      state = 'DAILY_EXHAUSTED';
      if (routerTarget) {
        syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'DAILY_EXHAUSTED', retryMs, {
          learnedLimit: hasLearned ? learned : undefined,
          limitSource,
          errorReason: parsedErr.reasonSnippet,
          remainingRequests: parsedErr.remainingRequests,
          remainingTokens: parsedErr.remainingTokens
        });
      }
    } else if (parsedErr.rateLimitScope === 'PER_MINUTE') {
      state = 'RPM_TPM_LIMITED';
      if (routerTarget) {
        syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'RPM_TPM_LIMITED', retryMs, {
          learnedLimit: hasLearned ? learned : undefined,
          limitSource,
          errorReason: parsedErr.reasonSnippet,
          remainingRequests: parsedErr.remainingRequests,
          remainingTokens: parsedErr.remainingTokens
        });
      }
    }

    return {
      model,
      state,
      rateLimitSubScope: parsedErr.rateLimitSubScope,
      httpStatus: res.status,
      latencyMs,
      knownTierLimits: hasLearned ? formatLimitsLabel(rpmLim, tpmLim, rpdLim, model) : baseKnownTier,
      rpmLimit: rpmLim,
      tpmLimit: tpmLim,
      rpdLimit: rpdLim,
      ...(parsedErr.remainingRequests !== undefined
        ? { rpmRemaining: parsedErr.remainingRequests }
        : parsedErr.rateLimitSubScope === 'RPM'
          ? { rpmRemaining: 0 }
          : {}),
      ...(parsedErr.remainingTokens !== undefined
        ? { tpmRemaining: parsedErr.remainingTokens }
        : parsedErr.rateLimitSubScope === 'TPM'
          ? { tpmRemaining: 0 }
          : {}),
      ...(state === 'DAILY_EXHAUSTED' ? { rpdRemaining: 0 } : {}),
      limitSource,
      ...baseMeta,
      quotaId: parsedErr.quotaId,
      quotaMetric: parsedErr.quotaMetric,
      quotaLimitValue: parsedErr.quotaLimitValue,
      retryAfterText: parsedErr.retryAfterText,
      detail: parsedErr.reasonSnippet.slice(0, 140)
    };
  } catch (err: any) {
    return {
      model,
      state: 'ERROR',
      latencyMs: Date.now() - start,
      knownTierLimits: baseKnownTier,
      rpmLimit: defLim.rpm,
      tpmLimit: defLim.tpm,
      rpdLimit: defLim.rpd,
      limitSource: 'TIER_DEFAULT',
      ...baseMeta,
      detail: redactSecrets(err?.message || String(err), [apiKey]).slice(0, 140)
    };
  }
}

function buildPerKeyModelList(
  provider: ProviderId,
  configuredModel: string,
  listedIds: string[],
  telemetryModels: string[],
  options?: { explicitModels?: string[]; includeAllListedModels?: boolean }
): string[] {
  const cleanListed = listedIds.filter(id => isUsableChatModel(provider, id));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const t = id.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };

  push(configuredModel);
  if (options?.explicitModels?.length) {
    for (const m of options.explicitModels) push(m);
  } else if (provider === 'gemini') {
    for (const m of GEMINI_AUTO_MODEL_POOL) push(m);
    for (const m of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']) {
      if (cleanListed.some(l => l.toLowerCase() === m)) push(m);
    }
  } else if (provider === 'groq') {
    for (const m of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']) {
      if (cleanListed.length === 0 || cleanListed.some(l => l.toLowerCase() === m)) push(m);
    }
  } else if (provider === 'openai') {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'o3-mini']) {
      if (cleanListed.length === 0 || cleanListed.some(l => l.toLowerCase() === m)) push(m);
    }
  } else if (provider === 'anthropic') {
    for (const m of ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']) {
      if (cleanListed.length === 0 || cleanListed.some(l => l.toLowerCase() === m)) push(m);
    }
  }

  for (const tm of telemetryModels) push(tm);

  if (options?.includeAllListedModels) {
    for (const lm of cleanListed) push(lm);
  } else {
    const maxExtra = provider === 'gemini' ? 18 : 8;
    for (const lm of cleanListed) {
      if (out.length >= maxExtra) break;
      // Skip dated/pinned revision snapshots in standard mode unless explicitly requested
      if (/-(?:001|002|exp|latest)$/i.test(lm) && out.some(x => lm.toLowerCase().startsWith(x.toLowerCase()))) continue;
      push(lm);
    }
  }

  return out;
}

function mergeTelemetryIntoResults(
  profileId: string,
  slotId: string,
  provider: ProviderId,
  results: ModelQuotaProbeResult[]
): { totalRequestsToday: number; totalTokensToday: number } {
  const telemetryMap = new Map(
    getKeySlotTelemetrySnapshot()
      .filter(v => v.profileId === profileId && v.keySlot === slotId)
      .map(v => [v.model.toLowerCase(), v])
  );
  let totalRequestsToday = 0;
  let totalTokensToday = 0;
  for (const r of results) {
    const tv = telemetryMap.get(r.model.toLowerCase());
    const defLim = getDefaultModelRateLimits(r.model, provider);
    if (tv) {
      r.usedRpm60s = tv.usedRpm60s;
      r.usedTpm60s = tv.usedTpm60s;
      r.usedRpdToday = tv.usedRpdToday;
      r.usedTokensToday = tv.usedTokensToday;
      r.avgLatencyMs = tv.avgLatencyMs;
      r.cooldownRemainingSec = tv.cooldownRemainingMs > 0 ? Math.ceil(tv.cooldownRemainingMs / 1000) : 0;
      r.rpmLimit = r.limitSource === 'API_HEADER' || r.limitSource === 'API_ERROR'
        ? (r.rpmLimit ?? tv.limits.rpm)
        : Math.max(0, tv.limits.rpm || r.rpmLimit || defLim.rpm);
      r.tpmLimit = r.limitSource === 'API_HEADER' || r.limitSource === 'API_ERROR'
        ? (r.tpmLimit ?? tv.limits.tpm)
        : Math.max(0, tv.limits.tpm || r.tpmLimit || defLim.tpm);
      r.rpdLimit = r.limitSource === 'API_HEADER' || r.limitSource === 'API_ERROR'
        ? (r.rpdLimit ?? tv.limits.rpd)
        : Math.max(0, tv.limits.rpd || r.rpdLimit || defLim.rpd);
      if (r.limitSource === 'TIER_DEFAULT' && tv.limitSource && tv.limitSource !== 'TIER_DEFAULT') {
        r.limitSource = tv.limitSource;
      }
      if (r.rpmRemaining === undefined && tv.remainingRequestsHeader !== undefined) {
        r.rpmRemaining = tv.remainingRequestsHeader;
      }
      if (r.tpmRemaining === undefined && tv.remainingTokensHeader !== undefined) {
        r.tpmRemaining = tv.remainingTokensHeader;
      }
    }
    const finalRpmLim = r.rpmLimit ?? defLim.rpm;
    const finalTpmLim = r.tpmLimit ?? defLim.tpm;
    const finalRpdLim = r.rpdLimit ?? defLim.rpd;
    r.rpmLimit = finalRpmLim;
    r.tpmLimit = finalTpmLim;
    r.rpdLimit = finalRpdLim;
    if (r.rpmRemaining === undefined) {
      r.rpmRemaining = r.state === 'RPM_TPM_LIMITED' && r.rateLimitSubScope === 'RPM'
        ? 0
        : Math.max(0, finalRpmLim - (r.usedRpm60s || 0));
    }
    if (r.tpmRemaining === undefined) {
      r.tpmRemaining = r.state === 'RPM_TPM_LIMITED' && r.rateLimitSubScope === 'TPM'
        ? 0
        : Math.max(0, finalTpmLim - (r.usedTpm60s || 0));
    }
    if (r.rpdRemaining === undefined) {
      r.rpdRemaining = r.state === 'DAILY_EXHAUSTED' ? 0 : Math.max(0, finalRpdLim - (r.usedRpdToday || 0));
    }
    r.knownTierLimits = formatLimitsLabel(finalRpmLim, finalTpmLim, finalRpdLim, r.model);
  }
  for (const tv of telemetryMap.values()) {
    totalRequestsToday += tv.usedRpdToday;
    totalTokensToday += tv.usedTokensToday;
  }
  return { totalRequestsToday, totalTokensToday };
}

function analyzeCrossKeyRelationships(summaries: ProfileQuotaSummary[]): {
  sharedProjectSuspected: boolean;
  sharedProjectReason?: string;
} {
  if (summaries.length < 2) return { sharedProjectSuspected: false };

  // 1. Check exact duplicate API keys configured across slots/profiles via non-reversible hash fingerprint
  const byFingerprint = new Map<string, string[]>();
  for (const s of summaries) {
    if (!s.keyFingerprint) continue;
    const label = s.keySlot && s.keySlot !== s.profileId ? `${s.profileId}/${s.keySlot}` : s.profileId;
    const arr = byFingerprint.get(s.keyFingerprint) || [];
    arr.push(label);
    byFingerprint.set(s.keyFingerprint, arr);
  }
  for (const labels of byFingerprint.values()) {
    if (labels.length >= 2) {
      return {
        sharedProjectSuspected: true,
        sharedProjectReason: `Phát hiện ${labels.join(' và ')} đang dùng CÙNG MỘT API key (trùng khóa bí mật — không nhân đôi được hạn mức!).`
      };
    }
  }

  // 2. Compare all Gemini key pairs for shared-project daily exhaustion patterns vs independent projects
  const geminiKeys = summaries.filter(s => (s.provider || 'gemini') === 'gemini' && s.keyValid);
  if (geminiKeys.length < 2) return { sharedProjectSuspected: false };

  let sharedPair: string | undefined;
  let independentPairs = 0;
  for (let i = 0; i < geminiKeys.length; i++) {
    const a = geminiKeys[i];
    const mapA = new Map(a.results.map(r => [r.model, r]));
    for (let j = i + 1; j < geminiKeys.length; j++) {
      const b = geminiKeys[j];
      let diffFound = false;
      let identicalExhaustion = 0;
      for (const rb of b.results) {
        const ra = mapA.get(rb.model);
        if (!ra) continue;
        if ((ra.state === 'AVAILABLE') !== (rb.state === 'AVAILABLE')) {
          diffFound = true;
        } else if (ra.state === 'DAILY_EXHAUSTED' && rb.state === 'DAILY_EXHAUSTED') {
          identicalExhaustion++;
        }
      }
      const labelA = a.keySlot || a.profileId;
      const labelB = b.keySlot || b.profileId;
      if (!diffFound && identicalExhaustion > 0) {
        sharedPair = `${labelA} và ${labelB} có trạng thái cạn quota ngày giống hệt nhau trên ${identicalExhaustion} model (dấu hiệu có thể đang chung 1 Google Cloud Project; Google không trả Project ID qua API key nên kiểm tra chéo ở aistudio.google.com).`;
      } else if (diffFound) {
        independentPairs++;
      }
    }
  }

  if (sharedPair) {
    return { sharedProjectSuspected: true, sharedProjectReason: sharedPair };
  }
  if (independentPairs > 0) {
    return {
      sharedProjectSuspected: false,
      sharedProjectReason: `${geminiKeys.length} key Gemini có trạng thái model khác nhau rõ rệt (${independentPairs} cặp độc lập) -> đang thuộc các Google Cloud Project tách biệt (xoay vòng nhân bội hạn mức thực!).`
    };
  }
  return { sharedProjectSuspected: false };
}

/**
 * Checks ALL configured profiles & ALL API key slots (Gemini, Groq, OpenAI, Anthropic, Custom),
 * probing each model on each API key and merging live HTTP rate-limit headers + sliding-window telemetry.
 */
export async function checkAllProfilesQuota(options: CheckAllQuotaOptions = {}): Promise<QuotaCheckReport> {
  const db = options.db || await readProfilesDb();
  const profileIds = Object.keys(db.profiles || {}).filter(id => {
    const prof = db.profiles[id];
    if (!prof) return false;
    if (options.providerFilter && prof.provider !== options.providerFilter) return false;
    if (options.profileId && id !== options.profileId) return false;
    return true;
  });

  const summaries: ProfileQuotaSummary[] = [];
  const allTelemetry = getKeySlotTelemetrySnapshot();

  for (const profileId of profileIds) {
    const prof = db.profiles[profileId];
    const providerMeta = PROVIDER_REGISTRY[prof.provider];
    const slots = getProfileKeySlots(profileId, prof).filter(s => !options.keySlot || s === options.keySlot);

    for (let sIdx = 0; sIdx < slots.length; sIdx++) {
      const slotId = slots[sIdx];
      let resolvedKey = '';
      let effectiveEndpoint = prof.endpoint || providerMeta.defaultEndpoint;
      let effectiveKind: ProviderKind = prof.kind || providerMeta.kind;

      try {
        const resolver = options.resolveFn || resolveProvider;
        const resolved = await resolver({ profileId, keySlot: slotId });
        resolvedKey = resolved.apiKey;
        effectiveEndpoint = resolved.endpoint || effectiveEndpoint;
        effectiveKind = resolved.kind || effectiveKind;
      } catch (err: any) {
        summaries.push({
          profileId,
          ...(slotId !== profileId ? { keySlot: slotId } : {}),
          keySlotIndex: sIdx + 1,
          provider: prof.provider,
          providerName: providerMeta.name,
          configuredModel: prof.model,
          keyHint: '(không đọc được keyring)',
          keyValid: false,
          keyStatusLabel: 'LỖI KEYRING',
          listedModelsCount: 0,
          results: [{
            model: prof.model,
            state: 'AUTH_ERROR',
            latencyMs: 0,
            knownTierLimits: REFERENCE_QUOTAS[prof.model] || '-',
            detail: redactSecrets(err?.message || String(err))
          }]
        });
        continue;
      }

      let listedCount = 0;
      let listOk = false;
      let listErr: string | undefined;
      const geminiSpecs = new Map<string, GeminiModelSpec>();
      let listedModelIds: string[] = [];

      if (prof.provider === 'gemini') {
        const listCheck = await listGeminiModels(effectiveEndpoint, resolvedKey);
        listOk = listCheck.ok;
        listedCount = listCheck.count;
        listErr = listCheck.error;
        for (const [k, v] of listCheck.specs.entries()) {
          geminiSpecs.set(k, v);
          if (!v.supportedGenerationMethods || v.supportedGenerationMethods.includes('generateContent')) {
            listedModelIds.push(v.id);
          }
        }
      } else if (prof.provider !== 'custom') {
        if (isOfficialEndpoint(prof.provider, effectiveEndpoint)) {
          const live = await fetchLiveModels(prof.provider, resolvedKey, effectiveEndpoint, true);
          listOk = live.source === 'API_LIVE';
          listedCount = live.models.length;
          listErr = live.note;
          listedModelIds = live.models.map(m => m.id);
        } else if (effectiveKind === 'openai-compatible') {
          const compat = await listOpenAiStyleModels(effectiveEndpoint, resolvedKey);
          listOk = compat.ok;
          listedModelIds = compat.ids.length > 0 ? compat.ids : getStaticModels(prof.provider).map(m => m.id);
          listedCount = compat.ids.length;
          listErr = compat.error;
        } else {
          listedModelIds = [prof.model];
          listedCount = 1;
        }
      } else {
        const compat = effectiveEndpoint ? await listOpenAiStyleModels(effectiveEndpoint, resolvedKey) : { ok: false, ids: [] as string[] };
        listOk = compat.ok;
        listedModelIds = compat.ids.length > 0 ? compat.ids : [prof.model];
        listedCount = listedModelIds.length;
      }

      const telemetryModelsForSlot = allTelemetry
        .filter(t => t.profileId === profileId && t.keySlot === slotId)
        .map(t => t.model);

      const modelList = buildPerKeyModelList(prof.provider, prof.model, listedModelIds, telemetryModelsForSlot, {
        explicitModels: options.models,
        includeAllListedModels: options.includeAllListedModels
      });

      const results: ModelQuotaProbeResult[] = new Array(modelList.length);
      const CONCURRENCY = prof.provider === 'gemini' ? 4 : 3;
      let nextIdx = 0;

      const worker = async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= modelList.length) break;
          const mId = modelList[idx];
          results[idx] = await probeSingleModelForKey({
            provider: prof.provider,
            kind: effectiveKind,
            endpoint: effectiveEndpoint,
            apiKey: resolvedKey,
            model: mId,
            spec: geminiSpecs.get(mId.toLowerCase()),
            routerTarget: { profileId, keySlot: slotId }
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, modelList.length) }, () => worker()));

      const { totalRequestsToday, totalTokensToday } = mergeTelemetryIntoResults(profileId, slotId, prof.provider, results);
      const hasValidProbes = results.some(r => r.state === 'AVAILABLE' || r.state === 'DAILY_EXHAUSTED' || r.state === 'RPM_TPM_LIMITED');
      const keyValid = listOk || hasValidProbes;
      const keyStatusLabel = listOk
        ? `HỢP LỆ (${listedCount} models)`
        : (hasValidProbes ? 'HỢP LỆ (live probe OK)' : `LỖI (${listErr || 'không kết nối được'})`);

      summaries.push({
        profileId,
        ...(slotId !== profileId ? { keySlot: slotId } : {}),
        keySlotIndex: sIdx + 1,
        provider: prof.provider,
        providerName: providerMeta.name,
        configuredModel: prof.model,
        keyHint: maskKeyHint(resolvedKey),
        keyFingerprint: fingerprintApiKey(resolvedKey),
        keyValid,
        keyStatusLabel,
        listedModelsCount: listedCount,
        availableModelsCount: results.filter(r => r.state === 'AVAILABLE').length,
        rateLimitedModelsCount: results.filter(r => r.state === 'RPM_TPM_LIMITED').length,
        exhaustedModelsCount: results.filter(r => r.state === 'DAILY_EXHAUSTED').length,
        totalRequestsToday,
        totalTokensToday,
        results
      });
    }
  }

  const cross = analyzeCrossKeyRelationships(summaries);
  const nowMs = Date.now();
  return {
    checkedAt: new Date(nowMs).toISOString(),
    vietnamResetTimeText: getPacificMidnightResetInVietnam(new Date(nowMs)),
    nextResetInText: formatDurationCountdownVN(getNextPacificMidnightMs(nowMs) - nowMs),
    profiles: summaries,
    sharedProjectSuspected: cross.sharedProjectSuspected,
    sharedProjectReason: cross.sharedProjectReason
  };
}

/**
 * Checks all verified/configured Gemini profiles across `GEMINI_AUTO_MODEL_POOL` using minimal 1-token probes,
 * merges real-time token/request telemetry, and synchronizes reset/exhausted states directly into ModelRouter.
 */
export async function checkGeminiProfilesQuota(models: string[] = GEMINI_AUTO_MODEL_POOL): Promise<QuotaCheckReport> {
  return checkAllProfilesQuota({
    providerFilter: 'gemini',
    models
  });
}

/** Measures capabilities, context limits & live readiness/rate-limits per model directly from a raw API key. */
export async function inspectSingleApiKeySpecs(
  apiKey: string,
  providerHint?: ProviderId,
  customEndpoint?: string,
  options?: { includeAllListedModels?: boolean }
): Promise<SingleKeySpecReport> {
  const cleanKey = apiKey.trim();
  const provider: ProviderId = providerHint || detectProviderKeyPrefix(cleanKey) || 'gemini';
  const meta = PROVIDER_REGISTRY[provider];
  const nowMs = Date.now();
  const endpoint = (customEndpoint || meta.defaultEndpoint).replace(/\/$/, '');

  if (provider === 'gemini') {
    const listCheck = await listGeminiModels(endpoint, cleanKey);
    const live = listCheck.ok ? null : await fetchLiveModels('gemini', cleanKey, customEndpoint, true);
    const models: SingleKeySpecReport['models'] = [];
    const seen = new Set<string>();

    for (const spec of listCheck.specs.values()) {
      if (spec.supportedGenerationMethods && !spec.supportedGenerationMethods.includes('generateContent')) continue;
      if (!isUsableChatModel('gemini', spec.id)) continue;
      seen.add(spec.id.toLowerCase());
      const lim = getDefaultModelRateLimits(spec.id, 'gemini');
      models.push({
        id: spec.id,
        inputTokenLimit: spec.inputTokenLimit,
        outputTokenLimit: spec.outputTokenLimit,
        supportsVision: Boolean(spec.supportsVision),
        supportsThinking: spec.supportsThinking,
        tierLimits: formatLimitsLabel(lim.rpm, lim.tpm, lim.rpd, spec.id),
        rpmLimit: lim.rpm,
        tpmLimit: lim.tpm,
        rpdLimit: lim.rpd
      });
    }
    if (models.length === 0 && live) {
      for (const m of live.models) {
        const lim = getDefaultModelRateLimits(m.id, 'gemini');
        models.push({
          id: m.id,
          inputTokenLimit: m.capabilities?.contextWindow,
          supportsVision: Boolean(m.capabilities?.vision),
          tierLimits: formatLimitsLabel(lim.rpm, lim.tpm, lim.rpd, m.id),
          rpmLimit: lim.rpm,
          tpmLimit: lim.tpm,
          rpdLimit: lim.rpd
        });
      }
    }

    const probePool = buildPerKeyModelList(
      'gemini',
      GEMINI_AUTO_MODEL_POOL[0],
      models.map(m => m.id),
      [],
      { includeAllListedModels: options?.includeAllListedModels }
    );
    const targetIds = options?.includeAllListedModels ? probePool : probePool.slice(0, 12);
    const probedSample: ModelQuotaProbeResult[] = new Array(targetIds.length);
    let idx = 0;
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= targetIds.length) break;
        const mId = targetIds[i];
        probedSample[i] = await probeSingleModelForKey({
          provider: 'gemini',
          kind: 'gemini',
          endpoint,
          apiKey: cleanKey,
          model: mId,
          spec: listCheck.specs.get(mId.toLowerCase())
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targetIds.length) }, () => worker()));

    return {
      provider,
      providerName: meta.name,
      keyHint: maskKeyHint(cleanKey),
      keyValid: listCheck.ok || probedSample.some(r => r.state !== 'AUTH_ERROR'),
      vietnamResetTimeText: getPacificMidnightResetInVietnam(new Date(nowMs)),
      nextResetInText: formatDurationCountdownVN(getNextPacificMidnightMs(nowMs) - nowMs),
      listedModelsCount: listCheck.count || models.length,
      models,
      probedSample,
      note: listCheck.error
    };
  }

  const live = (!customEndpoint || isOfficialEndpoint(provider, customEndpoint))
    ? await fetchLiveModels(provider, cleanKey, customEndpoint, true)
    : (() => ({ models: getStaticModels(provider), source: 'OFFICIAL_REGISTRY' as const, note: undefined }))();
  let compatIds: string[] = [];
  let compatOk = false;
  if (customEndpoint && !isOfficialEndpoint(provider, customEndpoint) && meta.kind === 'openai-compatible') {
    const compat = await listOpenAiStyleModels(endpoint, cleanKey);
    compatOk = compat.ok;
    compatIds = compat.ids;
  }
  const sourceModels = compatIds.length > 0
    ? compatIds.map(id => {
        const cap = inferCapabilities(id);
        return { id, capabilities: cap };
      })
    : live.models;
  const models: SingleKeySpecReport['models'] = sourceModels
    .filter(m => isUsableChatModel(provider, m.id))
    .map(m => {
      const lim = getDefaultModelRateLimits(m.id, provider);
      return {
        id: m.id,
        inputTokenLimit: m.capabilities?.contextWindow,
        supportsVision: Boolean(m.capabilities?.vision),
        tierLimits: provider === 'groq'
          ? `Tham chiếu ${lim.rpm} RPM | ${formatTokenShort(lim.tpm)} TPM`
          : formatLimitsLabel(lim.rpm, lim.tpm, lim.rpd, m.id),
        rpmLimit: lim.rpm,
        tpmLimit: lim.tpm,
        rpdLimit: lim.rpd
      };
    });

  const probeTargets = buildPerKeyModelList(
    provider,
    models[0]?.id || (provider === 'groq' ? 'llama-3.3-70b-versatile' : provider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o-mini'),
    models.map(m => m.id),
    [],
    { includeAllListedModels: options?.includeAllListedModels }
  );
  const limitedTargets = options?.includeAllListedModels ? probeTargets : probeTargets.slice(0, 6);
  const probedSample = await Promise.all(
    limitedTargets.map(mId =>
      probeSingleModelForKey({
        provider,
        kind: meta.kind,
        endpoint,
        apiKey: cleanKey,
        model: mId
      })
    )
  );

  // Enrich models list with live learned header limits from probes
  const probedMap = new Map(probedSample.map(p => [p.model.toLowerCase(), p]));
  for (const m of models) {
    const p = probedMap.get(m.id.toLowerCase());
    if (p && p.rpmLimit && p.tpmLimit) {
      m.rpmLimit = p.rpmLimit;
      m.tpmLimit = p.tpmLimit;
      m.rpdLimit = p.rpdLimit;
      m.tierLimits = p.knownTierLimits;
    }
  }

  return {
    provider,
    providerName: meta.name,
    keyHint: maskKeyHint(cleanKey),
    keyValid: compatOk || (live.source === 'API_LIVE' && live.models.length > 0) || probedSample.some(r => r.state === 'AVAILABLE' || r.state === 'RPM_TPM_LIMITED'),
    vietnamResetTimeText: getPacificMidnightResetInVietnam(new Date(nowMs)),
    nextResetInText: formatDurationCountdownVN(getNextPacificMidnightMs(nowMs) - nowMs),
    listedModelsCount: compatIds.length || live.models.length,
    models,
    probedSample,
    note: live.note
  };
}

/** Periodically checks ALL (or Gemini) key quotas & updates ModelRouter when exhausted/RPM-limited keys reset. */
export async function watchAllProfilesQuota(options: {
  intervalSec?: number;
  maxIterations?: number;
  providerFilter?: ProviderId;
  profileId?: string;
  includeAllListedModels?: boolean;
  models?: string[];
  onReport: (report: QuotaCheckReport, iteration: number) => void;
  signal?: AbortSignal;
}): Promise<QuotaCheckReport | null> {
  const intervalMs = Math.max(5, Math.min(3600, options.intervalSec ?? 30)) * 1000;
  const maxIter = Math.max(1, options.maxIterations ?? 10);
  let lastReport: QuotaCheckReport | null = null;

  for (let i = 1; i <= maxIter; i++) {
    if (options.signal?.aborted) break;
    lastReport = await checkAllProfilesQuota({
      providerFilter: options.providerFilter,
      profileId: options.profileId,
      includeAllListedModels: options.includeAllListedModels,
      models: options.models
    });
    options.onReport(lastReport, i);
    if (i < maxIter && !options.signal?.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, intervalMs);
        if (options.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        }
      });
    }
  }
  return lastReport;
}

/** Backward-compatible Gemini quota watcher. */
export async function watchGeminiProfilesQuota(options: {
  intervalSec?: number;
  maxIterations?: number;
  models?: string[];
  onReport: (report: QuotaCheckReport, iteration: number) => void;
  signal?: AbortSignal;
}): Promise<QuotaCheckReport | null> {
  return watchAllProfilesQuota({ ...options, providerFilter: 'gemini' });
}

function formatSingleRateLimitSlice(r: ModelQuotaProbeResult): string {
  const parts: string[] = [];
  if (r.rpmLimit !== undefined) {
    const used = r.usedRpm60s || 0;
    const rem = r.rpmRemaining !== undefined ? ` (còn ${r.rpmRemaining})` : '';
    parts.push(`RPM ${used}/${r.rpmLimit}${rem}`);
  }
  if (r.tpmLimit !== undefined) {
    const used = formatTokenShort(r.usedTpm60s || 0);
    const lim = formatTokenShort(r.tpmLimit);
    const rem = r.tpmRemaining !== undefined ? ` (còn ${formatTokenShort(r.tpmRemaining)})` : '';
    parts.push(`TPM ${used}/${lim}${rem}`);
  }
  if (r.rpdLimit !== undefined) {
    const used = r.usedRpdToday || 0;
    const rem = r.rpdRemaining !== undefined ? ` (còn ${r.rpdRemaining})` : '';
    parts.push(`RPD ${used}/${formatTokenShort(r.rpdLimit)}${rem}`);
  }
  if (parts.length === 0) return `Định mức: ${r.knownTierLimits}`;
  const srcTag = r.limitSource === 'API_HEADER' ? '[API]' : r.limitSource === 'API_ERROR' ? '[429]' : '[Tier]';
  return `${srcTag} ${parts.join(' | ')}`;
}

export function formatSingleKeySpecReport(spec: SingleKeySpecReport): string {
  const lines: string[] = [];
  const statusTag = spec.keyValid ? '✔ HỢP LỆ' : '✖ LỖI/CHƯA XÁC MINH';
  lines.push(paint(`=== API Key Specs: ${spec.providerName} [${spec.keyHint}] | Key: ${statusTag} | Models: ${spec.listedModelsCount} ===`, 'cyan', true));
  lines.push(paint(`Giờ reset Daily Quota: ${spec.vietnamResetTimeText} (còn ${spec.nextResetInText})`, 'muted'));
  if (spec.note) lines.push(paint(`Ghi chú: ${spec.note}`, 'yellow'));
  if (spec.probedSample && spec.probedSample.length > 0) {
    const sampleLatencies = spec.probedSample.map(p => p.latencyMs).filter(ms => ms > 0);
    const spark = sampleLatencies.length > 0 ? ` | Latency ${renderSparkline(sampleLatencies)}` : '';
    lines.push(paint(`\n[Đo Live Quota & Rate Limit từng Model (${spec.probedSample.length} models)${spark}]`, 'purple', true));
    for (const p of spec.probedSample) {
      const icon = p.state === 'AVAILABLE'
        ? '✔ SẴN SÀNG'
        : p.state === 'DAILY_EXHAUSTED'
          ? '✖ HẾT RPD'
          : p.state === 'RPM_TPM_LIMITED'
            ? `⏳ ${p.rateLimitSubScope || 'RPM/TPM'}`
            : `✖ ${p.state}`;
      const iconTone = p.state === 'AVAILABLE' ? 'green' : p.state === 'RPM_TPM_LIMITED' ? 'yellow' : 'red';
      const rateInfo = formatSingleRateLimitSlice(p);
      lines.push(
        `  • ${paint(p.model.padEnd(28), 'fg', true)} | ${paint(icon.padEnd(14), iconTone)} | ${paint(`${String(p.latencyMs).padStart(4)}ms`, 'cyan')} | Ctx: ${formatTokenShort(p.inputTokenLimit)}/${formatTokenShort(p.outputTokenLimit)} | ${rateInfo}`
      );
    }
  }
  if (spec.models.length > 0) {
    lines.push(paint(`\n[Danh mục Model hỗ trợ từ Key (${Math.min(24, spec.models.length)}/${spec.models.length})]`, 'cyan', true));
    for (const m of spec.models.slice(0, 24)) {
      const vis = m.supportsVision ? 'Vision+Text' : 'Text';
      const thk = m.supportsThinking ? '+Thinking' : '';
      lines.push(`  • ${m.id.padEnd(32)} | ${(`${vis}${thk}`).padEnd(18)} | In: ${formatTokenShort(m.inputTokenLimit).padStart(4)} | Out: ${formatTokenShort(m.outputTokenLimit).padStart(4)} | ${m.tierLimits}`);
    }
  }
  return lines.join('\n').trim();
}

export function formatQuotaReport(report: QuotaCheckReport): string {
  const lines: string[] = [];
  lines.push(`Thời điểm kiểm tra: ${report.checkedAt}`);
  lines.push(`Giờ reset Daily Quota (RPD): ${report.vietnamResetTimeText}${report.nextResetInText ? ` (còn ${report.nextResetInText})` : ''}`);
  lines.push(`RPM / TPM reset: Cửa sổ trượt 60 giây liên tục (tự xoay vòng sang key kế tiếp khi chạm ngưỡng)`);
  if (report.sharedProjectReason) {
    lines.push(paint(`Phân tích đa key: ${report.sharedProjectReason}`, report.sharedProjectSuspected ? 'orange' : 'green'));
  }
  lines.push('');

  for (const prof of report.profiles) {
    const keyBadge = prof.keyStatusLabel || (prof.keyValid ? `HỢP LỆ (${prof.listedModelsCount} models)` : 'LỖI KEY');
    const slotTag = prof.keySlot && prof.keySlot !== prof.profileId ? ` (${prof.keySlot})` : '';
    const provTag = prof.provider ? ` · ${prof.provider.toUpperCase()}` : '';
    const usageTot = (prof.totalRequestsToday || prof.totalTokensToday)
      ? ` | Phiên/Ngày: ${prof.totalRequestsToday || 0} req / ${(prof.totalTokensToday || 0).toLocaleString('en-US')} tok`
      : '';
    const probeLatencies = prof.results.map(r => r.latencyMs).filter(ms => ms > 0);
    const sparkTag = probeLatencies.length > 0 ? ` | Latency ${renderSparkline(probeLatencies)}` : '';
    const availCount = prof.availableModelsCount ?? prof.results.filter(r => r.state === 'AVAILABLE').length;
    const readyTag = prof.results.length > 0 ? ` | ${availCount}/${prof.results.length} sẵn sàng` : '';

    // Keep "prf_1 [AIzaSy...1234]" contiguous for QUOTA-01 contract
    const headerTitle = `=== Profile: ${prof.profileId}${slotTag} [${prof.keyHint}]${provTag} | Key: ${keyBadge} | Mặc định: ${prof.configuredModel}${readyTag}${usageTot}${sparkTag} ===`;
    lines.push(paint(headerTitle, prof.keyValid ? 'cyan' : 'red', true));

    if (prof.results.length > 0) {
      const availMeter = renderMeterBar(availCount, prof.results.length, 12);
      const totalRpdCap = prof.results.reduce((sum, r) => sum + (r.rpdLimit || 0), 0);
      const estCap = totalRpdCap > 0 ? totalRpdCap : Math.max(20, prof.results.length * 20);
      const rpdMeter = renderMeterBar(prof.totalRequestsToday || 0, estCap, 12);
      lines.push(
        `  • Sẵn sàng model : ${availMeter} (${availCount}/${prof.results.length})   ` +
        `Tải RPD hôm nay: ${rpdMeter} (${prof.totalRequestsToday || 0} req / ${(prof.totalTokensToday || 0).toLocaleString('en-US')} tok)`
      );
    }

    for (const r of prof.results) {
      // Keep exact status icons & strings contiguous for QUOTA-01 contract
      const icon = r.state === 'AVAILABLE'
        ? '✔ SẴN SÀNG'
        : r.state === 'DAILY_EXHAUSTED'
          ? '✖ HẾT RPD NGÀY'
          : r.state === 'RPM_TPM_LIMITED'
            ? `⏳ CHẠM ${r.rateLimitSubScope || 'RPM/TPM'}`
            : r.state === 'NOT_FOUND'
              ? '— KHÔNG KHẢ DỤNG (404)'
              : `✖ ${r.state}`;
      const iconTone = r.state === 'AVAILABLE'
        ? 'green'
        : r.state === 'RPM_TPM_LIMITED'
          ? 'yellow'
          : r.state === 'NOT_FOUND'
            ? 'muted'
            : 'red';
      const ctxMeta = (r.inputTokenLimit || r.outputTokenLimit)
        ? ` | Ctx: ${formatTokenShort(r.inputTokenLimit)}/${formatTokenShort(r.outputTokenLimit)}`
        : '';
      const hasExplicitRateBreakdown = r.rpmLimit !== undefined || r.tpmLimit !== undefined || r.rpdLimit !== undefined;
      const rateMeta = hasExplicitRateBreakdown
        ? ` | ${formatSingleRateLimitSlice(r)}`
        : ` | Định mức: ${r.knownTierLimits}`;
      const telemetryMeta = !hasExplicitRateBreakdown && (r.usedRpm60s || r.usedTpm60s || r.usedRpdToday)
        ? ` | Đã dùng: ${r.usedRpm60s || 0}req/60s, ${(r.usedTpm60s || 0)}tok/60s, ${r.usedRpdToday || 0}req/ngày`
        : '';
      const cdMeta = r.cooldownRemainingSec && r.cooldownRemainingSec > 0 ? ` [Mở lại sau ${r.cooldownRemainingSec}s]` : '';
      const limitMeta = r.quotaLimitValue ? ` [Limit báo về: ${r.quotaLimitValue}]` : '';
      const retryMeta = r.retryAfterText ? ` [Chờ reset: ${r.retryAfterText}]` : '';
      const errMeta = (r.state === 'ERROR' || r.state === 'AUTH_ERROR' || r.state === 'NOT_FOUND') && r.detail
        ? ` [${r.detail.slice(0, 70)}]`
        : '';

      const latencyStr = `${String(r.latencyMs).padStart(4)}ms`;
      lines.push(
        `  • ${paint(r.model.padEnd(31), 'fg', r.model === prof.configuredModel)} | ` +
        `${paint(icon.padEnd(18), iconTone, true)} | ` +
        `${paint(latencyStr, 'cyan')}` +
        `${rateMeta}${ctxMeta}${telemetryMeta}${cdMeta}${limitMeta}${retryMeta}${errMeta}`
      );
    }
    lines.push('');
  }

  if (report.profiles.length === 0) {
    lines.push(paint('Chưa có profile/API key nào được cấu hình để kiểm tra.', 'yellow'));
  }

  return lines.join('\n').trim();
}
