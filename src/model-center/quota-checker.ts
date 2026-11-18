/** Live Google AI Studio / Gemini Quota, Telemetry & API Spec Inspector (No Web UI needed) */
import { readProfilesDb, getProfileKeySlots } from './routing.js';
import { GEMINI_AUTO_MODEL_POOL, VERIFIED_CAPABILITIES, inferCapabilities, PROVIDER_REGISTRY, fetchLiveModels } from './catalog.js';
import { resolveProvider, parseProviderHttpError, parseRetryDelayMs } from '../providers.js';
import {
  getKeySlotTelemetrySnapshot,
  syncCooldownFromProbe,
  getNextPacificMidnightMs,
  getDefaultModelRateLimits,
  recordKeySlotUsage
} from './model-router.js';
import type { ProviderId } from './types.js';
import { redactSecrets } from '../security/redact.js';
import { renderSparkline, renderMeterBar } from '../ui/tokyo.js';

function detectProviderKeyPrefix(rawKey: string): ProviderId | undefined {
  const k = rawKey.trim();
  if (/^AIzaSy[0-9A-Za-z_-]{20,}$/.test(k)) return 'gemini';
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
  avgLatencyMs?: number;
  cooldownRemainingSec?: number;
  quotaId?: string;
  quotaMetric?: string;
  quotaLimitValue?: string;
  retryAfterText?: string;
  detail?: string;
}

export interface ProfileQuotaSummary {
  profileId: string;
  keySlot?: string;
  configuredModel: string;
  keyHint: string;
  keyValid: boolean;
  keyStatusLabel?: string;
  listedModelsCount: number;
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
  }[];
  probedSample?: ModelQuotaProbeResult[];
  note?: string;
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
  'gemma-4-26b-a4b-it': '30 RPM | 16K TPM | 14.4K RPD',
  'gemma-4-31b-it': '30 RPM | 16K TPM | 14.4K RPD'
};

/** Computes today/next midnight Pacific Time in Vietnam local time (UTC+7) accounting for PST/PDT. */
export function getPacificMidnightResetInVietnam(now = new Date()): string {
  // Check current Pacific offset from UTC using Intl (PDT = -7 => 14:00 VN, PST = -8 => 15:00 VN)
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

function formatTokenShort(n?: number): string {
  if (!n || !Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function maskKeyHint(apiKey: string): string {
  const clean = apiKey.trim();
  if (clean.length <= 10) return '***';
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
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

async function probeSingleGeminiModel(
  endpoint: string,
  apiKey: string,
  model: string,
  spec?: GeminiModelSpec,
  routerTarget?: { profileId: string; keySlot?: string }
): Promise<ModelQuotaProbeResult> {
  const base = endpoint.replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const defLim = getDefaultModelRateLimits(model);
  const knownTierLimits = REFERENCE_QUOTAS[model] || `${defLim.rpm} RPM | ${formatTokenShort(defLim.tpm)} TPM | ${defLim.rpd} RPD`;
  const cap = VERIFIED_CAPABILITIES[model] || inferCapabilities(model);
  const baseMeta = {
    inputTokenLimit: spec?.inputTokenLimit ?? cap.contextWindow,
    outputTokenLimit: spec?.outputTokenLimit,
    supportsVision: spec?.supportsVision ?? cap.vision,
    supportsThinking: spec?.supportsThinking
  };
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '1' }] }],
        generationConfig: { maxOutputTokens: 16 }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      const jsonBody: any = await res.json().catch(() => null);
      if (routerTarget) {
        syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'AVAILABLE');
        const pTok = Number(jsonBody?.usageMetadata?.promptTokenCount || 2);
        const cTok = Number(jsonBody?.usageMetadata?.candidatesTokenCount || 2);
        const tTok = Number(jsonBody?.usageMetadata?.totalTokenCount || pTok + cTok);
        recordKeySlotUsage({
          profileId: routerTarget.profileId,
          keySlot: routerTarget.keySlot || routerTarget.profileId,
          provider: 'gemini',
          model,
          promptTokens: pTok,
          outputTokens: cTok,
          totalTokens: tTok,
          latencyMs,
          timestamp: Date.now()
        }, true);
      }
      return { model, state: 'AVAILABLE', httpStatus: res.status, latencyMs, knownTierLimits, ...baseMeta };
    }

    const rawText = await res.text().catch(() => '');
    const retryHdr = res.headers?.get?.('retry-after') ?? null;
    const parsedErr = parseProviderHttpError(res.status, rawText, retryHdr, [apiKey]);
    const retryMs = parsedErr.retryAfterMs ?? parseRetryDelayMs(retryHdr, rawText);

    let state: ModelQuotaState = 'ERROR';
    if (parsedErr.rateLimitScope === 'AUTH') {
      state = 'AUTH_ERROR';
    } else if (parsedErr.rateLimitScope === 'NOT_FOUND') {
      state = 'NOT_FOUND';
    } else if (parsedErr.rateLimitScope === 'DAILY') {
      state = 'DAILY_EXHAUSTED';
      if (routerTarget) syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'DAILY_EXHAUSTED', retryMs);
    } else if (parsedErr.rateLimitScope === 'PER_MINUTE') {
      state = 'RPM_TPM_LIMITED';
      if (routerTarget) syncCooldownFromProbe(routerTarget.profileId, model, routerTarget.keySlot, 'RPM_TPM_LIMITED', retryMs);
    }

    return {
      model,
      state,
      rateLimitSubScope: parsedErr.rateLimitSubScope,
      httpStatus: res.status,
      latencyMs,
      knownTierLimits,
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
      knownTierLimits,
      ...baseMeta,
      detail: redactSecrets(err?.message || String(err), [apiKey]).slice(0, 140)
    };
  }
}

/**
 * Checks all verified/configured Gemini profiles across `GEMINI_AUTO_MODEL_POOL` using minimal 1-token probes,
 * merges real-time token/request telemetry, and synchronizes reset/exhausted states directly into ModelRouter.
 */
export async function checkGeminiProfilesQuota(models: string[] = GEMINI_AUTO_MODEL_POOL): Promise<QuotaCheckReport> {
  const db = await readProfilesDb();
  const profileIds = Object.keys(db.profiles || {}).filter(id => db.profiles[id]?.provider === 'gemini');
  const summaries: ProfileQuotaSummary[] = [];

  for (const profileId of profileIds) {
    const prof = db.profiles[profileId];
    const slots = getProfileKeySlots(profileId, prof);

    for (const slotId of slots) {
      let resolvedKey = '';
      try {
        const resolved = await resolveProvider({ profileId, keySlot: slotId });
        resolvedKey = resolved.apiKey;
      } catch (err: any) {
        summaries.push({
          profileId,
          ...(slotId !== profileId ? { keySlot: slotId } : {}),
          configuredModel: prof.model,
          keyHint: '(không đọc được keyring)',
          keyValid: false,
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

      const endpoint = prof.endpoint || 'https://generativelanguage.googleapis.com/v1beta';
      const listCheck = await listGeminiModels(endpoint, resolvedKey);
      const modelList = Array.from(new Set([prof.model, ...models].filter(Boolean)));
      const results: ModelQuotaProbeResult[] = new Array(modelList.length);
      const CONCURRENCY = 4;
      let nextIdx = 0;

      const worker = async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= modelList.length) break;
          const mId = modelList[idx];
          results[idx] = await probeSingleGeminiModel(
            endpoint,
            resolvedKey,
            mId,
            listCheck.specs.get(mId.toLowerCase()),
            { profileId, keySlot: slotId }
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, modelList.length) }, () => worker()));

      // Merge local sliding-window & daily token telemetry snapshot after probes sync
      const telemetryMap = new Map(
        getKeySlotTelemetrySnapshot()
          .filter(v => v.profileId === profileId && v.keySlot === slotId)
          .map(v => [v.model.toLowerCase(), v])
      );
      let totalRequestsToday = 0;
      let totalTokensToday = 0;
      for (const r of results) {
        const tv = telemetryMap.get(r.model.toLowerCase());
        if (tv) {
          r.usedRpm60s = tv.usedRpm60s;
          r.usedTpm60s = tv.usedTpm60s;
          r.usedRpdToday = tv.usedRpdToday;
          r.usedTokensToday = tv.usedTokensToday;
          r.avgLatencyMs = tv.avgLatencyMs;
          r.cooldownRemainingSec = tv.cooldownRemainingMs > 0 ? Math.ceil(tv.cooldownRemainingMs / 1000) : 0;
        }
      }
      for (const tv of telemetryMap.values()) {
        totalRequestsToday += tv.usedRpdToday;
        totalTokensToday += tv.usedTokensToday;
      }

      const hasValidProbes = results.some(r => r.state === 'AVAILABLE' || r.state === 'DAILY_EXHAUSTED' || r.state === 'RPM_TPM_LIMITED');
      const keyValid = listCheck.ok || hasValidProbes;
      const keyStatusLabel = listCheck.ok
        ? `HỢP LỆ (${listCheck.count} models)`
        : (hasValidProbes ? 'HỢP LỆ (generateContent OK)' : `LỖI (${listCheck.error || 'không kết nối được'})`);

      summaries.push({
        profileId,
        ...(slotId !== profileId ? { keySlot: slotId } : {}),
        configuredModel: prof.model,
        keyHint: maskKeyHint(resolvedKey),
        keyValid,
        keyStatusLabel,
        listedModelsCount: listCheck.count,
        totalRequestsToday,
        totalTokensToday,
        results
      });
    }
  }

  // Heuristic comparison across first two valid keys
  let sharedProjectSuspected = false;
  let sharedProjectReason: string | undefined;
  if (summaries.length >= 2) {
    const [a, b] = summaries;
    const mapA = new Map(a.results.map(r => [r.model, r]));
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
      sharedProjectSuspected = true;
      sharedProjectReason = `Cả ${labelA} và ${labelB} có trạng thái cạn quota ngày giống hệt nhau trên ${identicalExhaustion} model (dấu hiệu có thể đang chung 1 Google Cloud Project; Google không trả Project ID qua API key nên kiểm tra chéo ở aistudio.google.com).`;
    } else if (diffFound) {
      sharedProjectReason = `${labelA} và ${labelB} có trạng thái model khác nhau rõ rệt -> khả năng cao đang thuộc 2 Google Cloud Project độc lập (xoay vòng nhân đôi hạn mức thực!).`;
    }
  }

  const nowMs = Date.now();
  return {
    checkedAt: new Date(nowMs).toISOString(),
    vietnamResetTimeText: getPacificMidnightResetInVietnam(new Date(nowMs)),
    nextResetInText: formatDurationCountdownVN(getNextPacificMidnightMs(nowMs) - nowMs),
    profiles: summaries,
    sharedProjectSuspected,
    sharedProjectReason
  };
}

/** Measures capabilities, context limits & live readiness directly from a raw API key without opening web AI Studio. */
export async function inspectSingleApiKeySpecs(
  apiKey: string,
  providerHint?: ProviderId,
  customEndpoint?: string
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
      seen.add(spec.id.toLowerCase());
      const lim = getDefaultModelRateLimits(spec.id);
      models.push({
        id: spec.id,
        inputTokenLimit: spec.inputTokenLimit,
        outputTokenLimit: spec.outputTokenLimit,
        supportsVision: Boolean(spec.supportsVision),
        supportsThinking: spec.supportsThinking,
        tierLimits: REFERENCE_QUOTAS[spec.id] || `${lim.rpm} RPM | ${formatTokenShort(lim.tpm)} TPM | ${lim.rpd} RPD`
      });
    }
    if (models.length === 0 && live) {
      for (const m of live.models) {
        const lim = getDefaultModelRateLimits(m.id);
        models.push({
          id: m.id,
          inputTokenLimit: m.capabilities?.contextWindow,
          supportsVision: Boolean(m.capabilities?.vision),
          tierLimits: REFERENCE_QUOTAS[m.id] || `${lim.rpm} RPM | ${formatTokenShort(lim.tpm)} TPM | ${lim.rpd} RPD`
        });
      }
    }

    const sampleIds = GEMINI_AUTO_MODEL_POOL.slice(0, 4).filter(id => seen.size === 0 || seen.has(id.toLowerCase()));
    const probedSample = await Promise.all(
      (sampleIds.length > 0 ? sampleIds : GEMINI_AUTO_MODEL_POOL.slice(0, 3)).map(mId =>
        probeSingleGeminiModel(endpoint, cleanKey, mId, listCheck.specs.get(mId.toLowerCase()))
      )
    );

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

  const live = await fetchLiveModels(provider, cleanKey, customEndpoint, true);
  return {
    provider,
    providerName: meta.name,
    keyHint: maskKeyHint(cleanKey),
    keyValid: live.source === 'API_LIVE' && live.models.length > 0,
    vietnamResetTimeText: getPacificMidnightResetInVietnam(new Date(nowMs)),
    nextResetInText: formatDurationCountdownVN(getNextPacificMidnightMs(nowMs) - nowMs),
    listedModelsCount: live.models.length,
    models: live.models.map(m => ({
      id: m.id,
      inputTokenLimit: m.capabilities?.contextWindow,
      supportsVision: Boolean(m.capabilities?.vision),
      tierLimits: provider === 'groq' ? 'Theo tier Groq Cloud (TPM/RPM từ headers)' : 'Theo tier tài khoản API'
    })),
    note: live.note
  };
}

/** Periodically checks Gemini key quotas & updates ModelRouter when exhausted/RPM-limited keys reset. */
export async function watchGeminiProfilesQuota(options: {
  intervalSec?: number;
  maxIterations?: number;
  models?: string[];
  onReport: (report: QuotaCheckReport, iteration: number) => void;
  signal?: AbortSignal;
}): Promise<QuotaCheckReport | null> {
  const intervalMs = Math.max(5, Math.min(3600, options.intervalSec ?? 30)) * 1000;
  const maxIter = Math.max(1, options.maxIterations ?? 10);
  let lastReport: QuotaCheckReport | null = null;

  for (let i = 1; i <= maxIter; i++) {
    if (options.signal?.aborted) break;
    lastReport = await checkGeminiProfilesQuota(options.models);
    options.onReport(lastReport, i);
    if (i < maxIter && !options.signal?.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, intervalMs);
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }
      });
    }
  }
  return lastReport;
}

export function formatSingleKeySpecReport(spec: SingleKeySpecReport): string {
  const lines: string[] = [];
  lines.push(`=== API Key Specs: ${spec.providerName} [${spec.keyHint}] | Key: ${spec.keyValid ? '✔ HỢP LỆ' : '✖ LỖI/CHƯA XÁC MINH'} | Models: ${spec.listedModelsCount} ===`);
  lines.push(`Giờ reset Daily Quota: ${spec.vietnamResetTimeText} (còn ${spec.nextResetInText})`);
  if (spec.note) lines.push(`Ghi chú: ${spec.note}`);
  if (spec.probedSample && spec.probedSample.length > 0) {
    const sampleLatencies = spec.probedSample.map(p => p.latencyMs).filter(ms => ms > 0);
    const spark = sampleLatencies.length > 0 ? ` | Latency ${renderSparkline(sampleLatencies)}` : '';
    lines.push(`\n[Kiểm thử thực tế (Live Probe)${spark}]`);
    for (const p of spec.probedSample) {
      const icon = p.state === 'AVAILABLE' ? '✔ SẴN SÀNG' : p.state === 'DAILY_EXHAUSTED' ? '✖ HẾT RPD' : p.state === 'RPM_TPM_LIMITED' ? '⏳ RPM/TPM' : `✖ ${p.state}`;
      lines.push(`  • ${p.model.padEnd(28)} | ${icon.padEnd(14)} | ${String(p.latencyMs).padStart(4)}ms | Context: ${formatTokenShort(p.inputTokenLimit)} in / ${formatTokenShort(p.outputTokenLimit)} out | ${p.knownTierLimits}`);
    }
  }
  if (spec.models.length > 0) {
    lines.push(`\n[Thông số Model hỗ trợ từ Key (${Math.min(20, spec.models.length)}/${spec.models.length})]`);
    for (const m of spec.models.slice(0, 20)) {
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
    lines.push(`Phân tích đa key: ${report.sharedProjectReason}`);
  }
  lines.push('');

  for (const prof of report.profiles) {
    const keyBadge = prof.keyStatusLabel || (prof.keyValid ? `HỢP LỆ (${prof.listedModelsCount} models)` : 'LỖI KEY');
    const slotTag = prof.keySlot && prof.keySlot !== prof.profileId ? ` (${prof.keySlot})` : '';
    const usageTot = (prof.totalRequestsToday || prof.totalTokensToday)
      ? ` | Phiên/Ngày: ${prof.totalRequestsToday || 0} req / ${(prof.totalTokensToday || 0).toLocaleString('en-US')} tok`
      : '';
    const probeLatencies = prof.results.map(r => r.latencyMs).filter(ms => ms > 0);
    const sparkTag = probeLatencies.length > 0 ? ` | Latency ${renderSparkline(probeLatencies)}` : '';
    lines.push(`=== Profile: ${prof.profileId}${slotTag} [${prof.keyHint}] | Key: ${keyBadge} | Mặc định: ${prof.configuredModel}${usageTot}${sparkTag} ===`);
    if (prof.totalRequestsToday || prof.totalTokensToday) {
      const estCap = Math.max(20, prof.results.length * 20);
      lines.push(`  • Mức tải RPD ước tính : ${renderMeterBar(prof.totalRequestsToday || 0, estCap, 14)} (${prof.totalRequestsToday || 0} req / ${(prof.totalTokensToday || 0).toLocaleString('en-US')} tok)`);
    }
    for (const r of prof.results) {
      const icon = r.state === 'AVAILABLE'
        ? '✔ SẴN SÀNG'
        : r.state === 'DAILY_EXHAUSTED'
          ? '✖ HẾT RPD NGÀY'
          : r.state === 'RPM_TPM_LIMITED'
            ? `⏳ CHẠM ${r.rateLimitSubScope || 'RPM/TPM'}`
            : r.state === 'NOT_FOUND'
              ? '— KHÔNG KHẢ DỤNG (404)'
              : `✖ ${r.state}`;
      const ctxMeta = (r.inputTokenLimit || r.outputTokenLimit)
        ? ` | Ctx: ${formatTokenShort(r.inputTokenLimit)}/${formatTokenShort(r.outputTokenLimit)}`
        : '';
      const telemetryMeta = (r.usedRpm60s || r.usedTpm60s || r.usedRpdToday)
        ? ` | Đã dùng: ${r.usedRpm60s || 0}req/60s, ${(r.usedTpm60s || 0)}tok/60s, ${r.usedRpdToday || 0}req/ngày`
        : '';
      const cdMeta = r.cooldownRemainingSec && r.cooldownRemainingSec > 0 ? ` [Mở lại sau ${r.cooldownRemainingSec}s]` : '';
      const limitMeta = r.quotaLimitValue ? ` [Limit báo về: ${r.quotaLimitValue}]` : '';
      const retryMeta = r.retryAfterText ? ` [Chờ reset: ${r.retryAfterText}]` : '';
      const errMeta = (r.state === 'ERROR' || r.state === 'AUTH_ERROR' || r.state === 'NOT_FOUND') && r.detail
        ? ` [${r.detail.slice(0, 70)}]`
        : '';
      lines.push(`  • ${r.model.padEnd(31)} | ${icon.padEnd(18)} | ${String(r.latencyMs).padStart(4)}ms | Định mức: ${r.knownTierLimits}${ctxMeta}${telemetryMeta}${cdMeta}${limitMeta}${retryMeta}${errMeta}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
