/** Types for Model Center and AI Provider Management. */

export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'groq' | 'custom';
export type ProviderKind = 'openai-compatible' | 'gemini' | 'anthropic';

export interface ModelCapability {
  vision: boolean;
  contextWindow: number;
  taskCompatibility: ('DOM' | 'Vision' | 'Reasoning')[];
  description?: string;
}

export type CapabilitySource = 'VERIFIED' | 'PROVIDER_REPORTED' | 'USER_DECLARED' | 'INFERRED' | 'UNKNOWN';

export interface ModelItem {
  id: string;
  provider: ProviderId;
  name?: string;
  capabilities: ModelCapability;
  isVerified: boolean;
  capabilitySource: CapabilitySource;
}

export interface StoredProfile {
  provider: ProviderId;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  displayName?: string;
  createdAt?: string;
  lastTestedAt?: string;
  lastLatencyMs?: number;
  verifiedStatus?: 'VERIFIED' | 'FAILED' | 'UNTESTED';
  userDeclaredCapabilities?: Partial<ModelCapability>;
  metadata?: {
    supportsVision?: boolean;
    inputTokenLimit?: number;
    description?: string;
  };
}

export interface ModelProfilesDb {
  default?: string;
  profiles: Record<string, StoredProfile>;
  fallbacks?: string[];
}

export type ConnectionErrorCategory =
  | 'AUTH_INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface TestConnectionResult {
  success: boolean;
  latencyMs: number;
  statusCode?: number;
  category?: ConnectionErrorCategory;
  errorMessage?: string;
  suggestion?: string;
  modelUsed: string;
  provider: ProviderId;
}
