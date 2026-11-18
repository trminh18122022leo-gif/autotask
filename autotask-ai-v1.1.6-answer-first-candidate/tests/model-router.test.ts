import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/model-center/model-router.js';
import type { ModelProfilesDb, StoredProfile } from '../src/model-center/types.js';
import type { ResolvedProvider, PromptInput, ProviderSpec } from '../src/providers.js';

const mockDb: ModelProfilesDb = {
  default: 'p1',
  profiles: {
    p1: {
      provider: 'openai',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    p2: {
      provider: 'openai',
      kind: 'openai-compatible',
      model: 'gpt-3.5-turbo',
      endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    p3: {
      provider: 'anthropic',
      kind: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      endpoint: 'https://api.anthropic.com/v1/messages'
    }
  },
  fallbacks: ['p2', 'p3', 'p1'] // Notice p1 duplicate to test loop prevention
};

const mockResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => {
  const prof = mockDb.profiles[spec.profileId || 'p1'];
  return {
    ...prof,
    profileId: spec.profileId,
    apiKey: 'test-secret-key'
  };
};

test('ModelRouter: isVisionCapable correctly identifies vision vs text-only models', () => {
  const gpt4o: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  };
  const gpt35: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-3.5-turbo',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  };
  const sonnet: StoredProfile = {
    provider: 'anthropic',
    kind: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    endpoint: 'https://api.anthropic.com/v1/messages'
  };

  assert.equal(ModelRouter.isVisionCapable(gpt4o), true, 'gpt-4o must be vision-capable');
  assert.equal(ModelRouter.isVisionCapable(gpt35), false, 'gpt-3.5-turbo must be text-only');
  assert.equal(ModelRouter.isVisionCapable(sonnet), true, 'Claude 3.5 Sonnet must be vision-capable');
});

test('ModelRouter: resolveCandidates resolves candidates from database without duplicates', async () => {
  const plan = await ModelRouter.resolveCandidates({ db: mockDb });
  assert.ok(plan.primary, 'Plan must have a primary candidate');
  assert.ok(plan.candidates.length > 0, 'Plan must have at least 1 candidate');
  assert.equal(plan.primary.profileId, 'p1');

  // Verify no duplicate profileIds in candidates even though fallbacks had p1 duplicated
  const ids = plan.candidates.map(c => c.profileId);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, 'Candidate list must not have cycles or duplicate profiles');
  assert.deepEqual(ids, ['p1', 'p2', 'p3']);
});

test('ModelRouter: resolveCandidates respects requiresVision filter', async () => {
  const visionPlan = await ModelRouter.resolveCandidates({ db: mockDb, requiresVision: true });
  for (const candidate of visionPlan.candidates) {
    assert.equal(candidate.supportsVision, true, `Candidate ${candidate.profileId} (${candidate.model}) must support vision`);
  }
  const visionIds = visionPlan.candidates.map(c => c.profileId);
  assert.deepEqual(visionIds, ['p1', 'p3'], 'Text-only model p2 must be filtered out when vision is required');
});

test('ModelRouter: execute succeeds with primary model on first try', async () => {
  const mockCall = async (provider: ResolvedProvider, req: PromptInput) => {
    return '{"result":"primary_success"}';
  };

  const res = await ModelRouter.execute(
    { system: 'test', text: 'hello' },
    { db: mockDb, resolveFn: mockResolve },
    mockCall
  );

  assert.equal(res.output, '{"result":"primary_success"}');
  assert.equal(res.fallbackCount, 0);
  assert.equal(res.attempts, 1);
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].error, undefined);
});

test('ModelRouter: execute falls back on 429 rate limit or 503 service unavailable', async () => {
  let callCount = 0;
  const switched: { from: string; to: string; reason: string }[] = [];

  const mockCall = async (provider: ResolvedProvider, req: PromptInput) => {
    callCount++;
    if (callCount === 1) {
      throw new Error('HTTP 429 Too Many Requests: quota exceeded');
    }
    return `{"result":"fallback_success_from_${provider.model}"}`;
  };

  const res = await ModelRouter.execute(
    { system: 'test', text: 'hello' },
    {
      db: mockDb,
      resolveFn: mockResolve,
      maxAttemptsPerModel: 1,
      onModelSwitch: (from, to, reason) => {
        switched.push({ from, to, reason });
      }
    },
    mockCall
  );

  assert.ok(res.output.startsWith('{"result":"fallback_success_from_'));
  assert.equal(res.fallbackCount, 1);
  assert.equal(res.attempts, 2);
  assert.equal(switched.length, 1);
  assert.match(switched[0].reason, /429/);
});

test('ModelRouter: execute does NOT fallback on 401 Unauthorized / 403 Forbidden', async () => {
  let callCount = 0;
  const mockCall = async (provider: ResolvedProvider, req: PromptInput) => {
    callCount++;
    throw new Error('HTTP 401 Unauthorized: Invalid API key');
  };

  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hello' },
        { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
        mockCall
      );
    },
    (err: Error) => {
      assert.match(err.message, /401 Unauthorized/);
      return true;
    }
  );

  assert.equal(callCount, 1, 'Should fail immediately without trying fallbacks on auth error');
});

test('ModelRouter: automatically activates vision requirement when imageBase64 is passed', async () => {
  const invokedModels: string[] = [];
  const mockCall = async (provider: ResolvedProvider, req: PromptInput) => {
    invokedModels.push(provider.model);
    return 'ok';
  };

  const res = await ModelRouter.execute(
    { system: 'test', text: 'test with image', imageBase64: 'base64imagedata' },
    { db: mockDb, resolveFn: mockResolve },
    mockCall
  );

  assert.equal(res.output, 'ok');
  assert.equal(invokedModels[0], 'gpt-4o');
});

// PHASE 2 REGRESSION TESTS: Strict Vision Routing
test('CASE V-01: my-vision-model with capability UNKNOWN is NOT chosen for vision', () => {
  const profile: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'my-vision-model',
    endpoint: 'https://api.openai.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(profile), false, 'UNKNOWN model must never assume vision');
});

test('CASE V-02: custom-gpt-4o-unverified is NOT treated as VERIFIED vision', () => {
  const profile: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'custom-gpt-4o-unverified',
    endpoint: 'https://custom.endpoint/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(profile), false, 'Custom unverified model must not be vision-capable');
});

test('CASE V-03: Official model with valid Vision metadata is chosen', () => {
  const gpt4o: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(gpt4o), true);
});

test('CASE V-04: Text-only model is excluded from Vision task', () => {
  const textOnly: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-3.5-turbo',
    endpoint: 'https://api.openai.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(textOnly), false);
});

test('CASE V-05: Primary does not support Vision, fallback is verified Vision -> routes to fallback', async () => {
  const db: ModelProfilesDb = {
    default: 'text_primary',
    profiles: {
      text_primary: {
        provider: 'openai',
        kind: 'openai-compatible',
        model: 'gpt-3.5-turbo',
        endpoint: 'https://api.openai.com/v1'
      },
      vision_fallback: {
        provider: 'anthropic',
        kind: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        endpoint: 'https://api.anthropic.com/v1'
      }
    },
    fallbacks: ['vision_fallback']
  };

  const plan = await ModelRouter.resolveCandidates({ db, requiresVision: true });
  assert.equal(plan.primary.profileId, 'vision_fallback', 'Should route to vision fallback when primary lacks vision');
  assert.equal(plan.candidates.length, 1);
});

test('CASE V-06: All models UNKNOWN -> do not run Vision task, throw descriptive error', async () => {
  const db: ModelProfilesDb = {
    default: 'unknown_model',
    profiles: {
      unknown_model: {
        provider: 'custom',
        kind: 'openai-compatible',
        model: 'unknown-model-xyz',
        endpoint: 'https://custom.api/v1'
      }
    },
    fallbacks: []
  };

  await assert.rejects(
    async () => {
      await ModelRouter.resolveCandidates({ db, requiresVision: true });
    },
    (err: Error) => {
      assert.match(err.message, /Tác vụ yêu cầu xử lý hình ảnh \(Vision\)/);
      return true;
    }
  );
});

test('CASE V-07: Custom model with user-declared capability is supported with accurate provenance', () => {
  const declaredVision: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'private-internal-llm',
    endpoint: 'https://internal.lan/v1',
    userDeclaredCapabilities: { vision: true }
  };
  assert.equal(ModelRouter.isVisionCapable(declaredVision), true);

  const declaredTextOnly: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'private-internal-llm',
    endpoint: 'https://internal.lan/v1',
    userDeclaredCapabilities: { vision: false }
  };
  assert.equal(ModelRouter.isVisionCapable(declaredTextOnly), false);
});

// PHASE 3 REGRESSION TESTS: Safe Error Propagation & Redaction
test('CASE S-01: HTTP 400 with fake secret in Error -> thrown error is scrubbed', async () => {
  const FAKE_SECRET = 'sk-proj-superfakekey9876543210abcdefghijklmnop';
  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hi' },
        { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
        async () => {
          const err = new Error(`HTTP 400 Bad Request: API key ${FAKE_SECRET} is invalid`);
          (err as any).status = 400;
          throw err;
        }
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(FAKE_SECRET), 'Error message must not leak fake secret');
      assert.equal(err.status, 400, 'HTTP status must be preserved');
      return true;
    }
  );
});

test('CASE S-02: HTTP 401 with Bearer token -> token not in error, routing history or report', async () => {
  const FAKE_BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitivejwtcontent.signature';
  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hi' },
        { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
        async () => {
          const err = new Error(`HTTP 401 Unauthorized: Bearer ${FAKE_BEARER} expired`);
          (err as any).status = 401;
          throw err;
        }
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(FAKE_BEARER), 'Thrown error must not contain Bearer token');
      return true;
    }
  );
});

test('CASE S-03: HTTP 429 triggers fallback and Error contains API key -> fallback works, history redacted', async () => {
  let attempts = 0;
  const FAKE_KEY = 'sk-ant-api03-secretkeyforanthropic123456789';
  const res = await ModelRouter.execute(
    { system: 'test', text: 'hi' },
    { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
    async (provider) => {
      attempts++;
      if (attempts === 1) {
        throw new Error(`HTTP 429 Rate limit: quota exceeded for key ${FAKE_KEY}`);
      }
      return 'fallback_ok';
    }
  );

  assert.equal(res.output, 'fallback_ok');
  assert.equal(res.history.length, 2);
  assert.ok(!res.history[0].error?.includes(FAKE_KEY), 'History error must redact API key');
});

test('CASE S-04: Nested Error cause contains Basic Auth -> Basic Auth is redacted', async () => {
  const BASIC_SECRET = 'Basic YWRtaW46c3VwZXJzZWNyZXRwYXNzd29yZA==';
  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hi' },
        { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
        async () => {
          const root = new Error('HTTP 403 Forbidden');
          (root as any).status = 403;
          (root as any).cause = new Error(`Connection failed with Authorization: ${BASIC_SECRET}`);
          throw root;
        }
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(BASIC_SECRET));
      if (err.cause) {
        assert.ok(!err.cause.message.includes(BASIC_SECRET), 'Nested cause must not leak Basic Auth');
      }
      return true;
    }
  );
});

test('CASE S-05: All models fail -> final error message useful but sanitized without secrets', async () => {
  const SECRET_ON_FAIL = 'AIzaSyFakeGoogleApiKey1234567890abcdef';
  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hi' },
        { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
        async () => {
          throw new Error(`HTTP 500 Server error with key ${SECRET_ON_FAIL}`);
        }
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(SECRET_ON_FAIL), 'Final error must not leak key');
      assert.match(err.message, /Toàn bộ \d+ lần gọi/);
      return true;
    }
  );
});

// AUDIT-03 & AUDIT-04 SPECIFIC REGRESSION TESTS
test('CASE PV-01: Custom provider named gpt-4o without vendor metadata is UNKNOWN and NOT vision capable', () => {
  const customGpt4o: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://proxy.example.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(customGpt4o), false, 'Custom gpt-4o must not inherit OpenAI vision capability');
});

test('CASE PV-02: Custom provider named claude-3-5-sonnet is UNKNOWN and NOT vision capable', () => {
  const customClaude: StoredProfile = {
    provider: 'custom',
    kind: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    endpoint: 'https://proxy.example.com/v1'
  };
  assert.equal(ModelRouter.isVisionCapable(customClaude), false, 'Custom Claude must not inherit Anthropic vision capability');
});

test('CASE PV-03: Official OpenAI provider with gpt-4o is VERIFIED vision capable', () => {
  const officialGpt4o: StoredProfile = {
    provider: 'openai',
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  };
  assert.equal(ModelRouter.isVisionCapable(officialGpt4o), true, 'Official OpenAI gpt-4o must be VERIFIED vision capable');
});

test('CASE PV-04: Custom model with userDeclaredCapabilities vision: true is accepted', () => {
  const declared: StoredProfile = {
    provider: 'custom',
    kind: 'openai-compatible',
    model: 'custom-gpt-4o-with-user-declaration',
    endpoint: 'https://proxy.example.com/v1',
    userDeclaredCapabilities: { vision: true }
  };
  assert.equal(ModelRouter.isVisionCapable(declared), true);
});

test('CASE PE-01: Provider initialization failure during resolveCandidate wraps and redacts secret tokens', async () => {
  const LEAKED_INIT_SECRET = 'sk-proj-init-secret-token-must-be-redacted-12345';
  const failingResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => {
    throw new Error(`Provider connection failed with Bearer ${LEAKED_INIT_SECRET} during handshake`);
  };

  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'test init error' },
        { db: mockDb, resolveFn: failingResolve, maxAttemptsPerModel: 1 },
        async () => 'never_called'
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(LEAKED_INIT_SECRET), 'Error message must not leak init secret');
      assert.match(err.message, /\[REDACTED/);
      return true;
    }
  );
});

test('CASE PE-02: Credential resolution error with password is fully sanitized', async () => {
  const LEAKED_PW = 'p@ssw0rdSuperSecret!';
  const failingResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => {
    throw new Error(`Vault retrieval error: password=${LEAKED_PW} was rejected`);
  };

  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'test credential error' },
        { db: mockDb, resolveFn: failingResolve, maxAttemptsPerModel: 1 },
        async () => 'never_called'
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(LEAKED_PW), 'Credential error must not leak password');
      return true;
    }
  );
});
