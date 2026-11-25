/** Verified AI Model Catalog and API Listing for OpenAI, Gemini, Anthropic, Groq, Custom. */
import { createHash } from 'node:crypto';
import type { ProviderId, ProviderKind, ModelCapability, ModelItem, CapabilitySource, StoredProfile } from './types.js';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  defaultEndpoint: string;
  supportsApiListing: boolean;
  listingNote?: string;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMeta> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    supportsApiListing: true,
    listingNote: 'Lấy trực tiếp danh sách từ GET /v1/models khi có API key'
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    supportsApiListing: true,
    listingNote: 'Lấy trực tiếp danh sách từ GET /v1beta/models khi có API key'
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    supportsApiListing: true,
    listingNote: 'Lấy trực tiếp danh sách từ GET https://api.anthropic.com/v1/models khi có API key'
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    defaultEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
    supportsApiListing: true,
    listingNote: 'Lấy trực tiếp danh sách từ GET /openai/v1/models khi có API key'
  },
  custom: {
    id: 'custom',
    name: 'Custom HTTPS Endpoint',
    kind: 'openai-compatible',
    defaultEndpoint: '',
    supportsApiListing: false,
    listingNote: 'Endpoint tùy chỉnh có thể khác nhau; hỗ trợ nhập Model ID thủ công'
  }
};

/** Verified capabilities for well-known models (Tested and verified empirically) */
export const VERIFIED_CAPABILITIES: Record<string, ModelCapability> = {
  // OpenAI
  'gpt-5': { vision: true, contextWindow: 400000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'OpenAI GPT-5 flagship reasoning & multimodal' },
  'gpt-5-mini': { vision: true, contextWindow: 400000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Fast cost-efficient GPT-5 Mini multimodal' },
  'o3': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Deep STEM & visual reasoning flagship (o3)' },
  'o4-mini': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'High-speed STEM & math reasoning (o4-mini)' },
  'gpt-4o': { vision: true, contextWindow: 128000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Flagship multimodal, high reasoning & speed' },
  'gpt-4o-mini': { vision: true, contextWindow: 128000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Fast, cost-efficient multimodal' },
  'o1': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Deep reasoning, complex logic tasks' },
  'o3-mini': { vision: false, contextWindow: 200000, taskCompatibility: ['DOM', 'Reasoning'], description: 'Fast reasoning for code and text' },
  'gpt-4-turbo': { vision: true, contextWindow: 128000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Legacy GPT-4 turbo with vision' },

  // Gemini & Gemma (Google AI)
  'gemini-3.5-flash-lite': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Ultra-fast Gemini 3.5 Flash Lite (15 RPM, 500 RPD)' },
  'gemini-3.1-flash-lite': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Lightweight high-throughput 3.1 Flash Lite (15 RPM, 500 RPD)' },
  'gemini-3.1-flash-lite-preview': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Preview Gemini 3.1 Flash Lite' },
  'gemini-flash-lite-latest': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Latest Gemini Flash Lite alias' },
  'gemini-3-flash-preview': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'High-accuracy Gemini 3 Flash Preview' },
  'gemini-3.5-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Next-gen Gemini 3.5 Flash, 1M context' },
  'gemini-3.6-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Next-gen Gemini 3.6 Flash, 1M context' },
  'gemini-3.7-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Next-gen Gemini 3.7 Flash, 1M context' },
  'gemini-3.8-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Latest Gemini 3.8 Flash, high speed' },
  'gemini-flash-latest': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Latest Gemini Flash alias' },
  'gemini-2.5-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Next-gen adaptive flash, 1M context' },
  'gemini-2.5-pro': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Next-gen flagship reasoning, 2M context' },
  'gemini-3.1-pro-preview': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Gemini 3.1 Pro Preview flagship reasoning' },
  'gemini-3-pro-preview': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Gemini 3 Pro Preview deep multimodal reasoning' },
  'gemini-3.5-pro': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Gemini 3.5 Pro flagship reasoning' },
  'gemini-4-pro': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Gemini 4 Pro frontier reasoning' },
  'gemini-2.0-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Ultra-fast multimodal 2.0 model' },
  'gemini-1.5-pro': { vision: true, contextWindow: 2000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Long context 2M tokens pro model' },
  'gemini-1.5-flash': { vision: true, contextWindow: 1000000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Lightweight fast multimodal 1.5' },
  'gemma-4-26b-a4b-it': { vision: false, contextWindow: 128000, taskCompatibility: ['DOM', 'Reasoning'], description: 'Gemma 4 26B A4B high-quota open model (14.4K RPD)' },
  'gemma-4-31b-it': { vision: false, contextWindow: 128000, taskCompatibility: ['DOM', 'Reasoning'], description: 'Gemma 4 31B high-quota open model (30 RPM, 14.4K RPD)' },

  // Anthropic
  'claude-opus-4-1': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Claude Opus 4.1 frontier reasoning' },
  'claude-sonnet-4-5': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Claude Sonnet 4.5 high-accuracy coding & math' },
  'claude-opus-4-20250514': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Claude Opus 4 deep reasoning & vision' },
  'claude-sonnet-4-20250514': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Claude Sonnet 4 hybrid thinking & vision' },
  'claude-3-7-sonnet-20250219': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Claude 3.7 with hybrid thinking & vision' },
  'claude-3-5-sonnet-20241022': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Industry benchmark for code & computer-use' },
  'claude-3-5-haiku-20241022': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'High-speed intelligence' },
  'claude-3-opus-20240229': { vision: true, contextWindow: 200000, taskCompatibility: ['DOM', 'Vision', 'Reasoning'], description: 'Complex analysis & deep writing' },

  // Groq
  'llama-3.3-70b-versatile': { vision: false, contextWindow: 128000, taskCompatibility: ['DOM', 'Reasoning'], description: 'Llama 3.3 70B on LPUs, ultra-fast' },
  'llama-3.1-8b-instant': { vision: false, contextWindow: 128000, taskCompatibility: ['DOM', 'Reasoning'], description: 'Llama 3.1 8B instant inference' },
  'mixtral-8x7b-32768': { vision: false, contextWindow: 32768, taskCompatibility: ['DOM', 'Reasoning'], description: 'MoE model on Groq' }
};

/** Ordered pool of working Gemini & Gemma models for automatic multi-model load-balancing & quota resilience */
export const GEMINI_AUTO_MODEL_POOL: string[] = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-lite-latest',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-pro-preview',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it'
];

export function inferCapabilities(modelId: string): ModelCapability {
  const norm = modelId.trim().toLowerCase();
  for (const [key, cap] of Object.entries(VERIFIED_CAPABILITIES)) {
    if (norm === key.toLowerCase()) {
      return cap;
    }
  }
  // Strict heuristic deduction: never assume vision for unverified or custom prefixed models
  const hasVision = !norm.includes('unverified') &&
    !norm.startsWith('custom-') &&
    /(?:-vision|(?<!\w)vl(?!\w)|vision(?!\w)|(?<!\w)4o(?!\w)|\bgpt-5\b|\bo3\b|\bo4-mini\b|claude-(?:3|4|sonnet-4|opus-4)|gemini-(?:1\.5|2\.0|2\.5|3|4))/i.test(norm) &&
    !/(?:text-only|embedding|moderation|tts|whisper|dall-e|aqa)/i.test(norm);
  const isReasoning = /(?:o1|o3|o4|gpt-5|r1|reasoning|thinking|opus|sonnet|\bpro\b|70b)/i.test(norm);
  return {
    vision: hasVision,
    contextWindow: norm.includes('1m') ? 1000000 : norm.includes('128k') ? 128000 : 32000,
    taskCompatibility: hasVision ? ['DOM', 'Vision', 'Reasoning'] : isReasoning ? ['DOM', 'Reasoning'] : ['DOM'],
    description: 'Tự động suy luận khả năng từ tên model'
  };
}

/** Normalizes casual user inputs into valid official model identifiers */
export function normalizeModelSlug(provider: ProviderId, rawModel: string): string {
  let model = rawModel.trim();
  if (!model) return model;

  if (provider === 'gemini') {
    model = model.replace(/^models\//i, '').trim();
    const lower = model.toLowerCase();
    if (lower === 'gemini flash' || lower === 'flash') {
      return 'gemini-3.1-flash-lite';
    }
    if (lower === 'gemini 3.1 flash' || lower === 'gemini-3.1-flash' || lower === 'gemini 3.1') {
      return 'gemini-3.1-flash-lite';
    }
    if (lower === 'gemini 2.5 flash' || lower === 'gemini-2.5-flash' || lower === 'gemini 2.5') {
      return 'gemini-2.5-flash';
    }
    if (lower === 'gemini 1.5 flash' || lower === 'gemini-1.5-flash' || lower === 'gemini 1.5') {
      return 'gemini-1.5-flash';
    }
    if (lower === 'gemini pro' || lower === 'gemini 2.5 pro' || lower === 'pro') {
      return 'gemini-2.5-pro';
    }
    return model.replace(/\s+/g, '-');
  }

  if (provider === 'openai' || provider === 'groq') {
    return model.replace(/\s+/g, '-');
  }

  return model;
}

interface OfficialProviderSpec {
  hosts: string[];
  allowedPaths: RegExp;
}

export const OFFICIAL_PROVIDER_SPECS: Record<string, OfficialProviderSpec> = {
  openai: {
    hosts: ['api.openai.com'],
    allowedPaths: /^\/(v1(\/.*)?)?$/i
  },
  anthropic: {
    hosts: ['api.anthropic.com'],
    allowedPaths: /^\/(v1(\/.*)?)?$/i
  },
  gemini: {
    hosts: ['generativelanguage.googleapis.com'],
    allowedPaths: /^\/(v1|v1beta)?(\/.*)?$/i
  },
  groq: {
    hosts: ['api.groq.com'],
    allowedPaths: /^\/(openai\/v1|v1)?(\/.*)?$/i
  },
  deepseek: {
    hosts: ['api.deepseek.com'],
    allowedPaths: /^\/(v1(\/.*)?)?$/i
  }
};

export const OFFICIAL_PROVIDER_HOSTS: Record<string, string[]> = {
  openai: ['api.openai.com'],
  anthropic: ['api.anthropic.com'],
  gemini: ['generativelanguage.googleapis.com'],
  groq: ['api.groq.com'],
  deepseek: ['api.deepseek.com']
};

const SENSITIVE_PARAM_NAMES = new Set([
  'authorization',
  'auth',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'client_secret',
  'password',
  'pass',
  'passwd',
  'pwd',
  'session',
  'session_id',
  'sessionid',
  'cookie',
  'credential',
  'credentials',
  'bearer',
  'jwt',
  'signature',
  'sig'
]);

function isSensitiveParamKey(paramKey: string): boolean {
  const normKey = paramKey.trim().toLowerCase();
  if (SENSITIVE_PARAM_NAMES.has(normKey)) return true;
  for (const s of SENSITIVE_PARAM_NAMES) {
    if (normKey === s || normKey.endsWith(`_${s}`) || normKey.startsWith(`${s}_`) || normKey.endsWith(`-${s}`) || normKey.startsWith(`${s}-`)) {
      return true;
    }
  }
  return false;
}

export function containsSensitiveQueryParams(url: URL): boolean {
  // 1. Check searchParams
  for (const [key, val] of url.searchParams.entries()) {
    if (isSensitiveParamKey(key)) return true;
    try {
      const decodedKey = decodeURIComponent(key);
      if (isSensitiveParamKey(decodedKey)) return true;
    } catch {
      return true;
    }

    const lowerVal = val.toLowerCase();
    if (lowerVal.startsWith('bearer ') || lowerVal.startsWith('sk-') || lowerVal.startsWith('eyjhbgci')) {
      return true;
    }
  }

  // 2. Check raw search string for encoded variants
  if (url.search) {
    try {
      const decodedSearch = decodeURIComponent(url.search).toLowerCase();
      for (const s of SENSITIVE_PARAM_NAMES) {
        if (decodedSearch.includes(`${s}=`) || decodedSearch.includes(`${s}:`)) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  // 3. Check fragment / hash
  if (url.hash) {
    const hashContent = url.hash.replace(/^#\/?/, '');
    try {
      const hashParams = new URLSearchParams(hashContent);
      for (const [key] of hashParams.entries()) {
        if (isSensitiveParamKey(key)) return true;
        try {
          if (isSensitiveParamKey(decodeURIComponent(key))) return true;
        } catch {
          return true;
        }
      }
    } catch {}

    try {
      const decodedHash = decodeURIComponent(url.hash).toLowerCase();
      for (const s of SENSITIVE_PARAM_NAMES) {
        if (decodedHash.includes(`${s}=`) || decodedHash.includes(`${s}:`)) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  return false;
}

/** Checks whether an endpoint is the official vendor-hosted endpoint with strict protocol, port, userinfo, sensitive query and path validation */
export function isOfficialEndpoint(provider: string, endpoint?: string): boolean {
  if (!provider) return false;
  const prov = provider.trim().toLowerCase();
  const spec = OFFICIAL_PROVIDER_SPECS[prov];
  if (!spec) return false;

  // If no endpoint is explicitly provided, official providers default to their official vendor endpoint
  if (!endpoint || !endpoint.trim()) return true;

  try {
    const raw = endpoint.trim();
    const url = new URL(raw);

    // 1. Protocol must be strict https:
    if (url.protocol !== 'https:') {
      return false;
    }

    // 2. No embedded username or password (userinfo) allowed
    if (url.username || url.password) {
      return false;
    }

    // 3. Port must be empty or standard 443
    if (url.port && url.port !== '443') {
      return false;
    }

    // 4. Hostname must exactly match one of the allowed official vendor hosts (no subdomains or suffixes like evil.api.openai.com or api.openai.com.attacker.com)
    const host = url.hostname.toLowerCase();
    if (!spec.hosts.includes(host)) {
      return false;
    }

    // 5. Query and hash must not contain credential keywords
    if (containsSensitiveQueryParams(url)) {
      return false;
    }

    // 6. Pathname must match provider's allowed canonical API path structure
    const pathname = url.pathname || '/';
    if (!spec.allowedPaths.test(pathname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export interface UserProfileMetadata {
  inputTokenLimit?: number;
  supportsVision?: boolean;
  description?: string;
}

export interface ModelMetadataInput extends UserProfileMetadata {
  provenance?: CapabilitySource;
  isTrustedLiveApi?: boolean;
}

/** Internal trusted registry populated ONLY from verified live HTTP responses of official vendor APIs.
 * Never writable from disk profile JSON or caller-supplied StoredProfile metadata.
 */
interface TrustedLiveModelMeta {
  supportsVision?: boolean;
  inputTokenLimit?: number;
  description?: string;
}
const TRUSTED_LIVE_REGISTRY = new Map<string, TrustedLiveModelMeta>();

function trustedLiveKey(provider: string, modelId: string): string {
  return `${provider.trim().toLowerCase()}::${modelId.trim().toLowerCase()}`;
}

function recordTrustedLiveModel(provider: ProviderId, modelId: string, meta: TrustedLiveModelMeta): void {
  if (meta.supportsVision !== undefined || meta.inputTokenLimit !== undefined) {
    TRUSTED_LIVE_REGISTRY.set(trustedLiveKey(provider, modelId), { ...meta });
  }
}

/** Strictly sanitizes user/profile metadata so forged `isTrustedLiveApi` or `provenance` flags are always stripped. */
export function sanitizeUserProfileMetadata(raw: unknown): UserProfileMetadata | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: UserProfileMetadata = {};
  if (typeof r.supportsVision === 'boolean') out.supportsVision = r.supportsVision;
  if (typeof r.inputTokenLimit === 'number' && Number.isFinite(r.inputTokenLimit) && r.inputTokenLimit > 0) {
    out.inputTokenLimit = Math.floor(r.inputTokenLimit);
  }
  if (typeof r.description === 'string' && r.description.trim()) {
    out.description = r.description.trim().slice(0, 120);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Single Source of Truth for StoredProfile capability & provenance resolution across Catalog, ModelRouter, and Model Center UI.
 * Enforces strict separation between user profile JSON (`USER_DECLARED`) and trusted live provider metadata (`PROVIDER_REPORTED`).
 */
export function resolveProfileCapabilities(
  profile: StoredProfile
): { capabilities: ModelCapability; capabilitySource: CapabilitySource } {
  const cleanMeta = sanitizeUserProfileMetadata(profile.metadata);
  const udc = profile.userDeclaredCapabilities;

  // 1. Explicit userDeclaredCapabilities on profile -> always USER_DECLARED (never VERIFIED or PROVIDER_REPORTED)
  if (
    udc &&
    (udc.vision !== undefined ||
      udc.contextWindow !== undefined ||
      (Array.isArray(udc.taskCompatibility) && udc.taskCompatibility.length > 0) ||
      Boolean(udc.description))
  ) {
    const base = resolveModelCapabilities(profile.model, cleanMeta, profile.provider, profile.endpoint);
    const hasVision = udc.vision !== undefined ? Boolean(udc.vision) : base.capabilities.vision;
    const contextWindow =
      typeof udc.contextWindow === 'number' && Number.isFinite(udc.contextWindow) && udc.contextWindow > 0
        ? Math.floor(udc.contextWindow)
        : base.capabilities.contextWindow;
    const defaultTasks: ModelCapability['taskCompatibility'] = hasVision
      ? ['DOM', 'Vision', 'Reasoning']
      : ['DOM', 'Reasoning'];
    const taskCompatibility =
      Array.isArray(udc.taskCompatibility) && udc.taskCompatibility.length > 0
        ? udc.taskCompatibility.filter(t => t !== 'Vision' || hasVision)
        : defaultTasks;
    return {
      capabilities: {
        vision: hasVision,
        contextWindow,
        taskCompatibility: taskCompatibility.length > 0 ? taskCompatibility : ['DOM'],
        description: udc.description?.slice(0, 80) || 'Khai báo cấu hình từ người dùng'
      },
      capabilitySource: 'USER_DECLARED'
    };
  }

  // 2. Trusted live-API registry check (only on official provider + official endpoint, never from StoredProfile.metadata)
  const isOfficial = isOfficialEndpoint(profile.provider, profile.endpoint);
  if (isOfficial && profile.provider !== 'custom') {
    const trustedLive = TRUSTED_LIVE_REGISTRY.get(trustedLiveKey(profile.provider, profile.model));
    if (trustedLive) {
      return resolveModelCapabilities(
        profile.model,
        { ...trustedLive, isTrustedLiveApi: true },
        profile.provider,
        profile.endpoint
      );
    }
  }

  // 3. Resolve strictly with sanitized user metadata (never passing `isTrustedLiveApi` or `provenance`)
  return resolveModelCapabilities(profile.model, cleanMeta, profile.provider, profile.endpoint);
}

/** Resolves model capabilities and assigns one of strict confidence levels with provider and endpoint trust validation */
export function resolveModelCapabilities(
  modelId: string,
  providerMeta?: ModelMetadataInput,
  provider?: string,
  endpoint?: string
): { capabilities: ModelCapability; capabilitySource: CapabilitySource } {
  const norm = modelId.trim().toLowerCase();
  let prov = (provider || '').trim().toLowerCase();

  // If provider not explicitly provided and endpoint not provided, infer default provider from model name
  if (!prov && !endpoint) {
    if (norm.startsWith('gpt') || norm.startsWith('o1') || norm.startsWith('o3')) prov = 'openai';
    else if (norm.startsWith('claude')) prov = 'anthropic';
    else if (norm.startsWith('gemini')) prov = 'gemini';
    else if (norm.includes('llama') || norm.includes('mixtral')) prov = 'groq';
    else if (norm.startsWith('deepseek')) prov = 'deepseek';
  }

  const isOfficial = prov ? isOfficialEndpoint(prov, endpoint) : false;

  // 1. If provider is explicitly 'custom' or an unverified custom endpoint is used, official verification is NEVER assumed!
  const isCustomOrUntrusted = prov === 'custom' || (Boolean(endpoint) && !isOfficial);
  if (isCustomOrUntrusted) {
    if (providerMeta && (providerMeta.inputTokenLimit || providerMeta.supportsVision !== undefined)) {
      const hasVision = Boolean(providerMeta.supportsVision);
      return {
        capabilities: {
          vision: hasVision,
          contextWindow: providerMeta.inputTokenLimit || 32000,
          taskCompatibility: hasVision ? ['DOM', 'Vision', 'Reasoning'] : ['DOM', 'Reasoning'],
          description: providerMeta.description?.slice(0, 80) || 'Khai báo cấu hình từ người dùng'
        },
        capabilitySource: 'USER_DECLARED'
      };
    }
    return {
      capabilities: {
        vision: false,
        contextWindow: 32000,
        taskCompatibility: ['DOM'],
        description: 'Proxy hoặc Custom endpoint không chính thức'
      },
      capabilitySource: 'UNKNOWN'
    };
  }

  // 2. VERIFIED: EXACT match against VERIFIED_CAPABILITIES ONLY when provider AND endpoint are official
  for (const [key, cap] of Object.entries(VERIFIED_CAPABILITIES)) {
    if (norm === key.toLowerCase()) {
      let providerMatches = true;
      if (prov) {
        if ((key.startsWith('gpt') || key.startsWith('o1') || key.startsWith('o3')) && prov !== 'openai') providerMatches = false;
        if (key.startsWith('claude') && prov !== 'anthropic') providerMatches = false;
        if (key.startsWith('gemini') && prov !== 'gemini') providerMatches = false;
        if ((key.includes('llama') || key.includes('mixtral')) && prov !== 'groq') providerMatches = false;
        if (key.startsWith('deepseek') && prov !== 'deepseek') providerMatches = false;
      }
      if (providerMatches && isOfficial) {
        return { capabilities: cap, capabilitySource: 'VERIFIED' };
      }
    }
  }

  // 3. User-supplied metadata on official endpoint for unknown/custom model:
  // If metadata is provided by caller/profile (not verified live API response), it is STRICTLY USER_DECLARED!
  // It is ONLY PROVIDER_REPORTED if it genuinely originated from an authentic live API check on an official endpoint.
  if (providerMeta && (providerMeta.inputTokenLimit || providerMeta.supportsVision !== undefined)) {
    const hasVision = Boolean(providerMeta.supportsVision);
    const isGenuineProviderReported = Boolean(providerMeta.isTrustedLiveApi && isOfficial);
    return {
      capabilities: {
        vision: hasVision,
        contextWindow: providerMeta.inputTokenLimit || 32000,
        taskCompatibility: hasVision ? ['DOM', 'Vision', 'Reasoning'] : ['DOM', 'Reasoning'],
        description: providerMeta.description?.slice(0, 80) || (isGenuineProviderReported ? 'Dữ liệu cấu hình do API nhà cung cấp báo cáo' : 'Khai báo cấu hình từ người dùng')
      },
      capabilitySource: isGenuineProviderReported ? 'PROVIDER_REPORTED' : 'USER_DECLARED'
    };
  }

  // 4. UNKNOWN for unverified custom prefixes
  if (norm.includes('unverified') || norm.startsWith('custom-') || prov === 'custom') {
    return {
      capabilities: {
        vision: false,
        contextWindow: 32000,
        taskCompatibility: ['DOM'],
        description: 'Model tùy chỉnh chưa được xác minh'
      },
      capabilitySource: 'UNKNOWN'
    };
  }

  // 5. INFERRED
  const inferred = inferCapabilities(modelId);
  const isKnownFamily = /^(?:gpt-[34]|o[13]|claude-[3]|gemini-(?:1\.5|2\.0|2\.5)|llama-3|mixtral|qwen-2\.5|deepseek)/i.test(norm);
  return {
    capabilities: inferred,
    capabilitySource: isKnownFamily ? 'INFERRED' : 'UNKNOWN'
  };
}

/** Official static model list for offline lookup or fallback */
export function getStaticModels(provider: ProviderId): ModelItem[] {
  const results: ModelItem[] = [];
  for (const [id, cap] of Object.entries(VERIFIED_CAPABILITIES)) {
    let match = false;
    if (provider === 'openai' && (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3'))) match = true;
    if (provider === 'gemini' && id.startsWith('gemini')) match = true;
    if (provider === 'anthropic' && id.startsWith('claude')) match = true;
    if (provider === 'groq' && (id.includes('llama') || id.includes('mixtral'))) match = true;
    if (match) {
      results.push({
        id,
        provider,
        capabilities: cap,
        isVerified: true,
        capabilitySource: 'VERIFIED'
      });
    }
  }
  return results;
}

interface CacheEntry {
  timestamp: number;
  data: {
    models: ModelItem[];
    source: 'API_LIVE' | 'OFFICIAL_REGISTRY';
    note?: string;
  };
}

const MODEL_CACHE = new Map<string, CacheEntry>();
export const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes TTL

export function clearModelCache(): void {
  MODEL_CACHE.clear();
  TRUSTED_LIVE_REGISTRY.clear();
}

export function getModelCacheKey(provider: string, apiKey: string, customEndpoint = ''): string {
  const hash = createHash('sha256').update(`${provider}:${apiKey}:${customEndpoint}`).digest('hex');
  return `${provider}:${hash}`;
}

/** Fetch real models directly from provider API with TTL caching */
export async function fetchLiveModels(
  provider: ProviderId,
  apiKey: string,
  customEndpoint?: string,
  bypassCache = false
): Promise<{
  models: ModelItem[];
  source: 'API_LIVE' | 'OFFICIAL_REGISTRY';
  note?: string;
}> {
  if (provider === 'custom') {
    return {
      models: getStaticModels(provider),
      source: 'OFFICIAL_REGISTRY',
      note: PROVIDER_REGISTRY[provider].listingNote
    };
  }

  if (!apiKey) {
    return {
      models: getStaticModels(provider),
      source: 'OFFICIAL_REGISTRY',
      note: 'Chưa có API key để gọi trực tiếp API; hiển thị danh mục chính thức đã xác minh.'
    };
  }

  const cacheKey = getModelCacheKey(provider, apiKey, customEndpoint);
  if (!bypassCache) {
    const cached = MODEL_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      return cached.data;
    }
  }

  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const rawList: any[] = Array.isArray(data.data) ? data.data : [];
      const filtered = rawList
        .map(m => m.id as string)
        .filter(id => /gpt|o1|o3|chat/i.test(id) && !/audio|realtime|tts|whisper|dall-e|embedding|moderation/i.test(id))
        .sort((a, b) => b.localeCompare(a));

      const models: ModelItem[] = filtered.map(id => {
        const { capabilities, capabilitySource } = resolveModelCapabilities(id, { isTrustedLiveApi: true }, 'openai', customEndpoint);
        return {
          id,
          provider: 'openai' as ProviderId,
          capabilities,
          isVerified: capabilitySource === 'VERIFIED',
          capabilitySource
        };
      });

      const out = { models, source: 'API_LIVE' as const };
      MODEL_CACHE.set(cacheKey, { timestamp: Date.now(), data: out });
      return out;
    }

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const rawList: any[] = Array.isArray(data.data) ? data.data : [];
      const models: ModelItem[] = rawList
        .map((m: any) => {
          const id = m.id as string;
          const { capabilities, capabilitySource } = resolveModelCapabilities(id, { isTrustedLiveApi: true }, 'anthropic', customEndpoint);
          return {
            id,
            provider: 'anthropic' as ProviderId,
            name: m.display_name,
            capabilities,
            isVerified: capabilitySource === 'VERIFIED',
            capabilitySource
          };
        })
        .sort((a, b) => b.id.localeCompare(a.id));

      const out = { models, source: 'API_LIVE' as const };
      MODEL_CACHE.set(cacheKey, { timestamp: Date.now(), data: out });
      return out;
    }

    if (provider === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const rawList: any[] = Array.isArray(data.data) ? data.data : [];
      const models: ModelItem[] = rawList.map(m => {
        const { capabilities, capabilitySource } = resolveModelCapabilities(m.id, { isTrustedLiveApi: true }, 'groq', customEndpoint);
        return {
          id: m.id,
          provider: 'groq' as ProviderId,
          capabilities,
          isVerified: capabilitySource === 'VERIFIED',
          capabilitySource
        };
      });
      const out = { models, source: 'API_LIVE' as const };
      MODEL_CACHE.set(cacheKey, { timestamp: Date.now(), data: out });
      return out;
    }

    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const rawList: any[] = Array.isArray(data.models) ? data.models : [];
      const isOfficial = isOfficialEndpoint('gemini', customEndpoint);
      const models: ModelItem[] = rawList
        .map((m: any) => {
          const id = (m.name || '').replace(/^models\//, '');
          const verified = VERIFIED_CAPABILITIES[id];
          // Only trust explicit vendor modality declaration or verified catalog; never promote regex guesses to PROVIDER_REPORTED vision
          const vendorReportedVision = Array.isArray(m.supportedModalities)
            ? m.supportedModalities.some((mod: unknown) => String(mod).toUpperCase() === 'IMAGE')
            : undefined;
          const liveMeta: TrustedLiveModelMeta = {
            inputTokenLimit: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
            supportsVision: verified ? verified.vision : vendorReportedVision,
            description: typeof m.description === 'string' ? m.description : undefined
          };
          if (isOfficial && !verified) {
            recordTrustedLiveModel('gemini', id, liveMeta);
          }
          const { capabilities, capabilitySource } = resolveModelCapabilities(id, {
            ...liveMeta,
            isTrustedLiveApi: isOfficial
          }, 'gemini', customEndpoint);
          return {
            id,
            provider: 'gemini' as ProviderId,
            capabilities,
            isVerified: capabilitySource === 'VERIFIED',
            capabilitySource
          };
        })
        .filter(m => m.id && !/embedding|aqa/i.test(m.id));

      const out = { models, source: 'API_LIVE' as const };
      MODEL_CACHE.set(cacheKey, { timestamp: Date.now(), data: out });
      return out;
    }
  } catch (e) {
    return {
      models: getStaticModels(provider),
      source: 'OFFICIAL_REGISTRY',
      note: `Không thể kết nối API (${e instanceof Error ? e.message : String(e)}). Hiển thị danh mục xác minh.`
    };
  }

  return { models: getStaticModels(provider), source: 'OFFICIAL_REGISTRY' };
}

/** Pagination and search filter */
export function filterAndPaginate(
  models: ModelItem[],
  query = '',
  page = 1,
  pageSize = 6
): { items: ModelItem[]; total: number; totalPages: number; currentPage: number } {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter(m => m.id.toLowerCase().includes(q) || m.capabilities.description?.toLowerCase().includes(q))
    : models;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const start = (currentPage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return { items, total, totalPages, currentPage };
}
