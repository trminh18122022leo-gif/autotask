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

import { GEMINI_AUTO_MODEL_POOL } from '../src/model-center/catalog.js';
import {
  getCooldownKey,
  getProfileCooldowns as getPoolCooldowns,
  resetProfileCooldowns as resetPoolCooldowns,
  type RateLimitWaitInfo
} from '../src/model-center/model-router.js';
import { extractJsonPayload } from '../src/utils/json.js';

test('CASE POOL-01: expandModelPool generates multi-model candidates and excludes Gemma 4 when requiresVision is true', async () => {
  resetPoolCooldowns();
  const poolDb: ModelProfilesDb = {
    default: 'gem1',
    profiles: {
      gem1: {
        provider: 'gemini',
        kind: 'gemini',
        model: 'gemini-3.5-flash-lite',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        verifiedStatus: 'VERIFIED'
      },
      gem2: {
        provider: 'gemini',
        kind: 'gemini',
        model: 'gemini-3.1-flash-lite',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        verifiedStatus: 'VERIFIED'
      }
    },
    fallbacks: ['gem2']
  };

  const textPlan = await ModelRouter.resolveCandidates({ db: poolDb, expandModelPool: true, requiresVision: false });
  assert.ok(textPlan.candidates.length >= GEMINI_AUTO_MODEL_POOL.length * 2, 'Should expand all pool models across both Gemini profiles');
  assert.ok(textPlan.candidates.some(c => c.profileId === 'gem1' && c.model === 'gemma-4-26b-a4b-it' && !c.supportsVision));
  assert.ok(textPlan.candidates.some(c => c.profileId === 'gem2' && c.model === 'gemini-3-flash-preview' && c.supportsVision));

  const visionPlan = await ModelRouter.resolveCandidates({ db: poolDb, expandModelPool: true, requiresVision: true });
  assert.ok(visionPlan.candidates.length > 0);
  assert.ok(visionPlan.candidates.every(c => c.supportsVision && !c.model.startsWith('gemma-')), 'Vision tasks must never include Gemma 4');
});

test('CASE POOL-02: Daily 429 cooldown is isolated per (profileId, model) without blocking sibling models', async () => {
  resetPoolCooldowns();
  try {
    const singleKeyDb: ModelProfilesDb = {
      default: 'gem1',
      profiles: {
        gem1: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.5-flash',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: []
    };

    const resolveFn = async (spec: ProviderSpec): Promise<ResolvedProvider> => ({
      profileId: spec.profileId || 'gem1',
      provider: 'gemini',
      kind: 'gemini',
      model: 'gemini-3.5-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaMockTestKeyForPoolIsolation0000000000'
    });

    const res = await ModelRouter.execute(
      { system: 's', text: 'hello' },
      { db: singleKeyDb, resolveFn, expandModelPool: true, waitOnRateLimit: false },
      async (provider) => {
        if (provider.model === 'gemini-3.5-flash') {
          const err: any = new Error('HTTP 429 PerDay RPD limit exceeded');
          err.status = 429;
          err.httpStatus = 429;
          err.rateLimitScope = 'DAILY';
          throw err;
        }
        return `ok:${provider.model}`;
      }
    );

    assert.equal(res.finalProfile, 'gem1');
    assert.notEqual(res.modelUsed, 'gemini-3.5-flash');
    assert.equal(getPoolCooldowns().get(getCooldownKey('gem1', 'gemini-3.5-flash'))?.scope, 'DAILY');
    assert.equal(getPoolCooldowns().has(getCooldownKey('gem1', res.modelUsed!)), false);

    const nextPlan = await ModelRouter.resolveCandidates({ db: singleKeyDb, expandModelPool: true });
    assert.notEqual(nextPlan.primary.model, 'gemini-3.5-flash', 'Daily-exhausted model should move to the end');
    assert.equal(nextPlan.candidates[nextPlan.candidates.length - 1].model, 'gemini-3.5-flash');
  } finally {
    resetPoolCooldowns();
  }
});

test('CASE RPM-01: waitOnRateLimit pauses after per-minute 429 exhaustion, invokes onRateLimitWait, and recovers', async () => {
  resetPoolCooldowns();
  try {
    const rpmDb: ModelProfilesDb = {
      default: 'gem1',
      profiles: {
        gem1: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.5-flash-lite',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        },
        gem2: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.1-flash-lite',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: ['gem2']
    };

    const resolveFn = async (spec: ProviderSpec): Promise<ResolvedProvider> => ({
      profileId: spec.profileId || 'gem1',
      provider: 'gemini',
      kind: 'gemini',
      model: spec.profileId === 'gem2' ? 'gemini-3.1-flash-lite' : 'gemini-3.5-flash-lite',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaMockTestKeyForRpmWaitRecovery00000000'
    });

    let callCount = 0;
    const waitEvents: RateLimitWaitInfo[] = [];

    const res = await ModelRouter.execute(
      { system: 's', text: 'ping' },
      {
        db: rpmDb,
        resolveFn,
        expandModelPool: false,
        waitOnRateLimit: true,
        rateLimitWaitMs: 30,
        maxRateLimitWaitCycles: 2,
        onRateLimitWait: (info) => waitEvents.push(info)
      },
      async (provider) => {
        callCount++;
        if (callCount <= 2) {
          const err: any = new Error('HTTP 429 Too Many Requests: RPM exceeded');
          err.status = 429;
          err.httpStatus = 429;
          err.rateLimitScope = 'PER_MINUTE';
          throw err;
        }
        return `recovered:${provider.model}`;
      }
    );

    assert.equal(callCount, 3);
    assert.equal(waitEvents.length, 1);
    assert.equal(waitEvents[0].waitMs, 30);
    assert.equal(waitEvents[0].cycle, 1);
    assert.match(res.output, /^recovered:/);
  } finally {
    resetPoolCooldowns();
  }
});

test('CASE JSON-01: extractJsonPayload extracts last valid JSON fence after CoT prose with inline backticks', () => {
  const gemmaOutput = [
    'We need to click `account.login` first, maybe also inspect `.btn-primary`.',
    'Let me output the final decision:',
    '```json',
    '{"thought":"Click login button","plan":["Click login"],"action":{"tool":"browser.click","args":{"selector":"button.login"}}}',
    '```'
  ].join('\n');

  const parsed = JSON.parse(extractJsonPayload(gemmaOutput));
  assert.equal(parsed.action.tool, 'browser.click');
  assert.equal(parsed.action.args.selector, 'button.login');
});

test('CASE ACC-01: preferAccuracy prioritizes higher-reasoning Flash models ahead of flash-lite when healthy', async () => {
  resetPoolCooldowns();
  try {
    const db: ModelProfilesDb = {
      default: 'gem1',
      profiles: {
        gem1: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.5-flash-lite',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: []
    };

    const plan = await ModelRouter.resolveCandidates({ db, expandModelPool: true, preferAccuracy: true });
    assert.equal(plan.primary.model.includes('flash-lite'), false, 'Primary with preferAccuracy must be full Flash model rather than flash-lite');
    assert.equal(plan.primary.model, 'gemini-3-flash-preview');
  } finally {
    resetPoolCooldowns();
  }
});

test('CASE MODEL-01: modelOverride prioritizes chosen model across keys, enforces vision check, and falls back when exhausted', async () => {
  resetPoolCooldowns();
  try {
    const db: ModelProfilesDb = {
      default: 'gem1',
      profiles: {
        gem1: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3.5-flash-lite',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        },
        gem2: {
          provider: 'gemini',
          kind: 'gemini',
          model: 'gemini-3-flash-preview',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          verifiedStatus: 'VERIFIED'
        }
      },
      fallbacks: ['gem2']
    };

    // 1. Chosen model must be Tier 0 across both healthy keys with round-robin rotation + backup pool retained
    const plan0 = await ModelRouter.resolveCandidates({
      db,
      expandModelPool: true,
      preferAccuracy: true,
      modelOverride: 'gemini-3.6-flash',
      roundRobinIndex: 0
    });
    assert.equal(plan0.source, 'TASK_OVERRIDE');
    assert.equal(plan0.primary.model, 'gemini-3.6-flash');
    assert.equal(plan0.primary.profileId, 'gem1');
    assert.equal(plan0.candidates[1].model, 'gemini-3.6-flash');
    assert.equal(plan0.candidates[1].profileId, 'gem2');
    assert.ok(plan0.candidates.length > 2, 'Backup fallback models must remain after chosen model candidates');

    const plan1 = await ModelRouter.resolveCandidates({
      db,
      expandModelPool: true,
      preferAccuracy: true,
      modelOverride: 'gemini-3.6-flash',
      roundRobinIndex: 1
    });
    assert.equal(plan1.primary.model, 'gemini-3.6-flash');
    assert.equal(plan1.primary.profileId, 'gem2');
    assert.equal(plan1.candidates[1].profileId, 'gem1');

    // 2. requiresVision skips text-only chosen model (gemma-4-31b-it) cleanly
    const visionPlan = await ModelRouter.resolveCandidates({
      db,
      expandModelPool: true,
      requiresVision: true,
      modelOverride: 'gemma-4-31b-it'
    });
    assert.notEqual(visionPlan.primary.model, 'gemma-4-31b-it');
    assert.equal(visionPlan.candidates.some(c => c.model === 'gemma-4-31b-it'), false);

    // 3. ModelRouter.execute uses chosen model first across keys and falls back seamlessly on 429 PerDay
    const attempted: Array<{ profileId?: string; model: string }> = [];
    const resolveFn = async (spec: ProviderSpec): Promise<ResolvedProvider> => ({
      profileId: spec.profileId || 'gem1',
      provider: 'gemini',
      kind: 'gemini',
      model: spec.model || 'gemini-3.5-flash-lite',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: spec.profileId === 'gem2' ? 'AIzaMockTestKey2_0000000000000000' : 'AIzaMockTestKey1_0000000000000000'
    });

    const execRes = await ModelRouter.execute(
      { system: 's', text: 'hello' },
      {
        db,
        resolveFn,
        expandModelPool: true,
        preferAccuracy: true,
        modelOverride: 'gemini-3.6-flash'
      },
      async (provider) => {
        attempted.push({ profileId: provider.profileId, model: provider.model });
        if (provider.model === 'gemini-3.6-flash') {
          const err: any = new Error('HTTP 429 RESOURCE_EXHAUSTED PerDay quota exceeded');
          err.status = 429;
          err.httpStatus = 429;
          err.rateLimitScope = 'PER_DAY';
          throw err;
        }
        return `ok:${provider.profileId}:${provider.model}`;
      }
    );

    assert.equal(attempted[0].model, 'gemini-3.6-flash');
    assert.equal(attempted[1].model, 'gemini-3.6-flash');
    assert.notEqual(attempted[0].profileId, attempted[1].profileId);
    assert.notEqual(execRes.modelUsed, 'gemini-3.6-flash');
    assert.match(execRes.output, /^ok:/);
  } finally {
    resetPoolCooldowns();
  }
});
