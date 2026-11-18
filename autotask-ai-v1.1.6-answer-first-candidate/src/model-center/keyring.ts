/** Keyring and secret management for Model Center. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.AUTOTASK_PYTHON || 'python';
const bridgeScript = resolve('desktop', 'vault_bridge.py');

/** Masks an API key so it can be safely displayed on terminal without exposing secrets */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '••••••••';
  const prefixLen = key.startsWith('sk-') ? 8 : Math.min(7, Math.max(4, Math.floor(key.length / 4)));
  const prefix = key.slice(0, prefixLen);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

/** Sanitize an error message to guarantee no API key or token leaks */
export function sanitizeError(message: string, apiKey?: string): string {
  let clean = message;
  if (apiKey && apiKey.length > 5) {
    clean = clean.split(apiKey).join('[REDACTED_KEY]');
  }
  // Generic token pattern remover (Bearer sk-..., etc.)
  clean = clean.replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]');
  clean = clean.replace(/AIzaSy[A-Za-z0-9_-]{30,}/g, 'AIzaSy[REDACTED]');
  clean = clean.replace(/key=[A-Za-z0-9_-]{20,}/g, 'key=[REDACTED]');
  return clean;
}

export function getModelKey(profileId: string): string | null {
  try {
    const out = execFileSync(python, [bridgeScript, 'get-model', profileId], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function setModelKey(profileId: string, apiKey: string): void {
  if (!apiKey) throw new Error('API key cannot be empty');
  execFileSync(python, [bridgeScript, 'set-model', profileId], {
    input: apiKey.trim(),
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

export function deleteModelKey(profileId: string): void {
  try {
    execFileSync(python, [bridgeScript, 'delete-model', profileId], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {}
}

export function testKeyringAccess(): { ok: boolean; backend: string } {
  try {
    const out = execFileSync(python, [bridgeScript, 'check'], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = out.match(/KEYRING_OK:(.+)/);
    return { ok: true, backend: match ? match[1].trim() : 'Active' };
  } catch (e) {
    return { ok: false, backend: 'Unavailable: ' + (e instanceof Error ? e.message : String(e)) };
  }
}
