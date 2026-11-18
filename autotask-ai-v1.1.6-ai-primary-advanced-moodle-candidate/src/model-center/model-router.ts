/** Unified Model Router for AutoTask AI.
 * Single Source of Truth for model selection, capability-aware routing (Vision vs Text),
 * rate-limit/transient error fallback, and loop prevention.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  callModel,
  resolveProvider,
  type ResolvedProvider,
  type PromptInput,
  type ProviderSpec
} from '../providers.js';
import { readProfilesDb, isFallbackEligible, sanitizeStoredProfile } from './routing.js';
import { VERIFIED_CAPABILITIES, resolveModelCapabilities, resolveProfileCapabilities, isOfficialEndpoint } from './catalog.js';
import type { ModelProfilesDb, StoredProfile } from './types.js';
import { redactSecrets } from '../security/redact.js';

export interface RouteCandidate {
  profileId: string;
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
  attempts: number;
  fallbackCount: number;
  history: { profileId: string; error?: string; latencyMs: number }[];
}

export interface RouteOptions {
  profileOverride?: string;
  fallbackOverrides?: string[];
  requiresVision?: boolean;
  maxAttemptsPerModel?: number;
  onModelSwitch?: (from: string, to: string, reason: string) => void;
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
    const primaryId = isOverride
      ? options.profileOverride!
      : (db.default && available[db.default] ? db.default : availableIds[0]);

    // Candidate fallback list: task override if specified, otherwise Model Center db.fallbacks
    const fallbackList = options.fallbackOverrides && options.fallbackOverrides.length > 0
      ? options.fallbackOverrides
      : (db.fallbacks || []);

    const visited = new Set<string>();
    const candidates: RouteCandidate[] = [];

    // Helper to evaluate and push candidate
    const consider = (pId: string) => {
      if (visited.has(pId) || !available[pId]) return;
      visited.add(pId);
      const prof = available[pId];
      const hasVision = ModelRouter.isVisionCapable(prof);

      // Vision capability filter: If task requires vision, reject non-vision models
      if (options.requiresVision && !hasVision) {
        return;
      }

      candidates.push({
        profileId: pId,
        provider: prof.provider,
        model: prof.model,
        supportsVision: hasVision
      });
    };

    // 1. Try primary model first
    consider(primaryId);

    // 2. If primary doesn't support vision but vision is required, find eligible vision fallbacks
    for (const fId of fallbackList) {
      consider(fId);
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
      source: isOverride ? 'TASK_OVERRIDE' : 'MODEL_CENTER_DEFAULT'
    };
  }

  /** Executes an AI prompt through the unified router with fallback and audit trail */
  static async execute(
    req: PromptInput,
    options: RouteOptions = {},
    callFn = callModel
  ): Promise<RouterExecutionResult> {
    // If the request contains an image, automatically require vision
    const requiresVision = options.requiresVision || Boolean(req.imageBase64);
    const plan = await ModelRouter.resolveCandidates({ ...options, requiresVision });

    const maxAttempts = Math.max(1, Math.min(3, options.maxAttemptsPerModel || 1));
    const history: { profileId: string; error?: string; latencyMs: number }[] = [];
    let totalAttempts = 0;
    let fallbackCount = 0;
    let lastError: unknown;
    let activeProfile = plan.primary.profileId;

    for (let cIdx = 0; cIdx < plan.candidates.length; cIdx++) {
      const candidate = plan.candidates[cIdx];
      activeProfile = candidate.profileId;

      if (cIdx > 0) {
        fallbackCount++;
        const prev = plan.candidates[cIdx - 1];
        const rawReason = lastError instanceof Error ? lastError.message : String(lastError || 'Fallback');
        const reason = redactSecrets(rawReason);
        if (options.onModelSwitch) {
          try {
            options.onModelSwitch(prev.profileId, candidate.profileId, reason);
          } catch {}
        }
      }

      let provider: ResolvedProvider;
      try {
        const resolveCandidate = options.resolveFn || resolveProvider;
        provider = await resolveCandidate({ profileId: candidate.profileId });
      } catch (initErr) {
        const cleanInitErr = sanitizeProviderError(initErr, candidate.profileId, candidate.provider);
        lastError = cleanInitErr;
        history.push({ profileId: candidate.profileId, error: cleanInitErr.message, latencyMs: 0 });
        if (!isFallbackEligible(initErr)) {
          throw cleanInitErr;
        }
        continue;
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        totalAttempts++;
        const start = Date.now();
        try {
          if (req.imageBase64 && !candidate.supportsVision) {
            throw new Error(
              `Bảo mật Vision: Chặn gửi ảnh/tài liệu tới model "${candidate.model}" (profile "${candidate.profileId}") vì chưa xác minh hỗ trợ Vision.`
            );
          }
          const output = await callFn(provider, req);
          const latencyMs = Date.now() - start;
          history.push({ profileId: candidate.profileId, latencyMs });

          return {
            output,
            initialProfile: plan.primary.profileId,
            finalProfile: candidate.profileId,
            attempts: totalAttempts,
            fallbackCount,
            history
          };
        } catch (err) {
          const latencyMs = Date.now() - start;
          const msg = redactSecrets(err instanceof Error ? err.message : String(err));
          history.push({ profileId: candidate.profileId, error: msg, latencyMs });
          lastError = err;

          // Auth / 401 / 403 / Malformed request errors must NEVER fallback
          if (!isFallbackEligible(err)) {
            throw sanitizeProviderError(err, candidate.profileId, candidate.provider);
          }

          // Backoff before retry on same model
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, Math.min(2000, 500 * attempt)));
          }
        }
      }
    }

    const lastErrClean = redactSecrets(lastError instanceof Error ? lastError.message : String(lastError));
    const finalErr = new Error(
      `Toàn bộ ${totalAttempts} lần gọi qua ${plan.candidates.length} model đều thất bại. Lỗi cuối: ${lastErrClean}`
    );
    (finalErr as any).isFallbackEligible = false;
    throw finalErr;
  }
}
