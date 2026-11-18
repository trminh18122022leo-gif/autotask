import { readFile } from 'node:fs/promises';
import type { AppConfig, LmsOperationMode } from './types.js';
import { safeEndpoint } from './providers.js';
import { isModeEscalation } from './operation-mode.js';

export interface OriginTrustOptions {
  allowedOrigins?: readonly string[];
  allowLocalHttpSandbox?: boolean;
}

const VALID_OPERATION_MODES = new Set<LmsOperationMode>([
  'READ_ONLY',
  'PRACTICE_ASSISTED',
  'ASSESSMENT_RESTRICTED'
]);

/** Checks whether a hostname is a strict local loopback interface (`localhost`, `127.0.0.1`, `[::1]`). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** Validates and normalizes an explicit origin entry (scheme + host + optional port, no userinfo/path/query/fragment). */
export function normalizeAllowedOrigin(rawOrigin: string): string {
  if (!rawOrigin || typeof rawOrigin !== 'string') {
    throw new Error('allowedOrigins chứa giá trị rỗng hoặc không hợp lệ');
  }
  const u = new URL(rawOrigin.trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error(`Origin không hợp lệ "${rawOrigin}" (chỉ HTTP(S), không nhúng username/password)`);
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new Error(`Origin "${rawOrigin}" không được chứa đường dẫn, query hoặc fragment`);
  }
  if (!isLoopbackHost(u.hostname) && u.protocol !== 'https:') {
    throw new Error(`Origin LMS không phải local "${rawOrigin}" bắt buộc dùng giao thức HTTPS`);
  }
  return u.origin.toLowerCase();
}

export function originTrustFromConfig(
  config?: Pick<AppConfig, 'allowedOrigins' | 'allowLocalHttpSandbox'>
): OriginTrustOptions {
  return {
    allowedOrigins: config?.allowedOrigins,
    allowLocalHttpSandbox: config?.allowLocalHttpSandbox
  };
}

/** Strict LMS Origin Trust Validator (`AUD-LMS-02`, `AUD-LMS-03`, `ORIGIN-01..07`).
 * Enforces full origin (scheme + exact hostname + port):
 *  - Rejects embedded userinfo (`username`/`password`) on all URLs.
 *  - Requires exact hostname match in `hosts` or exact origin match in `options.allowedOrigins` (never auto-expanded).
 *  - Requires `https:` and standard port 443 for all non-loopback LMS hosts unless an explicit HTTPS `allowedOrigins` entry authorizes a port.
 *  - Permits `http://127.0.0.1:<port>` or `http://localhost:<port>` ONLY when loopback is explicitly configured in `hosts`/`allowedOrigins` and `allowLocalHttpSandbox !== false`.
 */
export function ensureAllowed(url: string, hosts: readonly string[], options?: OriginTrustOptions): URL {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('URL không hợp lệ (chỉ HTTP(S), không nhúng username/password)');
  }

  const host = parsed.hostname.toLowerCase();
  const origin = parsed.origin.toLowerCase();

  const normalizedOrigins = (options?.allowedOrigins || []).map(o => normalizeAllowedOrigin(o));
  const isExplicitAllowedOrigin = normalizedOrigins.includes(origin);
  const isHostAllowed = hosts.some(h => h.trim().toLowerCase() === host);

  if (!isHostAllowed && !isExplicitAllowedOrigin) {
    throw new Error(`Website ${parsed.hostname} (${parsed.origin}) không nằm trong allowedHosts`);
  }

  if (!isLoopbackHost(host)) {
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `Từ chối giao thức HTTP không an toàn trên origin ${parsed.origin}; LMS chính thức bắt buộc dùng HTTPS`
      );
    }
    if (parsed.port && parsed.port !== '443' && !isExplicitAllowedOrigin) {
      throw new Error(
        `Từ chối cổng (port :${parsed.port}) không được phê duyệt trên origin ${parsed.origin}; chỉ chấp nhận HTTPS cổng chuẩn 443`
      );
    }
  } else {
    if (parsed.protocol === 'http:' && options?.allowLocalHttpSandbox === false && !isExplicitAllowedOrigin) {
      throw new Error(
        `Local HTTP sandbox đang bị tắt (allowLocalHttpSandbox=false) đối với origin ${parsed.origin}`
      );
    }
  }

  return parsed;
}

/** Verifies whether a redirect target matches an explicitly configured SSO authentication origin (`config.authUrls`).
 * Checks full origin (`protocol + hostname + port`), rejects embedded credentials, and enforces HTTPS + standard port 443 on non-loopback IdPs.
 */
export function isApprovedSsoOrigin(
  currentUrl: string,
  config?: Pick<AppConfig, 'authUrls' | 'allowedOrigins' | 'allowLocalHttpSandbox'>
): boolean {
  if (!config?.authUrls || config.authUrls.length === 0) return false;
  try {
    const cur = new URL(currentUrl);
    if (!['http:', 'https:'].includes(cur.protocol) || cur.username || cur.password) return false;
    const normalizedOrigins = (config.allowedOrigins || []).map(o => {
      try { return normalizeAllowedOrigin(o); } catch { return ''; }
    }).filter(Boolean);
    const curOrigin = cur.origin.toLowerCase();
    const isExplicitOrigin = normalizedOrigins.includes(curOrigin);

    if (!isLoopbackHost(cur.hostname)) {
      if (cur.protocol !== 'https:') return false;
      if (cur.port && cur.port !== '443' && !isExplicitOrigin) return false;
    } else if (cur.protocol === 'http:' && config.allowLocalHttpSandbox === false && !isExplicitOrigin) {
      return false;
    }

    return config.authUrls.some(rawAuthUrl => {
      try {
        const auth = new URL(rawAuthUrl);
        if (auth.username || auth.password) return false;
        if (!isLoopbackHost(auth.hostname)) {
          if (auth.protocol !== 'https:') return false;
          if (auth.port && auth.port !== '443' && !normalizedOrigins.includes(auth.origin.toLowerCase())) {
            return false;
          }
        }
        return auth.origin.toLowerCase() === curOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function validateConfig(data: AppConfig): AppConfig {
  if (!data.approvedForAIUse) throw new Error('Cần xác nhận approvedForAIUse=true cho tác vụ có quyền dùng AI');
  if (!Array.isArray(data.allowedHosts) || !data.allowedHosts.length) throw new Error('Cần allowedHosts');
  if (data.allowedOrigins !== undefined) {
    if (!Array.isArray(data.allowedOrigins)) throw new Error('allowedOrigins phải là mảng chuỗi origin hợp lệ');
    for (const o of data.allowedOrigins) normalizeAllowedOrigin(o);
  }
  if (data.operationMode !== undefined && !VALID_OPERATION_MODES.has(data.operationMode)) {
    throw new Error(`operationMode không hợp lệ: ${String(data.operationMode)}`);
  }
  if (!Array.isArray(data.tasks) || (!data.tasks.length && !data.autoDiscover)) {
    throw new Error('Chưa có tasks và chưa bật autoDiscover');
  }
  if (data.answerSourceMode !== undefined && !['AI_PRIMARY','FORM_FILE'].includes(data.answerSourceMode)) {
    throw new Error('answerSourceMode phải là AI_PRIMARY hoặc FORM_FILE');
  }
  for (const task of data.tasks) {
    if (task.answerSourceMode !== undefined && !['AI_PRIMARY','FORM_FILE'].includes(task.answerSourceMode)) {
      throw new Error(`answerSourceMode không hợp lệ trên task ${task.id}`);
    }
  }
  for (const filePaths of [data.answerFilePaths, ...data.tasks.map(t=>t.answerFilePaths)]) {
    if (filePaths === undefined) continue;
    if (!Array.isArray(filePaths) || filePaths.length > 25 || filePaths.some(f=>typeof f!=='string'||f.trim().length===0||f.length>1024||/^https?:\/\//i.test(f))) {
      throw new Error('answerFilePaths must contain up to 25 explicit local paths');
    }
  }
  if (!Number.isInteger(data.parallelTabs) || data.parallelTabs < 1 || data.parallelTabs > 3) {
    throw new Error('parallelTabs phải từ 1 đến 3');
  }
  if (!data.provider || !['openai-compatible', 'gemini', 'anthropic', undefined].includes(data.provider.kind)) {
    throw new Error('Provider không hợp lệ');
  }

  const originOpts = originTrustFromConfig(data);

  for (const task of data.tasks) {
    for (const selector of [task.challengeInputSelector,task.challengeVerifySelector]) {
      if (selector !== undefined && (typeof selector !== 'string' || selector.length<1 || selector.length>200)) {
        throw new Error('Challenge selector must be a short explicit CSS selector');
      }
    }
    if (task.note && (typeof task.note !== 'string' || task.note.length > 6000)) {
      throw new Error('Task note exceeds 6000 characters');
    }
    if (!task.id || typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id)) {
      throw new Error(
        `Task ID "${task.id || '?'}" không hợp lệ. Chỉ chấp nhận ký tự chữ, số, gạch ngang, gạch dưới (1-64 ký tự), không chứa đường dẫn.`
      );
    }
    if (!task.aiPermitted) throw new Error(`Tác vụ ${task.id} chưa xác nhận quyền dùng AI`);
    if (task.mode !== undefined && !VALID_OPERATION_MODES.has(task.mode)) {
      throw new Error(`Task mode không hợp lệ cho ${task.id}: ${String(task.mode)}`);
    }
    if (isModeEscalation(data.operationMode, task.mode)) {
      throw new Error(
        `Task ${task.id} đặt mode=${task.mode} nới rộng quyền so với operationMode toàn cục=${data.operationMode}; task chỉ được hạn chế thêm, không được mở rộng`
      );
    }
    if (task.scopeAttestation !== undefined && task.scopeAttestation !== 'PERMITTED_SELF_PRACTICE') {
      throw new Error(`scopeAttestation không hợp lệ cho ${task.id}: ${String(task.scopeAttestation)}`);
    }
    ensureAllowed(task.url, data.allowedHosts, originOpts);
    if (task.nextButton && /submit|finish|nộp|hoàn thành|gửi bài/i.test(task.nextButton)) {
      throw new Error('nextButton có thể là nút nộp, không được dùng tự động');
    }
    if (task.maxPages !== undefined && (!Number.isInteger(task.maxPages) || task.maxPages < 1 || task.maxPages > 30)) {
      throw new Error('maxPages phải trong khoảng 1..30');
    }
  }

  for (const url of [...(data.deadlinePages || []), ...(data.discoveryStartUrls || [])]) {
    ensureAllowed(url, data.allowedHosts, originOpts);
  }

  // Validate authUrls: each SSO URL must have a strict, valid origin (HTTPS + port 443 on non-loopback, zero userinfo),
  // without forcing third-party SSO IdP domains (e.g. login.microsoftonline.com) to be added to task allowedHosts.
  for (const authUrl of data.authUrls || []) {
    const u = new URL(authUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      throw new Error(`authUrl không hợp lệ "${authUrl}" (không nhúng username/password)`);
    }
    if (!isLoopbackHost(u.hostname)) {
      if (u.protocol !== 'https:') {
        throw new Error(`authUrl "${authUrl}" bắt buộc dùng HTTPS`);
      }
      const explicitAuthOrigin = (data.allowedOrigins || []).some(
        o => normalizeAllowedOrigin(o) === u.origin.toLowerCase()
      );
      if (u.port && u.port !== '443' && !explicitAuthOrigin) {
        throw new Error(`authUrl "${authUrl}" sử dụng cổng (port :${u.port}) không được phê duyệt`);
      }
    } else if (u.protocol === 'http:' && data.allowLocalHttpSandbox === false) {
      throw new Error(`authUrl "${authUrl}" dùng HTTP local khi allowLocalHttpSandbox=false`);
    }
  }

  if (!data.provider.model && !data.provider.profileId) {
    throw new Error('Thiếu provider.model hoặc provider.profileId');
  }
  if (
    data.maxDiscoveryPages !== undefined &&
    (!Number.isInteger(data.maxDiscoveryPages) || data.maxDiscoveryPages < 1 || data.maxDiscoveryPages > 50)
  ) {
    throw new Error('maxDiscoveryPages must be 1..50');
  }
  if (data.fallbackProfileIds && (!Array.isArray(data.fallbackProfileIds) || data.fallbackProfileIds.length > 8)) {
    throw new Error('Too many fallbacks');
  }
  if (
    data.accessWatchMinutes !== undefined &&
    (!Number.isInteger(data.accessWatchMinutes) || data.accessWatchMinutes < 0 || data.accessWatchMinutes > 30)
  ) {
    throw new Error('accessWatchMinutes must be 0..30');
  }
  if (data.moodleHosts !== undefined) {
    if (
      !Array.isArray(data.moodleHosts) ||
      data.moodleHosts.some(h => typeof h !== 'string' || !/^[a-z0-9.-]+$/i.test(h.trim()))
    ) {
      throw new Error('moodleHosts phải là danh sách hostname hợp lệ (không chứa giao thức hoặc đường dẫn)');
    }
  }
  if (data.provider.endpoint) safeEndpoint(data.provider.endpoint);
  return data;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Chưa có cấu hình ${path}. Hãy chạy npm run setup trước.`);
    }
    throw e;
  }
  return validateConfig(JSON.parse(contents) as AppConfig);
}
