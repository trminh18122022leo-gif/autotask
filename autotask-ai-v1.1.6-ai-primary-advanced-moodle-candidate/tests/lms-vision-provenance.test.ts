/** Phase 1 — Model Vision Provenance & Capability Anti-Forgery Regression Suite
 * Verifies strict separation between user-persisted profile JSON (`USER_DECLARED`) and
 * trusted live vendor API metadata (`PROVIDER_REPORTED`), single-source provenance parity
 * across Catalog / ModelRouter / Model Center UI, and screenshot transmission blocking.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProfilesDb, saveProfilesDb, sanitizeStoredProfile } from '../src/model-center/routing.js';
import {
  clearModelCache,
  fetchLiveModels,
  resolveProfileCapabilities,
  sanitizeUserProfileMetadata
} from '../src/model-center/catalog.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { inspectProfileCapabilityDetails } from '../src/ui/model-center-cli.js';
import type { ModelProfilesDb, StoredProfile } from '../src/model-center/types.js';

describe('Phase 1 — Vision Provenance & Forged Metadata Hardening (VP-01..05)', () => {
  test('VP-01: readProfilesDb() and saveProfilesDb() strip forged isTrustedLiveApi, provenance, and unknown keys on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotask-vp01-'));
    const dbPath = join(dir, 'model-profiles.json');
    try {
      await writeFile(
        dbPath,
        JSON.stringify(
          {
            default: 'forged_prof',
            profiles: {
              forged_prof: {
                provider: 'openai',
                kind: 'openai-compatible',
                model: 'unknown-text-model-v9',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                isAdminBypass: true,
                metadata: {
                  supportsVision: true,
                  inputTokenLimit: 128000,
                  isTrustedLiveApi: true,
                  provenance: 'PROVIDER_REPORTED',
                  injectedSecretFlag: 'evil'
                }
              }
            },
            fallbacks: []
          },
          null,
          2
        ),
        'utf8'
      );

      const loaded = await readProfilesDb(dbPath);
      const prof = loaded.profiles['forged_prof'];
      assert.ok(prof, 'Profile must load cleanly after sanitization');
      assert.equal('isAdminBypass' in (prof as any), false);
      assert.equal('isTrustedLiveApi' in ((prof.metadata as any) || {}), false);
      assert.equal('provenance' in ((prof.metadata as any) || {}), false);
      assert.equal('injectedSecretFlag' in ((prof.metadata as any) || {}), false);
      assert.deepEqual(prof.metadata, { supportsVision: true, inputTokenLimit: 128000 });

      const resolved = resolveProfileCapabilities(prof);
      assert.equal(resolved.capabilitySource, 'USER_DECLARED');
      assert.equal(ModelRouter.isVisionCapable(prof), false);

      await assert.rejects(
        () => ModelRouter.resolveCandidates({ db: loaded, requiresVision: true }),
        /Vision/i
      );

      // Re-saving DB also guarantees clean schema on disk
      await saveProfilesDb(loaded, dbPath);
      const savedRaw = JSON.parse(await readFile(dbPath, 'utf8'));
      assert.equal(savedRaw.profiles.forged_prof.metadata.isTrustedLiveApi, undefined);
      assert.equal(savedRaw.profiles.forged_prof.metadata.provenance, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('VP-02: Raw in-memory StoredProfile with forged metadata.isTrustedLiveApi=true cannot bypass resolveProfileCapabilities or ModelRouter', async () => {
    const forgedInMemory = {
      provider: 'anthropic',
      kind: 'anthropic',
      model: 'unlisted-claude-text-experiment',
      endpoint: 'https://api.anthropic.com/v1/messages',
      metadata: {
        supportsVision: true,
        isTrustedLiveApi: true,
        provenance: 'VERIFIED'
      }
    } as unknown as StoredProfile;

    assert.deepEqual(sanitizeUserProfileMetadata(forgedInMemory.metadata), { supportsVision: true });
    assert.equal((sanitizeStoredProfile(forgedInMemory)?.metadata as any)?.isTrustedLiveApi, undefined);

    const resolved = resolveProfileCapabilities(forgedInMemory);
    assert.equal(resolved.capabilitySource, 'USER_DECLARED');
    assert.notEqual(resolved.capabilitySource, 'PROVIDER_REPORTED');
    assert.notEqual(resolved.capabilitySource, 'VERIFIED');
    assert.equal(ModelRouter.isVisionCapable(forgedInMemory), false);

    const db: ModelProfilesDb = {
      default: 'forged_mem',
      profiles: { forged_mem: forgedInMemory },
      fallbacks: []
    };
    await assert.rejects(
      () => ModelRouter.resolveCandidates({ db, requiresVision: true }),
      /Vision/i
    );
  });

  test('VP-03: Catalog, ModelRouter, and Model Center UI inspectProfileCapabilityDetails agree 100% on provenance and Vision gate', () => {
    const cases: { name: string; profile: StoredProfile; expectedSource: string; expectedAutoVision: boolean }[] = [
      {
        name: 'Official OpenAI gpt-4o',
        profile: {
          provider: 'openai',
          kind: 'openai-compatible',
          model: 'gpt-4o',
          endpoint: 'https://api.openai.com/v1/chat/completions'
        },
        expectedSource: 'VERIFIED',
        expectedAutoVision: true
      },
      {
        name: 'Custom proxy spoofing gpt-4o without userDeclaredCapabilities',
        profile: {
          provider: 'openai',
          kind: 'openai-compatible',
          model: 'gpt-4o',
          endpoint: 'https://proxy.attacker.example/v1/chat/completions'
        },
        expectedSource: 'UNKNOWN',
        expectedAutoVision: false
      },
      {
        name: 'Forged metadata.isTrustedLiveApi on unknown model',
        profile: {
          provider: 'openai',
          kind: 'openai-compatible',
          model: 'unknown-text-only-2026',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          metadata: { supportsVision: true, ...( { isTrustedLiveApi: true } as any ) }
        },
        expectedSource: 'USER_DECLARED',
        expectedAutoVision: false
      },
      {
        name: 'Explicit userDeclaredCapabilities.vision=true stays USER_DECLARED (never VERIFIED/PROVIDER_REPORTED)',
        profile: {
          provider: 'custom',
          kind: 'openai-compatible',
          model: 'local-vlm-qwen',
          endpoint: 'https://vlm.internal.edu.vn/v1/chat/completions',
          userDeclaredCapabilities: { vision: true }
        },
        expectedSource: 'USER_DECLARED',
        expectedAutoVision: true
      }
    ];

    for (const c of cases) {
      const cat = resolveProfileCapabilities(c.profile);
      const router = ModelRouter.isVisionCapable(c.profile);
      const ui = inspectProfileCapabilityDetails(c.profile);

      assert.equal(cat.capabilitySource, c.expectedSource, `${c.name}: catalog source`);
      assert.equal(ui.capabilitySource, cat.capabilitySource, `${c.name}: UI source must match catalog`);
      assert.equal(router, c.expectedAutoVision, `${c.name}: router vision gate`);
      assert.equal(ui.autoVisionRoutingAllowed, router, `${c.name}: UI vision gate must match router`);
    }
  });

  test('VP-04: ModelRouter.execute() never transmits screenshots/images (imageBase64) to ineligible models', async () => {
    const db: ModelProfilesDb = {
      default: 'forged_primary',
      profiles: {
        forged_primary: {
          provider: 'openai',
          kind: 'openai-compatible',
          model: 'unverified-text-model',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          metadata: { supportsVision: true, ...( { isTrustedLiveApi: true } as any ) }
        }
      },
      fallbacks: []
    };

    let transmittedImage = false;
    await assert.rejects(
      () =>
        ModelRouter.execute(
          { system: 'sys', text: 'solve', imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
          {
            db,
            resolveFn: async () => ({
              provider: 'openai',
              kind: 'openai-compatible',
              model: 'unverified-text-model',
              endpoint: 'https://api.openai.com/v1/chat/completions',
              apiKey: 'sk-dummy'
            })
          },
          async (_prov, req) => {
            if (req.imageBase64) transmittedImage = true;
            return '{"answers":[]}';
          }
        ),
      /Vision/i
    );
    assert.equal(transmittedImage, false, 'Screenshot base64 must NEVER be sent to ineligible model');
  });

  test('VP-05: fetchLiveModels() on Gemini does not fabricate PROVIDER_REPORTED vision=true for unverified models without vendor IMAGE modality', async () => {
    const origFetch = globalThis.fetch;
    try {
      clearModelCache();
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-experimental-pro-text-99',
                inputTokenLimit: 65536,
                description: 'Experimental text endpoint without IMAGE modality'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )) as typeof fetch;

      const live = await fetchLiveModels('gemini', 'AIza-dummy-test-key', undefined, true);
      assert.equal(live.models.length, 1);
      assert.equal(live.models[0].capabilities.vision, false, 'Must not guess vision=true from "pro" substring as PROVIDER_REPORTED');

      const prof: StoredProfile = {
        provider: 'gemini',
        kind: 'gemini',
        model: 'gemini-experimental-pro-text-99',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta'
      };
      assert.equal(ModelRouter.isVisionCapable(prof), false);
    } finally {
      globalThis.fetch = origFetch;
      clearModelCache();
    }
  });
});
