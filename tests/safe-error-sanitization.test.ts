/** Complete Error Sanitization & Safe Error Schema Regression Tests (Phase 2: SE-01 to SE-07)
 * Verifies that Error code, statusMessage, name, stack, nested cause, and serialization
 * never leak secret tokens, keys, passwords or arbitrary SDK properties.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, sanitizeProviderError } from '../src/model-center/model-router.js';
import type { ModelProfilesDb } from '../src/model-center/types.js';
import type { ProviderSpec, ResolvedProvider } from '../src/providers.js';

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
      provider: 'anthropic',
      kind: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      endpoint: 'https://api.anthropic.com/v1/messages'
    }
  },
  fallbacks: ['p2']
};

test('SE-01: err.code containing fake API key is sanitized to safe code and never leaked', () => {
  const FAKE_KEY_IN_CODE = 'sk-proj-superfakekeywithcodeleak9876543210';
  const rawErr = new Error('Rate limit exceeded');
  (rawErr as any).code = FAKE_KEY_IN_CODE;

  const sanitized = sanitizeProviderError(rawErr, 'prof-1', 'openai');
  assert.ok(!sanitized.code?.includes(FAKE_KEY_IN_CODE), 'Error code must not leak fake key');
  assert.equal(sanitized.code, 'PROVIDER_ERROR', 'Unknown code with secret pattern must map to safe code');
  assert.equal(sanitized.safeCode, 'PROVIDER_ERROR');
});

test('SE-02: err.statusMessage containing Bearer token is completely sanitized', () => {
  const FAKE_BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fakesignaturedata12345';
  const rawErr = new Error('HTTP 401 Unauthorized');
  (rawErr as any).statusMessage = `Unauthorized with token: Bearer ${FAKE_BEARER}`;

  const sanitized = sanitizeProviderError(rawErr, 'prof-1', 'openai');
  assert.ok(!sanitized.statusMessage?.includes(FAKE_BEARER), 'statusMessage must not leak Bearer token');
  assert.match(sanitized.statusMessage || '', /\[REDACTED_TOKEN\]/);
});

test('SE-03: Nested Error cause containing Basic Auth credentials is fully sanitized', () => {
  const BASIC_SECRET = 'Basic YWRtaW46c3VwZXJzZWNyZXRwYXNzd29yZA==';
  const rootErr = new Error('Network failure');
  (rootErr as any).cause = new Error(`Proxy authentication failed with header ${BASIC_SECRET}`);

  const sanitized = sanitizeProviderError(rootErr, 'prof-1', 'openai');
  assert.ok(sanitized.cause instanceof Error, 'Cause must be wrapped in safe Error instance');
  assert.ok(!sanitized.cause.message.includes(BASIC_SECRET), 'Cause message must not leak Basic Auth');
  assert.match(sanitized.cause.message, /\[REDACTED_CREDENTIAL\]/);
});

test('SE-04: Provider initialization throwing Error with sensitive metadata is safely captured and sanitized', async () => {
  const FAKE_INIT_TOKEN = 'sk-ant-init-failure-secret-9988776655';
  const failingResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => {
    const initErr = new Error(`Connection refused to vault; token=${FAKE_INIT_TOKEN}`);
    (initErr as any).rawToken = FAKE_INIT_TOKEN;
    throw initErr;
  };

  await assert.rejects(
    async () => {
      await ModelRouter.execute(
        { system: 'test', text: 'hi' },
        { db: mockDb, resolveFn: failingResolve, maxAttemptsPerModel: 1 },
        async () => 'never_called'
      );
    },
    (err: any) => {
      assert.ok(!err.message.includes(FAKE_INIT_TOKEN), 'Thrown error must not leak init token');
      assert.equal(err.rawToken, undefined, 'Raw sensitive properties must not be copied over');
      return true;
    }
  );
});

test('SE-05: Model fallback routing history never contains secret material', async () => {
  const LEAKED_KEY = 'sk-proj-primary-key-must-not-appear-in-history';
  let attempts = 0;
  const mockResolve = async (spec: ProviderSpec): Promise<ResolvedProvider> => ({
    provider: spec.profileId === 'p2' ? 'anthropic' : 'openai',
    kind: 'openai-compatible',
    model: spec.profileId === 'p2' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o',
    endpoint: 'https://api.openai.com/v1',
    profileId: spec.profileId,
    apiKey: 'test-key'
  });

  const res = await ModelRouter.execute(
    { system: 'test', text: 'hi' },
    { db: mockDb, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
    async (provider) => {
      attempts++;
      if (attempts === 1) {
        const failErr = new Error(`Rate limit exceeded for key ${LEAKED_KEY}`);
        (failErr as any).status = 429;
        throw failErr;
      }
      return 'fallback_success';
    }
  );

  assert.equal(res.output, 'fallback_success');
  assert.equal(res.history.length, 2);
  // Verify history entry
  const firstHist = res.history[0];
  assert.ok(firstHist.error, 'First history entry must record sanitized error');
  assert.ok(!firstHist.error.includes(LEAKED_KEY), 'History entry must not leak API key');
});

test('SE-06: Error serialization via toJSON() outputs only safe whitelisted fields', () => {
  const rawErr = new Error('HTTP 500 Internal Server Error with key sk-proj-1234567890abcdef');
  (rawErr as any).code = 500;
  (rawErr as any).internalDebugState = { privateToken: 'secret_state_value' };

  const sanitized = sanitizeProviderError(rawErr, 'p1', 'openai');
  assert.ok(typeof sanitized.toJSON === 'function', 'Sanitized error must have toJSON method');
  const serialized = sanitized.toJSON();

  assert.ok(!JSON.stringify(serialized).includes('sk-proj-1234567890abcdef'));
  assert.ok(!JSON.stringify(serialized).includes('secret_state_value'));
  assert.equal(serialized.profileId, 'p1');
  assert.equal(serialized.provider, 'openai');
  assert.equal(serialized.httpStatus, 500);
});

test('SE-07: Arbitrary SDK-added properties on Error are discarded from public error schema', () => {
  const rawErr = new Error('SDK generic error');
  (rawErr as any).clientInternalSession = 'session_cookie_123';
  (rawErr as any).sdkDebugInfo = { ip: '1.2.3.4', headers: { 'x-api-key': 'secret-header-key' } };

  const sanitized = sanitizeProviderError(rawErr, 'p1', 'openai');
  assert.equal((sanitized as any).clientInternalSession, undefined, 'Arbitrary properties must be dropped');
  assert.equal((sanitized as any).sdkDebugInfo, undefined, 'SDK debug info must be dropped');
});

// Phase 3: Explicit ERR-01 to ERR-10 Tests
test('ERR-01: Arbitrary code SENSITIVE_KEY_VALUE_XYZ -> strictly sanitized to PROVIDER_ERROR', () => {
  const rawErr = new Error('Some API error');
  (rawErr as any).code = 'SENSITIVE_KEY_VALUE_XYZ';
  const clean = sanitizeProviderError(rawErr, 'p1', 'openai');
  assert.equal(clean.code, 'PROVIDER_ERROR');
  assert.equal(clean.safeCode, 'PROVIDER_ERROR');
  assert.equal(clean.toJSON!().safeCode, 'PROVIDER_ERROR');
});

test('ERR-02: Code thuộc allowlist -> giữ nguyên', () => {
  const err1 = new Error('Rate limit reached');
  (err1 as any).code = 'RATE_LIMIT_EXCEEDED';
  assert.equal(sanitizeProviderError(err1).safeCode, 'RATE_LIMIT_EXCEEDED');

  const err2 = new Error('Timeout');
  (err2 as any).code = 'ETIMEDOUT';
  assert.equal(sanitizeProviderError(err2).safeCode, 'ETIMEDOUT');
});

test('ERR-03: Unknown SDK code -> PROVIDER_ERROR', () => {
  const rawErr = new Error('Vendor specific failure');
  (rawErr as any).code = 'VENDOR_CUSTOM_FLAG_ABC';
  assert.equal(sanitizeProviderError(rawErr).safeCode, 'PROVIDER_ERROR');
});

test('ERR-04: Bearer token trong code -> không lộ', () => {
  const rawErr = new Error('Auth failure');
  (rawErr as any).code = 'Bearer_eyJhbGciOiJIUzI1NiJ9';
  const clean = sanitizeProviderError(rawErr);
  assert.equal(clean.safeCode, 'PROVIDER_ERROR');
  assert.ok(!clean.message.includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('ERR-05: Basic Auth trong nested cause -> không lộ', () => {
  const cause = new Error('Basic dXNlcjpwYXNzd29yZDEyMw== failed');
  const parent = new Error('Parent failed', { cause });
  const clean = sanitizeProviderError(parent);
  assert.ok(!clean.message.includes('dXNlcjpwYXNzd29yZDEyMw=='));
  if (clean.cause) {
    assert.ok(!(clean.cause as any).message?.includes('dXNlcjpwYXNzd29yZDEyMw=='));
  }
});

test('ERR-06: SDK error có trường tùy ý chứa secret -> không xuất', () => {
  const raw = new Error('SDK error');
  (raw as any).secretHeaders = { 'x-api-key': 'secret-token-value' };
  (raw as any).rawPayload = '{"password":"mypassword"}';
  const clean = sanitizeProviderError(raw);
  assert.equal((clean as any).secretHeaders, undefined);
  assert.equal((clean as any).rawPayload, undefined);
});

test('ERR-07: JSON.stringify(error.toJSON()) -> chỉ chứa thuộc tính an toàn', () => {
  const raw = new Error('Server 500 error');
  (raw as any).code = 500;
  (raw as any).sensitiveInternalProperty = 'hidden_token';
  const clean = sanitizeProviderError(raw, 'prof1', 'openai');
  const str = JSON.stringify(clean.toJSON!());
  assert.ok(!str.includes('hidden_token'));
  const parsed = JSON.parse(str);
  const keys = Object.keys(parsed).sort();
  assert.deepEqual(keys, [
    'category',
    'httpStatus',
    'message',
    'name',
    'profileId',
    'provider',
    'retryable',
    'safeCode',
    'statusCode',
    'timestamp'
  ].sort());
});

test('ERR-08: HTTP 401/429/503 -> phân loại chính xác', () => {
  assert.equal(sanitizeProviderError(new Error('HTTP 401 Unauthorized')).category, 'AUTHENTICATION');
  assert.equal(sanitizeProviderError(new Error('HTTP 429 Too Many Requests')).category, 'RATE_LIMIT');
  assert.equal(sanitizeProviderError(new Error('HTTP 503 Service Unavailable')).category, 'SERVER_ERROR');
});

test('ERR-09: Lỗi initialization -> được sanitize', () => {
  const initErr = new Error('Failed to init client with key sk-proj-1234567890abcdef');
  const clean = sanitizeProviderError(initErr);
  assert.ok(!clean.message.includes('sk-proj-1234567890abcdef'));
});

test('ERR-10: Routing history -> không chứa secret giả', async () => {
  const { ModelRouter } = await import('../src/model-center/model-router.js');
  const SECRET = 'sk-proj-hidden-secret-history-token';
  const db = {
    default: 'p1',
    profiles: {
      p1: { provider: 'openai' as const, kind: 'openai-compatible' as const, model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      p2: { provider: 'anthropic' as const, kind: 'anthropic' as const, model: 'claude-3-5-sonnet-20241022', endpoint: 'https://api.anthropic.com/v1' }
    },
    fallbacks: ['p2']
  };

  let attempts = 0;
  const mockResolve = async (spec: any) => ({
    provider: spec.profileId === 'p2' ? 'anthropic' : 'openai',
    kind: 'openai-compatible' as const,
    model: spec.profileId === 'p2' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o',
    endpoint: 'https://api.openai.com/v1',
    profileId: spec.profileId,
    apiKey: 'test-key'
  });

  const res = await ModelRouter.execute(
    { system: 'test', text: 'hi' },
    { db, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
    async (provider) => {
      attempts++;
      if (attempts === 1) {
        const failErr = new Error(`HTTP 500 Server Error with token ${SECRET}`);
        (failErr as any).status = 500;
        throw failErr;
      }
      return 'ok';
    }
  );

  assert.equal(res.output, 'ok');
  assert.ok(!JSON.stringify(res.history).includes(SECRET));
});

// Phase 3 (v1.1.6): Explicit ERRNAME-01 to ERRNAME-06 Tests
test('ERRNAME-01: Error name chứa fake secret -> không xuất trong public error hoặc toJSON()', () => {
  const rawErr = new Error('Vendor API rejected request');
  rawErr.name = 'AUDIT_SECRET_CODE_123';
  const clean = sanitizeProviderError(rawErr);
  assert.equal(clean.name, 'SafeProviderError');
  assert.notEqual(clean.name, 'AUDIT_SECRET_CODE_123');
  const json = clean.toJSON!();
  assert.equal(json.name, 'SafeProviderError');
  assert.ok(!JSON.stringify(json).includes('AUDIT_SECRET_CODE_123'));
});

test('ERRNAME-02: Arbitrary SDK error name -> mapped to SafeProviderError', () => {
  const rawErr = new Error('Failed');
  rawErr.name = 'CustomAnthropicSdkRateLimitInternalError';
  const clean = sanitizeProviderError(rawErr);
  assert.equal(clean.name, 'SafeProviderError');
});

test('ERRNAME-03: Error cause chứa secret -> sanitized', () => {
  const cause = new Error('Secret inner detail sk-ant-secret-probe-12345');
  cause.name = 'SecretCauseNameXYZ';
  const parent = new Error('Outer failure', { cause });
  const clean = sanitizeProviderError(parent);
  assert.ok(clean.cause instanceof Error);
  assert.ok(!clean.cause.message.includes('sk-ant-secret-probe-12345'));
  assert.equal(clean.cause.name, 'ProviderErrorCause');
});

test('ERRNAME-04: JSON.stringify(error) không chứa arbitrary fields', () => {
  const rawErr = new Error('Failed');
  (rawErr as any).secretInternalToken = 'hidden_secret_123';
  (rawErr as any).vendorRawPayload = { token: 'abc' };
  const clean = sanitizeProviderError(rawErr);
  const str = JSON.stringify(clean.toJSON!());
  assert.ok(!str.includes('hidden_secret_123'));
  assert.ok(!str.includes('vendorRawPayload'));
  const parsed = JSON.parse(str);
  assert.equal(parsed.name, 'SafeProviderError');
  assert.ok(Array.isArray(Object.keys(parsed)));
});

test('ERRNAME-05: Routing history không ghi Error name gốc chứa secret', async () => {
  const { ModelRouter } = await import('../src/model-center/model-router.js');
  const SECRET_NAME = 'SECRET_ERROR_NAME_PROBE_789';
  const db = {
    default: 'p1',
    profiles: {
      p1: { provider: 'openai' as const, kind: 'openai-compatible' as const, model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      p2: { provider: 'anthropic' as const, kind: 'anthropic' as const, model: 'claude-3-5-sonnet-20241022', endpoint: 'https://api.anthropic.com/v1' }
    },
    fallbacks: ['p2']
  };

  let attempts = 0;
  const mockResolve = async (spec: any) => ({
    provider: spec.profileId === 'p2' ? 'anthropic' : 'openai',
    kind: 'openai-compatible' as const,
    model: spec.profileId === 'p2' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o',
    endpoint: 'https://api.openai.com/v1',
    profileId: spec.profileId,
    apiKey: 'test-key'
  });

  const res = await ModelRouter.execute(
    { system: 'test', text: 'hi' },
    { db, resolveFn: mockResolve, maxAttemptsPerModel: 1 },
    async (provider) => {
      attempts++;
      if (attempts === 1) {
        const failErr = new Error('HTTP 500 error');
        failErr.name = SECRET_NAME;
        (failErr as any).status = 500;
        throw failErr;
      }
      return 'ok';
    }
  );

  assert.equal(res.output, 'ok');
  assert.ok(!JSON.stringify(res.history).includes(SECRET_NAME));
});

test('ERRNAME-06: HTTP status và error category hợp lệ vẫn được giữ', () => {
  const err429 = new Error('HTTP 429 Too Many Requests');
  (err429 as any).status = 429;
  const clean = sanitizeProviderError(err429);
  assert.equal(clean.name, 'SafeProviderError');
  assert.equal(clean.category, 'RATE_LIMIT');
  assert.equal(clean.httpStatus, 429);
  assert.equal(clean.statusCode, 429);
});

