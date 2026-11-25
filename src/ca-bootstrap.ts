/** CA Certificate Bootstrap & Portable TLS Verification for AutoTask AI.
 * Ensures NODE_EXTRA_CA_CERTS is active for both 'Start_AutoTask_AI.cmd' and direct 'npm start' / 'npm run browser'.
 * Resolves public intermediate CA certificates from allowlisted portable locations (resources/certs)
 * or environment overrides, maintaining strict TLS verification without disabling HTTPS checks or security flags.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';

export const GLOBALSIGN_INTERMEDIATE_SHA256 = 'b676ffa3179e8812093a1b5eafee876ae7a6aaf231078dad1bfb21cd2893764a';
export const OFFICIAL_AIA_URL = 'http://secure.globalsign.com/cacert/gsrsaovsslca2018.crt';

/** Validates that a file exists and contains standard PEM certificate boundaries */
export function isValidPemCertificate(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.includes('-----BEGIN CERTIFICATE-----') && content.includes('-----END CERTIFICATE-----');
  } catch {
    return false;
  }
}

/** Resolves the best available intermediate CA certificate in portable order */
export function resolveCaCertPath(baseDir = process.cwd(), checkEnv = true): string | null {
  const candidates = [
    checkEnv && baseDir === process.cwd() ? process.env.NODE_EXTRA_CA_CERTS : undefined,
    resolve(baseDir, 'resources', 'certs', 'globalsign_intermediate.crt'),
    resolve(baseDir, 'resources', 'certs', 'globalsign_intermediate.pem'),
    resolve(baseDir, '.private', 'globalsign_intermediate.pem'),
    resolve(baseDir, '.private', 'globalsign_intermediate.crt')
  ].filter(Boolean) as string[];

  for (const cand of candidates) {
    if (isValidPemCertificate(cand)) {
      return cand;
    }
  }
  return null;
}

export interface BootstrapResult {
  respawned: boolean;
  caCertPath: string | null;
  status?: number;
  error?: Error;
}

/** Self-respawns current Node command with NODE_EXTRA_CA_CERTS if not already active.
 * Handles spawn errors explicitly instead of masking failures or exiting with 0.
 */
export function bootstrapIntermediateCa(
  baseDir = process.cwd(),
  spawnFn: (cmd: string, args: string[], opts: any) => any = spawnSync
): BootstrapResult {
  // If already respawned, avoid loops
  if (process.env._AUTOTASK_CA_RESPAWNED) {
    return { respawned: false, caCertPath: process.env.NODE_EXTRA_CA_CERTS || null };
  }

  // If NODE_EXTRA_CA_CERTS is already set and valid on the current process, proceed directly
  // (unless an isolated baseDir is explicitly requested)
  if (baseDir === process.cwd() && process.env.NODE_EXTRA_CA_CERTS && isValidPemCertificate(process.env.NODE_EXTRA_CA_CERTS)) {
    return { respawned: false, caCertPath: process.env.NODE_EXTRA_CA_CERTS };
  }

  const caCertPath = resolveCaCertPath(baseDir, baseDir === process.cwd());
  if (!caCertPath) {
    // Certificate not available; do not abort non-network commands (e.g. doctor, help)
    process.env._AUTOTASK_CA_MISSING = '1';
    return { respawned: false, caCertPath: null };
  }

  const child = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: caCertPath,
      _AUTOTASK_CA_RESPAWNED: '1'
    }
  });

  // Explicit error handling: never swallow spawn failures or exit with 0 on failure
  if (child.error) {
    process.stderr.write(`[AutoTask CA Bootstrap] Failed to respawn process: ${child.error.message}\n`);
    const exitCode = (child.error as any).code === 'ENOENT' ? 127 : 1;
    if (typeof process.exit === 'function') {
      process.exit(exitCode);
    }
    return { respawned: true, caCertPath, status: exitCode, error: child.error };
  }

  if (child.signal) {
    process.stderr.write(`[AutoTask CA Bootstrap] Child process terminated by signal: ${child.signal}\n`);
    if (typeof process.exit === 'function') {
      process.exit(1);
    }
    return { respawned: true, caCertPath, status: 1 };
  }

  const finalStatus = child.status ?? 1;
  if (typeof process.exit === 'function') {
    process.exit(finalStatus);
  }
  return { respawned: true, caCertPath, status: finalStatus };
}

export interface TlsConnectivityResult {
  tlsStatus: 'TLS_VERIFIED' | 'TLS_FAILED';
  certStatus: 'CERTIFICATE_READY' | 'CERTIFICATE_MISSING';
  certPath: string | null;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  verifiedUrl: string;
}

/** Performs a real read-only HTTPS GET request against LMS using strict TLS verification.
 * Distinguishes CERTIFICATE_READY, CERTIFICATE_MISSING, TLS_VERIFIED, and TLS_FAILED.
 */
export function checkLmsTlsConnectivity(
  targetUrl = 'https://lms.hust.edu.vn/login/index.php',
  timeoutMs = 6000
): Promise<TlsConnectivityResult> {
  const certPath = resolveCaCertPath();
  const certStatus: 'CERTIFICATE_READY' | 'CERTIFICATE_MISSING' = certPath ? 'CERTIFICATE_READY' : 'CERTIFICATE_MISSING';

  return new Promise((resolveResult) => {
    try {
      const parsed = new URL(targetUrl);
      const req = https.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          timeout: timeoutMs,
          rejectUnauthorized: true, // Strict TLS invariant: never bypass HTTPS
          headers: {
            'User-Agent': 'AutoTask-AI-Doctor/1.1.7 (Strict-TLS-Audit)'
          }
        },
        (res) => {
          const status = res.statusCode || 0;
          res.resume(); // Consume data to free memory
          resolveResult({
            tlsStatus: status > 0 ? 'TLS_VERIFIED' : 'TLS_FAILED',
            certStatus,
            certPath,
            statusCode: status,
            verifiedUrl: targetUrl
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolveResult({
          tlsStatus: 'TLS_FAILED',
          certStatus,
          certPath,
          errorCode: 'ETIMEDOUT',
          errorMessage: `Connection timed out after ${timeoutMs}ms`,
          verifiedUrl: targetUrl
        });
      });

      req.on('error', (err: any) => {
        resolveResult({
          tlsStatus: 'TLS_FAILED',
          certStatus,
          certPath,
          errorCode: err.code || 'UNKNOWN_TLS_ERROR',
          errorMessage: err.message,
          verifiedUrl: targetUrl
        });
      });
    } catch (e: any) {
      resolveResult({
        tlsStatus: 'TLS_FAILED',
        certStatus,
        certPath,
        errorCode: 'SYNTAX_OR_URL_ERROR',
        errorMessage: e.message,
        verifiedUrl: targetUrl
      });
    }
  });
}
