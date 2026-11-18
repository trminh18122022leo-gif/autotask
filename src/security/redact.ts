/** Centralized secret sanitizer. Redacts API keys, tokens, cookies, passwords from logs, reports, and errors. */

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI & generic sk- tokens
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  // Google Gemini API keys
  /AIzaSy[A-Za-z0-9_-]{30,}/g,
  // Anthropic Claude keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // Groq API keys
  /gsk_[A-Za-z0-9_-]{20,}/g,
  // Bearer tokens in headers or strings
  /Bearer\s+[A-Za-z0-9._~+/-]{10,}/gi,
  // Basic auth in headers or strings
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
  // Passwords embedded in URLs: https://user:pass@host
  /(https?:\/\/[^/:]+:)([^/@]+)(@)/gi,
  // Authorization headers
  /["']?[Aa]uthorization["']?\s*:\s*["'][^"']+["']/g,
  // Session cookies and Set-Cookie
  /["']?(?:MoodleSession|session|sessionid|sid|connect\.sid|auth_token|token|refresh_token|jwt|ESTSAUTH|ESTSAUTHPERSISTENT)["']?\s*=\s*[^;\s&"']+/gi,
  /Set-Cookie:\s*[^;\r\n]+/gi,
  // JWT tokens: eyJhbGciOi...
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Generic key= or apiKey= or session query params
  /((?:^|[?&\s])(?:sesskey|key|api_?key|token|access_token|refresh_token|secret|password|passwd|auth|session|sessionid|sid|ticket|code|state|wantsurl)=)[^&#"'\s]+/gi,
  // URL-encoded query params: %26sesskey%3D... or %3Fsesskey%3D...
  /((?:%26|%3F|%26amp%3B)(?:sesskey|key|api_?key|token|access_token|refresh_token|secret|password|passwd|auth|session|sessionid|sid|ticket|code|state|wantsurl)(?:%3D|%3d))[^%&#"'\s]+/gi
];

/** Redacts sensitive credentials from arbitrary strings */
export function redactSecrets(text: string, knownSecrets: string[] = []): string {
  if (!text || typeof text !== 'string') return String(text ?? '');

  let clean = text;

  // 1. Redact known explicit secrets first
  for (const s of knownSecrets) {
    if (s && s.length >= 4) {
      clean = clean.split(s).join('[REDACTED_SECRET]');
    }
  }

  // 2. Redact passwords in URLs
  clean = clean.replace(/(https?:\/\/[^/:]+:)([^/@]+)(@)/gi, '$1[REDACTED_PWD]$3');

  // 3. Redact Bearer and Basic tokens
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._~+/-]{10,}/gi, 'Bearer [REDACTED_TOKEN]');
  clean = clean.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [REDACTED_CREDENTIAL]');

  // 4. Redact query params and standalone secret assignments
  clean = clean.replace(/((?:^|[?&\s])(?:sesskey|key|api_?key|token|access_token|refresh_token|secret|password|passwd|auth|session|sessionid|sid|ticket|code|state|wantsurl)=)[^&#"'\s]+/gi, '$1[REDACTED]');

  // 4b. Redact URL-encoded query params
  clean = clean.replace(/((?:%26|%3F|%26amp%3B)(?:sesskey|key|api_?key|token|access_token|refresh_token|secret|password|passwd|auth|session|sessionid|sid|ticket|code|state|wantsurl)(?:%3D|%3d))[^%&#"'\s]+/gi, '$1[REDACTED]');

  // 4c. Redact session cookies
  clean = clean.replace(/(["']?(?:MoodleSession|session|sessionid|sid|connect\.sid|auth_token|token|refresh_token|jwt|ESTSAUTH|ESTSAUTHPERSISTENT)["']?\s*=\s*)[^;\s&"']+/gi, '$1[REDACTED]');

  // 4d. Redact passwords and secrets in key-value strings or logs
  clean = clean.replace(/(?:password|passwd|secret)\s*[:=]\s*["']?[^"'\s,;]+/gi, 'password=[REDACTED]');

  // 5. Redact by regex patterns
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, (match) => {
      if (match.startsWith('Bearer') || match.startsWith('Basic') || match.includes('[REDACTED')) return match;
      if (match.startsWith('sk-ant-')) return 'sk-ant-[REDACTED]';
      if (match.startsWith('sk-proj-')) return 'sk-proj-[REDACTED]';
      if (match.startsWith('sk-')) return 'sk-[REDACTED]';
      if (match.startsWith('AIzaSy')) return 'AIzaSy[REDACTED]';
      if (match.startsWith('gsk_')) return 'gsk_[REDACTED]';
      if (match.toLowerCase().includes('authorization')) return '"Authorization": "[REDACTED]"';
      return '[REDACTED_CREDENTIAL]';
    });
  }

  return clean;
}

/** Recursively redacts secrets in objects, arrays, and Error instances */
export function redactObject<T>(obj: T, knownSecrets: string[] = []): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactSecrets(obj, knownSecrets) as unknown as T;
  }

  if (obj instanceof Error) {
    const cleanErr = new Error(redactSecrets(obj.message, knownSecrets));
    if (obj.stack) cleanErr.stack = redactSecrets(obj.stack, knownSecrets);
    if ((obj as any).cause) {
      (cleanErr as any).cause = redactObject((obj as any).cause, knownSecrets);
    }
    return cleanErr as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, knownSecrets)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const res: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (/password|secret|apikey|api_key|token|cookie|authorization|auth|credential|keyring|session|jwt|sesskey|ticket|code|state/i.test(key)) {
        if (typeof val === 'string') {
          res[key] = key.toLowerCase().includes('key') ? '[REDACTED_KEY]' : '[REDACTED_CREDENTIAL]';
        } else {
          res[key] = redactObject(val, knownSecrets);
        }
      } else {
        res[key] = redactObject(val, knownSecrets);
      }
    }
    return res as unknown as T;
  }

  return obj;
}
