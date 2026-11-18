/** Model routing, fallback ordering, cycle prevention and notifications. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelProfilesDb, StoredProfile, ProviderId, ProviderKind, ModelCapability } from './types.js';

const ALLOWED_PROVIDERS = new Set<ProviderId>(['openai', 'gemini', 'anthropic', 'groq', 'custom']);
const ALLOWED_KINDS = new Set<ProviderKind>(['openai-compatible', 'gemini', 'anthropic']);
const ALLOWED_TASKS = new Set<'DOM' | 'Vision' | 'Reasoning'>(['DOM', 'Vision', 'Reasoning']);
const ALLOWED_VERIFIED_STATUS = new Set<'VERIFIED' | 'FAILED' | 'UNTESTED'>(['VERIFIED', 'FAILED', 'UNTESTED']);

function getDbPath(customPath?: string): string {
  return customPath ? resolve(customPath) : resolve('.private', 'model-profiles.json');
}

/** Strictly sanitizes a StoredProfile loaded from JSON or untrusted caller input,
 * stripping all out-of-schema properties (e.g. forged `metadata.isTrustedLiveApi` or `provenance`).
 */
export function sanitizeStoredProfile(raw: unknown): StoredProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const provider = typeof r.provider === 'string' ? (r.provider.trim().toLowerCase() as ProviderId) : null;
  const kind = typeof r.kind === 'string' ? (r.kind.trim().toLowerCase() as ProviderKind) : null;
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const endpoint = typeof r.endpoint === 'string' ? r.endpoint.trim() : '';

  if (!provider || !ALLOWED_PROVIDERS.has(provider)) return null;
  if (!kind || !ALLOWED_KINDS.has(kind)) return null;
  if (!model) return null;

  const clean: StoredProfile = {
    provider,
    kind,
    model,
    endpoint
  };

  if (typeof r.displayName === 'string' && r.displayName.trim()) {
    clean.displayName = r.displayName.trim().slice(0, 120);
  }
  if (typeof r.createdAt === 'string' && r.createdAt.trim()) {
    clean.createdAt = r.createdAt.trim().slice(0, 64);
  }
  if (typeof r.lastTestedAt === 'string' && r.lastTestedAt.trim()) {
    clean.lastTestedAt = r.lastTestedAt.trim().slice(0, 64);
  }
  if (typeof r.lastLatencyMs === 'number' && Number.isFinite(r.lastLatencyMs) && r.lastLatencyMs >= 0) {
    clean.lastLatencyMs = r.lastLatencyMs;
  }
  if (typeof r.verifiedStatus === 'string' && ALLOWED_VERIFIED_STATUS.has(r.verifiedStatus as any)) {
    clean.verifiedStatus = r.verifiedStatus as StoredProfile['verifiedStatus'];
  }

  if (r.userDeclaredCapabilities && typeof r.userDeclaredCapabilities === 'object' && !Array.isArray(r.userDeclaredCapabilities)) {
    const udcRaw = r.userDeclaredCapabilities as Record<string, unknown>;
    const udc: Partial<ModelCapability> = {};
    if (typeof udcRaw.vision === 'boolean') udc.vision = udcRaw.vision;
    if (typeof udcRaw.contextWindow === 'number' && Number.isFinite(udcRaw.contextWindow) && udcRaw.contextWindow > 0) {
      udc.contextWindow = Math.floor(udcRaw.contextWindow);
    }
    if (Array.isArray(udcRaw.taskCompatibility)) {
      const tasks = udcRaw.taskCompatibility.filter(
        (t): t is 'DOM' | 'Vision' | 'Reasoning' => typeof t === 'string' && ALLOWED_TASKS.has(t as any)
      );
      if (tasks.length > 0) udc.taskCompatibility = tasks;
    }
    if (typeof udcRaw.description === 'string' && udcRaw.description.trim()) {
      udc.description = udcRaw.description.trim().slice(0, 120);
    }
    if (Object.keys(udc).length > 0) {
      clean.userDeclaredCapabilities = udc;
    }
  }

  // Strictly whitelist StoredProfile.metadata — NEVER retain `isTrustedLiveApi`, `provenance`, or arbitrary keys
  if (r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)) {
    const mRaw = r.metadata as Record<string, unknown>;
    const meta: NonNullable<StoredProfile['metadata']> = {};
    if (typeof mRaw.supportsVision === 'boolean') meta.supportsVision = mRaw.supportsVision;
    if (typeof mRaw.inputTokenLimit === 'number' && Number.isFinite(mRaw.inputTokenLimit) && mRaw.inputTokenLimit > 0) {
      meta.inputTokenLimit = Math.floor(mRaw.inputTokenLimit);
    }
    if (typeof mRaw.description === 'string' && mRaw.description.trim()) {
      meta.description = mRaw.description.trim().slice(0, 120);
    }
    if (Object.keys(meta).length > 0) {
      clean.metadata = meta;
    }
  }

  return clean;
}

export async function readProfilesDb(customPath?: string): Promise<ModelProfilesDb> {
  try {
    const raw = await readFile(getDbPath(customPath), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawProfiles = (parsed && typeof parsed.profiles === 'object' && parsed.profiles && !Array.isArray(parsed.profiles))
      ? (parsed.profiles as Record<string, unknown>)
      : {};
    const profiles: Record<string, StoredProfile> = {};
    for (const [id, val] of Object.entries(rawProfiles)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
      const cleanProf = sanitizeStoredProfile(val);
      if (cleanProf) {
        profiles[id] = cleanProf;
      }
    }
    const defaultId = typeof parsed?.default === 'string' && profiles[parsed.default]
      ? parsed.default
      : undefined;
    const fallbacks = Array.isArray(parsed?.fallbacks)
      ? parsed.fallbacks.filter((f): f is string => typeof f === 'string' && Boolean(profiles[f]))
      : [];
    return {
      default: defaultId,
      profiles,
      fallbacks
    };
  } catch {
    return { default: undefined, profiles: {}, fallbacks: [] };
  }
}

export async function saveProfilesDb(db: ModelProfilesDb, customPath?: string): Promise<void> {
  const targetPath = getDbPath(customPath);
  const profiles: Record<string, StoredProfile> = {};
  for (const [id, val] of Object.entries(db.profiles || {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
    const cleanProf = sanitizeStoredProfile(val);
    if (cleanProf) profiles[id] = cleanProf;
  }
  const cleanDb: ModelProfilesDb = {
    default: db.default && profiles[db.default] ? db.default : undefined,
    profiles,
    fallbacks: Array.isArray(db.fallbacks) ? db.fallbacks.filter(f => Boolean(profiles[f])) : []
  };
  await mkdir(resolve(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, JSON.stringify(cleanDb, null, 2) + '\n', { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

/** Check if an error qualifies for automatic model fallback */
export function isFallbackEligible(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Auth errors (401/403) and validation errors should NEVER fallback silently
  if (/HTTP (401|403)\b|Unauthorized|Forbidden|invalid.*api.*key|not authorized/i.test(msg)) {
    return false;
  }
  // Transient server and network errors
  return /HTTP (408|409|425|429|500|502|503|504)\b|fetch failed|timeout|timed out|ETIMEDOUT|ECONNRESET|network|rate limit|quota|Provider returned no text/i.test(msg);
}

/** Generates ordered, loop-free list of model profiles to attempt */
export function buildExecutionRoute(
  primaryId: string,
  fallbacks: string[] = [],
  availableProfiles: Record<string, StoredProfile> = {}
): string[] {
  const visited = new Set<string>();
  const route: string[] = [];

  if (primaryId && availableProfiles[primaryId]) {
    visited.add(primaryId);
    route.push(primaryId);
  }

  for (const fId of fallbacks) {
    if (!visited.has(fId) && availableProfiles[fId]) {
      visited.add(fId);
      route.push(fId);
    }
  }

  return route;
}

export type SwitchNotification = (fromProfile: string, toProfile: string, reason: string) => void;

export interface RouteExecutionPlan {
  primary: string;
  fallbacks: string[];
  totalAvailable: number;
}

export function getRoutePlan(db: ModelProfilesDb): RouteExecutionPlan {
  const primary = db.default && db.profiles[db.default] ? db.default : Object.keys(db.profiles)[0] || '';
  const route = buildExecutionRoute(primary, db.fallbacks, db.profiles);
  const fallbacks = route.filter(id => id !== primary);
  return {
    primary,
    fallbacks,
    totalAvailable: route.length
  };
}
