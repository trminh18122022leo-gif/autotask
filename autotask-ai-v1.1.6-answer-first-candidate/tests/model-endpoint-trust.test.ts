/** Model Endpoint Trust & Provenance Regression Tests (Phase 1: EP-01 to EP-08)
 * Verifies strict provider-scoped capability resolution, official endpoint whitelisting,
 * prevention of capability cross-contamination, and protection against unauthorized image transmission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/model-center/model-router.js';
import { resolveModelCapabilities, isOfficialEndpoint } from '../src/model-center/catalog.js';
import type { ModelProfilesDb, StoredProfile } from '../src/model-center/types.js';
import type { ProviderSpec, ResolvedProvider } from '../src/providers.js';

test('EP-01: Official OpenAI model + official endpoint + valid metadata -> Vision supported', () => {
  const officialGpt4o: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  };

  assert.equal(isOfficialEndpoint(officialGpt4o.provider, officialGpt4o.endpoint), true);
  const resolved = resolveModelCapabilities(officialGpt4o.model, undefined, officialGpt4o.provider, officialGpt4o.endpoint);
  assert.equal(resolved.capabilitySource, 'VERIFIED');
  assert.equal(resolved.capabilities.vision, true);
  assert.equal(ModelRouter.isVisionCapable(officialGpt4o), true);
});

test('EP-02: OpenAI profile + custom endpoint + gpt-4o -> NOT automatically VERIFIED (rejected for vision)', () => {
  const customProxyGpt4o: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://proxy.untrusted.example/v1'
  };

  assert.equal(isOfficialEndpoint(customProxyGpt4o.provider, customProxyGpt4o.endpoint), false);
  const resolved = resolveModelCapabilities(customProxyGpt4o.model, undefined, customProxyGpt4o.provider, customProxyGpt4o.endpoint);
  assert.notEqual(resolved.capabilitySource, 'VERIFIED', 'Custom proxy must not receive VERIFIED capability');
  assert.equal(ModelRouter.isVisionCapable(customProxyGpt4o), false, 'Custom proxy must not be granted vision without explicit declaration');
});

test('EP-03: Custom profile + metadata.supportsVision=true from profile JSON -> USER_DECLARED, NOT PROVIDER_REPORTED', () => {
  const customProfile: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'internal-llm',
    endpoint: 'https://internal.lan/v1',
    metadata: {
      supportsVision: true,
      inputTokenLimit: 64000
    }
  };

  const resolved = resolveModelCapabilities(customProfile.model, customProfile.metadata, customProfile.provider, customProfile.endpoint);
  assert.equal(resolved.capabilitySource, 'USER_DECLARED', 'Local profile metadata must be labeled USER_DECLARED, not PROVIDER_REPORTED');
  assert.equal(resolved.capabilities.vision, true);
});

test('EP-04: Two endpoints with identical model ID do NOT cross-contaminate capabilities', () => {
  const officialEndpoint = 'https://api.openai.com/v1/chat/completions';
  const customEndpoint = 'https://private-ai.company.org/v1/chat/completions';

  const officialProfile: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: officialEndpoint
  };

  const privateProfile: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: customEndpoint
  };

  const officialCap = resolveModelCapabilities(officialProfile.model, undefined, officialProfile.provider, officialProfile.endpoint);
  const privateCap = resolveModelCapabilities(privateProfile.model, undefined, privateProfile.provider, privateProfile.endpoint);

  assert.equal(officialCap.capabilitySource, 'VERIFIED');
  assert.equal(privateCap.capabilitySource, 'UNKNOWN', 'Private endpoint must remain UNKNOWN despite gpt-4o name');
  assert.equal(ModelRouter.isVisionCapable(officialProfile), true);
  assert.equal(ModelRouter.isVisionCapable(privateProfile), false);
});

test('EP-05: When endpoint changes from official to custom, capabilities are re-evaluated safely', () => {
  let endpoint = 'https://api.openai.com/v1';
  let cap = resolveModelCapabilities('gpt-4o', undefined, 'openai', endpoint);
  assert.equal(cap.capabilitySource, 'VERIFIED');

  // Change endpoint to private proxy
  endpoint = 'https://my-proxy.com/v1';
  cap = resolveModelCapabilities('gpt-4o', undefined, 'openai', endpoint);
  assert.equal(cap.capabilitySource, 'UNKNOWN', 'Changing endpoint must trigger safe UNKNOWN re-evaluation');
});

test('EP-06: Vision task with unverified primary model routes to verified fallback model', async () => {
  const db: ModelProfilesDb = {
    default: 'proxy_model',
    profiles: {
      proxy_model: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-4o',
        endpoint: 'https://proxy.example.com/v1' // Untrusted endpoint -> isVisionCapable === false
      },
      verified_vision_model: {
        provider: 'anthropic',
        kind: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        endpoint: 'https://api.anthropic.com/v1/messages' // Official endpoint -> isVisionCapable === true
      }
    },
    fallbacks: ['verified_vision_model']
  };

  const plan = await ModelRouter.resolveCandidates({ db, requiresVision: true });
  assert.equal(plan.primary.profileId, 'verified_vision_model', 'Must route to verified official model for Vision');
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].profileId, 'verified_vision_model');
});

test('EP-07: Custom proxy without verified provenance remains UNKNOWN', () => {
  const proxy: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'proxy-claude-3',
    endpoint: 'https://proxy.mycorp.internal/v1'
  };

  const resolved = resolveModelCapabilities(proxy.model, undefined, proxy.provider, proxy.endpoint);
  assert.equal(resolved.capabilitySource, 'UNKNOWN');
  assert.equal(resolved.capabilities.vision, false);
});

test('EP-08: Untrusted endpoint refuses silent image transmission without userDeclaredCapabilities', async () => {
  const untrustedDb: ModelProfilesDb = {
    default: 'untrusted_endpoint_prof',
    profiles: {
      untrusted_endpoint_prof: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-4o',
        endpoint: 'https://attacker-controlled-proxy.org/v1'
      }
    },
    fallbacks: []
  };

  // Attempting to route a Vision request to this untrusted endpoint must reject
  await assert.rejects(
    async () => {
      await ModelRouter.resolveCandidates({ db: untrustedDb, requiresVision: true });
    },
    (err: Error) => {
      assert.match(err.message, /Tác vụ yêu cầu xử lý hình ảnh \(Vision\)/);
      return true;
    }
  );
});

// Phase 1: Explicit TRUST-01 to TRUST-10 Tests
test('TRUST-01: Official HTTPS endpoint -> accepted', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1'), true);
  assert.equal(isOfficialEndpoint('anthropic', 'https://api.anthropic.com/v1'), true);
  assert.equal(isOfficialEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta'), true);
  assert.equal(isOfficialEndpoint('groq', 'https://api.groq.com/openai/v1'), true);
});

test('TRUST-02: HTTP endpoint -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'http://api.openai.com/v1'), false);
  assert.equal(isOfficialEndpoint('anthropic', 'http://api.anthropic.com/v1'), false);
  assert.equal(isOfficialEndpoint('gemini', 'http://generativelanguage.googleapis.com/v1beta'), false);
});

test('TRUST-03: Custom port 444 -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com:444/v1'), false);
  assert.equal(isOfficialEndpoint('anthropic', 'https://api.anthropic.com:8443/v1'), false);
});

test('TRUST-04: Username/password embedded in URL -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://test:password@api.openai.com/v1'), false);
  assert.equal(isOfficialEndpoint('anthropic', 'https://admin:token123@api.anthropic.com/v1'), false);
});

test('TRUST-05: Hostname có suffix giả mạo -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com.attacker.com/v1'), false);
  assert.equal(isOfficialEndpoint('openai', 'https://evil-api.openai.com/v1'), false);
  assert.equal(isOfficialEndpoint('gemini', 'https://generativelanguage.googleapis.com.fake.io/v1'), false);
});

test('TRUST-06: Provider Custom dùng official model name -> không tự nhận VERIFIED', () => {
  const custom = resolveModelCapabilities('gpt-4o', undefined, 'custom', 'https://my-proxy.com/v1');
  assert.notEqual(custom.capabilitySource, 'VERIFIED');
  assert.equal(custom.capabilitySource, 'UNKNOWN');
});

test('TRUST-07: Query chứa credential -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?api_key=secret123'), false);
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?token=xyz'), false);
  assert.equal(isOfficialEndpoint('anthropic', 'https://api.anthropic.com/v1?auth=secret'), false);
});

test('TRUST-08: Safe endpoint rejects non-standard ports and credentials', async () => {
  const { safeEndpoint } = await import('../src/providers.js');
  assert.throws(() => safeEndpoint('http://api.openai.com/v1'));
  assert.throws(() => safeEndpoint('https://api.openai.com:8080/v1'));
  assert.throws(() => safeEndpoint('https://user:pass@api.openai.com/v1'));
});

test('TRUST-09: HTTPS port mặc định 443 hợp lệ -> accepted', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com:443/v1'), true);
  assert.equal(isOfficialEndpoint('anthropic', 'https://api.anthropic.com:443/v1'), true);
});

test('TRUST-10: Provider endpoint có path/version hợp lệ -> accepted, path lạ -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1/chat/completions'), true);
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/unsupported/random/path'), false);
});

// Phase 2: Explicit PROV-01 to PROV-08 Tests
test('PROV-01: Custom metadata giả PROVIDER_REPORTED -> không được tin (bị ép về USER_DECLARED)', () => {
  const cap = resolveModelCapabilities(
    'gpt-4o',
    { supportsVision: true, provenance: 'PROVIDER_REPORTED' as any },
    'custom',
    'https://host.example/v1'
  );
  assert.equal(cap.capabilitySource, 'USER_DECLARED');
  assert.notEqual(cap.capabilitySource, 'PROVIDER_REPORTED');
});

test('PROV-02: USER_DECLARED -> hiển thị USER_DECLARED', () => {
  const cap = resolveModelCapabilities(
    'custom-llm',
    { supportsVision: true, provenance: 'USER_DECLARED' },
    'custom',
    'https://custom.internal/v1'
  );
  assert.equal(cap.capabilitySource, 'USER_DECLARED');
});

test('PROV-03: Official source hợp lệ -> đúng provenance VERIFIED', () => {
  const cap = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://api.openai.com/v1');
  assert.equal(cap.capabilitySource, 'VERIFIED');
});

test('PROV-04: Endpoint đổi -> không dùng metadata cũ', () => {
  const official = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://api.openai.com/v1');
  const proxy = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://untrusted-proxy.com/v1');
  assert.equal(official.capabilitySource, 'VERIFIED');
  assert.equal(proxy.capabilitySource, 'UNKNOWN');
});

test('PROV-05: Hai provider cùng model ID -> tách biệt capability', () => {
  const openaiGpt = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://api.openai.com/v1');
  const customGpt = resolveModelCapabilities('gpt-4o', undefined, 'custom', 'https://custom-gateway.io/v1');
  assert.equal(openaiGpt.capabilitySource, 'VERIFIED');
  assert.equal(customGpt.capabilitySource, 'UNKNOWN');
});

test('PROV-06: UNKNOWN Vision -> từ chối auto-routing', () => {
  const profile: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'mystery-model',
    endpoint: 'https://gateway.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(profile), false);
});

test('PROV-07: Model fallback có Vision chính thức -> chọn đúng khi được phép', async () => {
  const db: ModelProfilesDb = {
    default: 'p_text',
    profiles: {
      p_text: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-3.5-turbo',
        endpoint: 'https://api.openai.com/v1'
      },
      p_vision: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-4o',
        endpoint: 'https://api.openai.com/v1'
      }
    },
    fallbacks: ['p_vision']
  };

  const plan = await ModelRouter.resolveCandidates({ db, requiresVision: true });
  assert.equal(plan.primary.profileId, 'p_vision');
});

test('PROV-08: UI Model Details và Router hiển thị cùng nguồn capability', () => {
  const prof: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1'
  };
  const cap = resolveModelCapabilities(prof.model, prof.metadata, prof.provider, prof.endpoint);
  const routerVision = ModelRouter.isVisionCapable(prof);
  assert.equal(cap.capabilitySource, 'VERIFIED');
  assert.equal(routerVision, true);
});

// Phase 1 (v1.1.6): Explicit CAP-01 to CAP-10 Tests
test('CAP-01: Official endpoint + unknown model + user-supplied PROVIDER_REPORTED -> strictly USER_DECLARED', () => {
  const cap = resolveModelCapabilities(
    'invented-model-xyz',
    { supportsVision: true, provenance: 'PROVIDER_REPORTED' as any },
    'openai',
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(cap.capabilitySource, 'USER_DECLARED');
  assert.notEqual(cap.capabilitySource, 'PROVIDER_REPORTED');
  assert.equal(cap.capabilities.vision, true);
});

test('CAP-02: User-supplied supportsVision=true -> USER_DECLARED', () => {
  const cap = resolveModelCapabilities('custom-finetune', { supportsVision: true }, 'custom');
  assert.equal(cap.capabilitySource, 'USER_DECLARED');
  assert.equal(cap.capabilities.vision, true);
});

test('CAP-03: Official provider API metadata with isTrustedLiveApi=true -> PROVIDER_REPORTED', () => {
  const cap = resolveModelCapabilities(
    'vendor-reported-model-2026',
    { supportsVision: true, inputTokenLimit: 128000, isTrustedLiveApi: true },
    'anthropic',
    'https://api.anthropic.com/v1/models'
  );
  assert.equal(cap.capabilitySource, 'PROVIDER_REPORTED');
  assert.equal(cap.capabilities.vision, true);
  assert.equal(cap.capabilities.contextWindow, 128000);
});

test('CAP-04: Internal verified catalog exact-match -> VERIFIED', () => {
  const cap = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://api.openai.com/v1/chat/completions');
  assert.equal(cap.capabilitySource, 'VERIFIED');
  assert.equal(cap.capabilities.vision, true);
});

test('CAP-05: Model ID không có trong catalog -> không tự VERIFIED', () => {
  const cap = resolveModelCapabilities('non-existent-gpt-model', undefined, 'openai', 'https://api.openai.com/v1/chat/completions');
  assert.notEqual(cap.capabilitySource, 'VERIFIED');
  assert.equal(cap.capabilitySource, 'UNKNOWN');
});

test('CAP-06: Custom endpoint mượn tên model chính thức -> UNKNOWN nếu không khai báo capability', () => {
  const cap = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://attacker.lan/v1');
  assert.equal(cap.capabilitySource, 'UNKNOWN');
  assert.equal(cap.capabilities.vision, false);
});

test('CAP-07: Endpoint thay đổi -> invalidate metadata phù hợp', () => {
  const official = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://api.openai.com/v1/chat/completions');
  assert.equal(official.capabilitySource, 'VERIFIED');
  const switched = resolveModelCapabilities('gpt-4o', undefined, 'openai', 'https://custom-proxy.internal/v1');
  assert.equal(switched.capabilitySource, 'UNKNOWN');
});

test('CAP-08: UI Model Details và Model Router sử dụng cùng nguồn capability', () => {
  const profile: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'unverified-custom-model',
    endpoint: 'https://api.openai.com/v1',
    metadata: {
      supportsVision: true
    }
  };
  const cap = resolveModelCapabilities(profile.model, profile.metadata, profile.provider, profile.endpoint);
  assert.equal(cap.capabilitySource, 'USER_DECLARED');
  // Since unverified custom model is USER_DECLARED (without userDeclaredCapabilities.vision), ModelRouter refuses auto-vision
  assert.equal(ModelRouter.isVisionCapable(profile), false);
});

test('CAP-09: Fallback Vision chỉ chọn model đủ điều kiện và được phép chuyển dữ liệu', async () => {
  const db: ModelProfilesDb = {
    default: 'p_unverified',
    profiles: {
      p_unverified: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'unknown-model',
        endpoint: 'https://api.openai.com/v1',
        metadata: { supportsVision: true }
      },
      p_verified: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-4o',
        endpoint: 'https://api.openai.com/v1'
      }
    },
    fallbacks: ['p_verified']
  };
  const plan = await ModelRouter.resolveCandidates({ db, requiresVision: true });
  assert.equal(plan.primary.profileId, 'p_verified', 'Must bypass unverified model and route directly to verified Vision model');
});

test('CAP-10: Caller truyền metadata giả mạo ở official endpoint -> không thể nâng trust level', () => {
  const spoofed = resolveModelCapabilities(
    'random-fake-model',
    { supportsVision: true, provenance: 'VERIFIED' as any },
    'openai',
    'https://api.openai.com/v1'
  );
  assert.equal(spoofed.capabilitySource, 'USER_DECLARED', 'Spoofed VERIFIED must be forced to USER_DECLARED');
});

// Phase 2 (v1.1.6): Explicit URL-01 to URL-10 Tests
test('URL-01: authorization= query parameter -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?authorization=AUDIT_TOKEN_742'), false);
});

test('URL-02: session_id= query parameter -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?session_id=AUDIT_TOKEN_742'), false);
});

test('URL-03: access_token= query parameter -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?access_token=secret_abc123'), false);
});

test('URL-04: api_key= query parameter -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?api_key=secret_xyz789'), false);
});

test('URL-05: Uppercase/mixed-case credential parameters -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?AUTHORIZATION=secret_val'), false);
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?Session_Id=secret_val'), false);
});

test('URL-06: URL-encoded parameter names -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?%61uthorization=secret_val'), false);
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?%73ession_id=secret_val'), false);
});

test('URL-07: Repeated query parameters, một tham số chứa secret -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1?model=gpt-4o&session_id=secret_val'), false);
});

test('URL-08: Credential trong fragment -> rejected', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1#access_token=secret_val'), false);
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1#session_id=secret_val'), false);
});

test('URL-09: Canonical HTTPS endpoint không chứa secret -> accepted', () => {
  assert.equal(isOfficialEndpoint('openai', 'https://api.openai.com/v1/chat/completions'), true);
  assert.equal(isOfficialEndpoint('anthropic', 'https://api.anthropic.com/v1/messages'), true);
  assert.equal(isOfficialEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta/models'), true);
  assert.equal(isOfficialEndpoint('groq', 'https://api.groq.com/openai/v1/chat/completions'), true);
  assert.equal(isOfficialEndpoint('deepseek', 'https://api.deepseek.com/v1/chat/completions'), true);
});

test('URL-10: URL lỗi chứa fake secret -> log/exception không làm lộ secret', async () => {
  const { redactSecrets } = await import('../src/security/redact.js');
  const dangerousUrl = 'https://api.openai.com/v1?authorization=sk-proj-super-secret-key-12345';
  const isOff = isOfficialEndpoint('openai', dangerousUrl);
  assert.equal(isOff, false);
  const redacted = redactSecrets(dangerousUrl);
  assert.ok(!redacted.includes('sk-proj-super-secret-key-12345'));
  assert.ok(redacted.includes('sk-proj-[REDACTED]'));
});

