import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_REGISTRY,
  VERIFIED_CAPABILITIES,
  resolveModelCapabilities,
  inferCapabilities,
  fetchLiveModels,
  clearModelCache,
  getModelCacheKey
} from '../src/model-center/catalog.js';

test('PROVIDER_REGISTRY: Anthropic has supportsApiListing enabled with correct endpoint', () => {
  const anthropic = PROVIDER_REGISTRY.anthropic;
  assert.equal(anthropic.supportsApiListing, true, 'Anthropic must support dynamic API listing via v1/models');
  assert.match(anthropic.listingNote || '', /api\.anthropic\.com\/v1\/models/);
});

test('resolveModelCapabilities: distinguishes all 4 capability source tiers', () => {
  // 1. VERIFIED
  const v1 = resolveModelCapabilities('gpt-4o');
  assert.equal(v1.capabilitySource, 'VERIFIED');
  assert.equal(v1.capabilities.vision, true);

  const v2 = resolveModelCapabilities('claude-3-5-sonnet-20241022');
  assert.equal(v2.capabilitySource, 'VERIFIED');
  assert.equal(v2.capabilities.vision, true);

  // 2. PROVIDER_REPORTED (trusted live API response on official endpoint)
  const p1 = resolveModelCapabilities(
    'custom-enterprise-vision-model',
    {
      inputTokenLimit: 64000,
      supportsVision: true,
      description: 'Reported by internal server',
      isTrustedLiveApi: true
    },
    'openai',
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(p1.capabilitySource, 'PROVIDER_REPORTED');
  assert.equal(p1.capabilities.vision, true);
  assert.equal(p1.capabilities.contextWindow, 64000);

  // 2b. USER_DECLARED (caller-supplied metadata without trusted live API validation)
  const ud1 = resolveModelCapabilities('custom-enterprise-vision-model', {
    inputTokenLimit: 64000,
    supportsVision: true,
    description: 'Reported by internal server'
  });
  assert.equal(ud1.capabilitySource, 'USER_DECLARED');

  // 3. INFERRED
  const i1 = resolveModelCapabilities('deepseek-chat');
  assert.equal(i1.capabilitySource, 'INFERRED');
  assert.equal(i1.capabilities.vision, false);

  const i2 = resolveModelCapabilities('qwen-2.5-vl-72b');
  assert.equal(i2.capabilitySource, 'INFERRED');
  assert.equal(i2.capabilities.vision, true, 'Model with -vl- in name should infer vision');

  // 4. UNKNOWN
  const u1 = resolveModelCapabilities('xyz-internal-corp-assistant-v2');
  assert.equal(u1.capabilitySource, 'UNKNOWN');

  // Critical regression: custom unverified model containing a famous name MUST NOT be marked VERIFIED or vision!
  const customFake = resolveModelCapabilities('custom-gpt-4o-unverified');
  assert.equal(customFake.capabilitySource, 'UNKNOWN', 'Must be UNKNOWN, not VERIFIED');
  assert.equal(customFake.capabilities.vision, false, 'Unverified custom model must not have vision');
});

test('Gemini models: removes false vision assumption on non-multimodal models', () => {
  const embedding = inferCapabilities('text-embedding-004');
  assert.equal(embedding.vision, false, 'Embedding model must never be flagged as vision');

  const aqa = inferCapabilities('aqa');
  assert.equal(aqa.vision, false, 'AQA model must never be flagged as vision');

  const geminiFlash = inferCapabilities('gemini-1.5-flash');
  assert.equal(geminiFlash.vision, true, 'gemini-1.5-flash must be vision');
});

test('Anthropic Models API: fetchLiveModels calls GET /v1/models with required headers', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};

  try {
    clearModelCache();
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const res = await fetchLiveModels('anthropic', 'sk-ant-api-test-key', undefined, true);
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/models');
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant-api-test-key');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
    assert.equal(res.source, 'API_LIVE');
    assert.equal(res.models.length, 2);
    assert.equal(res.models[0].capabilitySource, 'VERIFIED');
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test('Model Cache: distinct keys with identical prefix generate separate non-colliding cache keys', () => {
  const keyA = 'sk-proj-sameprefix-AAAA111122223333';
  const keyB = 'sk-proj-sameprefix-BBBB444455556666';
  const cacheKeyA = getModelCacheKey('openai', keyA);
  const cacheKeyB = getModelCacheKey('openai', keyB);
  assert.notEqual(cacheKeyA, cacheKeyB, 'Two keys with same 8-char prefix must not collide');
  assert.ok(!cacheKeyA.includes(keyA), 'Plaintext key must not be exposed in cache key');
});

test('Model Cache: TTL cache reuses live models without making duplicate network requests', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  try {
    clearModelCache();
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: [{ id: 'gpt-4o' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    // Call 1: hits network
    const res1 = await fetchLiveModels('openai', 'sk-test-key-cache');
    assert.equal(fetchCount, 1);
    assert.equal(res1.models[0].id, 'gpt-4o');

    // Call 2: should hit in-memory cache
    const res2 = await fetchLiveModels('openai', 'sk-test-key-cache');
    assert.equal(fetchCount, 1, 'Second call must be served from cache without second network request');
    assert.equal(res2.models[0].id, 'gpt-4o');

    // Call 3 with bypassCache: should trigger network
    await fetchLiveModels('openai', 'sk-test-key-cache', undefined, true);
    assert.equal(fetchCount, 2, 'bypassCache=true must fetch fresh data');
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test('Model Cache: distinct keys with identical prefix generate separate non-colliding cache keys', () => {
  const keyA = 'sk-proj-sameprefix-AAAA111122223333';
  const keyB = 'sk-proj-sameprefix-BBBB444455556666';
  const cacheKeyA = getModelCacheKey('openai', keyA);
  const cacheKeyB = getModelCacheKey('openai', keyB);
  assert.notEqual(cacheKeyA, cacheKeyB, 'Two keys with same 8-char prefix must not collide');
  assert.ok(!cacheKeyA.includes(keyA), 'Plaintext key must not be exposed in cache key');
});
