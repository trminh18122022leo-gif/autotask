/** Phase 9A: real (non-mock) connection probe of the ACTIVE Model Center profile. Never prints the API key. */
import { readProfilesDb } from '../src/model-center/routing.js';
import { getModelKey } from '../src/model-center/keyring.js';
import { testConnection } from '../src/model-center/tester.js';
import { redactSecrets } from '../src/security/redact.js';

const db = await readProfilesDb();
const id = db.default;
const p = db.profiles[id];
const key = getModelKey(id);
const out: Record<string, unknown> = {
  profileId: id, provider: p.provider, kind: p.kind, model: p.model, endpoint: p.endpoint,
  storedVerifiedStatus: p.verifiedStatus ?? null, keyPresentInVault: !!key, keyLength: key ? key.length : 0
};
if (key) {
  const r = await testConnection({ provider: p.provider, kind: p.kind, model: p.model, endpoint: p.endpoint, apiKey: key });
  out.live = { success: r.success, latencyMs: r.latencyMs, statusCode: r.statusCode ?? null, category: r.category ?? null, error: r.errorMessage ? redactSecrets(r.errorMessage) : null };
}
console.log(JSON.stringify(out, null, 2));
