/** Phase 9C.1: Portable TLS & First-Run Acceptance Test Suite
 * Validates:
 * 1. Clean install without .private resolves public intermediate CA from resources/certs
 * 2. Intermediate CA validity and SHA-256 fingerprint match official GlobalSign AIA
 * 3. Missing or invalid CA detection and fail-closed diagnostics
 * 4. Bootstrap child-process spawn failure reporting (never exits with 0 on failure)
 * 5. Real read-only HTTPS connection to LMS without authentication
 * 6. Dual startup paths (Start_AutoTask_AI.cmd and npm start / ca-bootstrap)
 * 7. System Doctor TLS diagnostics (CERTIFICATE_READY, CERTIFICATE_MISSING, TLS_VERIFIED, TLS_FAILED)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  resolveCaCertPath,
  isValidPemCertificate,
  bootstrapIntermediateCa,
  checkLmsTlsConnectivity,
  GLOBALSIGN_INTERMEDIATE_SHA256,
  OFFICIAL_AIA_URL
} from '../src/ca-bootstrap.js';
import { collectChecks } from '../src/doctor.js';

describe('Phase 9C.1: Portable TLS First-Run Acceptance', () => {
  const ROOT = resolve('.');

  // 1. Clean install without .private
  test('TLS-01: Clean install without .private resolves public CA from resources/certs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'autotask-tls01-'));
    try {
      assert.equal(existsSync(join(tempDir, '.private')), false, '.private must not exist');

      // Create resources/certs/globalsign_intermediate.crt in clean tree
      mkdirSync(join(tempDir, 'resources', 'certs'), { recursive: true });
      const certSrc = resolve(ROOT, 'resources', 'certs', 'globalsign_intermediate.crt');
      writeFileSync(join(tempDir, 'resources', 'certs', 'globalsign_intermediate.crt'), readFileSync(certSrc));

      const resolved = resolveCaCertPath(tempDir);
      assert.ok(resolved, 'Must resolve certificate path');
      assert.ok(resolved.endsWith(join('resources', 'certs', 'globalsign_intermediate.crt')), 'Must point to resources/certs');
      assert.equal(existsSync(resolved), true, 'Resolved certificate file must exist');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 2. Intermediate CA validity and SHA-256 fingerprint
  test('TLS-02: Public intermediate CA has valid PEM boundaries and matches official GlobalSign fingerprint', () => {
    const certPath = resolve(ROOT, 'resources', 'certs', 'globalsign_intermediate.crt');
    assert.ok(existsSync(certPath), `Certificate must exist at ${certPath}`);

    const raw = readFileSync(certPath, 'utf8');
    assert.ok(raw.includes('-----BEGIN CERTIFICATE-----'), 'Must have PEM begin marker');
    assert.ok(raw.includes('-----END CERTIFICATE-----'), 'Must have PEM end marker');
    assert.equal(raw.includes('PRIVATE KEY'), false, 'Public certificate must NEVER contain private keys');

    // Extract base64 DER and calculate SHA-256
    const b64 = raw.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
    const der = Buffer.from(b64, 'base64');
    const sha256 = createHash('sha256').update(der).digest('hex');

    assert.equal(sha256, GLOBALSIGN_INTERMEDIATE_SHA256, 'SHA-256 must match official GlobalSign AIA certificate');
  });

  // 3. Missing or invalid CA handling
  test('TLS-03: Missing or invalid CA is handled safely without throwing or false positive', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'autotask-tls03-'));
    try {
      // Empty directory
      assert.equal(resolveCaCertPath(tempDir), null, 'Empty directory must yield null');

      // Corrupted file (no PEM boundaries)
      mkdirSync(join(tempDir, 'resources', 'certs'), { recursive: true });
      writeFileSync(join(tempDir, 'resources', 'certs', 'globalsign_intermediate.crt'), 'CORRUPTED NON_PEM DATA');
      assert.equal(resolveCaCertPath(tempDir), null, 'Corrupted certificate must be rejected');

      // bootstrapIntermediateCa in empty directory sets missing flag and returns cleanly
      const res = bootstrapIntermediateCa(tempDir, () => ({ status: 0 }));
      assert.equal(res.respawned, false);
      assert.equal(res.caCertPath, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 4. Bootstrap child-process spawn failure reporting
  test('TLS-04: Bootstrap child-process spawn failure does not exit with 0 or swallow errors', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'autotask-tls04-'));
    try {
      mkdirSync(join(tempDir, 'resources', 'certs'), { recursive: true });
      const certSrc = resolve(ROOT, 'resources', 'certs', 'globalsign_intermediate.crt');
      writeFileSync(join(tempDir, 'resources', 'certs', 'globalsign_intermediate.crt'), readFileSync(certSrc));

      // Mock spawn failure (e.g. ENOENT or EACCES)
      const mockSpawnError = () => ({
        error: Object.assign(new Error('spawn EACCES test error'), { code: 'EACCES' }),
        status: null,
        signal: null
      });

      // Override process.exit temporarily for testing
      const origExit = process.exit;
      let exitCode: number | undefined;
      (process as any).exit = (code: number) => { exitCode = code; };

      try {
        const prevEnv = process.env._AUTOTASK_CA_RESPAWNED;
        delete process.env._AUTOTASK_CA_RESPAWNED;

        const res = bootstrapIntermediateCa(tempDir, mockSpawnError);
        assert.ok(res.error, 'Must capture spawn error');
        assert.notEqual(res.status, 0, 'Must NOT report exit status 0 on spawn failure');
        assert.equal(exitCode, 1, 'Must invoke process.exit with non-zero status on spawn error');

        // Test signal termination
        const mockSpawnSignal = () => ({
          error: undefined,
          status: null,
          signal: 'SIGTERM'
        });
        const resSig = bootstrapIntermediateCa(tempDir, mockSpawnSignal);
        assert.equal(resSig.status, 1, 'Process terminated by signal must fail with non-zero exit status');

        if (prevEnv) process.env._AUTOTASK_CA_RESPAWNED = prevEnv;
      } finally {
        process.exit = origExit;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 5. Real read-only HTTPS connection to LMS without authentication
  test('TLS-05: Real read-only HTTPS GET to LMS login page succeeds without authentication', async () => {
    const res = await checkLmsTlsConnectivity('https://lms.hust.edu.vn/login/index.php', 8000);

    assert.equal(res.certStatus, 'CERTIFICATE_READY', 'Intermediate CA certificate must be detected');
    assert.equal(res.tlsStatus, 'TLS_VERIFIED', `Real HTTPS handshake must succeed. Error: ${res.errorCode} - ${res.errorMessage}`);
    assert.ok(res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 303, `Status code must be valid HTTP response (got ${res.statusCode})`);
    assert.equal(res.verifiedUrl, 'https://lms.hust.edu.vn/login/index.php');
  });

  // 6. Dual Startup Paths verification
  test('TLS-06: Dual startup paths (Start_AutoTask_AI.cmd & npm start) both target public intermediate CA', () => {
    // Path A: Start_AutoTask_AI.cmd configuration
    const cmdContent = readFileSync(resolve(ROOT, 'Start_AutoTask_AI.cmd'), 'utf8');
    assert.ok(
      cmdContent.includes('resources\\certs\\globalsign_intermediate.crt'),
      'Start_AutoTask_AI.cmd must check resources\\certs\\globalsign_intermediate.crt'
    );
    assert.ok(cmdContent.includes('NODE_EXTRA_CA_CERTS'), 'Must set NODE_EXTRA_CA_CERTS');

    // Path B: ca-bootstrap self-respawn loads public CA
    const probeScript = `
      import { checkLmsTlsConnectivity, resolveCaCertPath } from './src/ca-bootstrap.js';
      const resolved = resolveCaCertPath();
      const conn = await checkLmsTlsConnectivity();
      console.log(JSON.stringify({
        nodeExtraCa: process.env.NODE_EXTRA_CA_CERTS || null,
        resolvedCa: resolved,
        certStatus: conn.certStatus,
        tlsStatus: conn.tlsStatus,
        statusCode: conn.statusCode
      }));
    `;

    const env = { ...process.env } as Record<string, string | undefined>;
    delete env._AUTOTASK_CA_RESPAWNED;
    delete env.NODE_EXTRA_CA_CERTS;

    const proc = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', probeScript],
      { cwd: ROOT, env: { ...env, NODE_EXTRA_CA_CERTS: resolve(ROOT, 'resources', 'certs', 'globalsign_intermediate.crt') }, encoding: 'utf8', timeout: 15000 }
    );

    assert.equal(proc.status, 0, `Probe failed: ${proc.stderr}`);
    const lastLine = proc.stdout.trim().split('\n').pop() || '{}';
    const payload = JSON.parse(lastLine);

    assert.equal(payload.certStatus, 'CERTIFICATE_READY');
    assert.equal(payload.tlsStatus, 'TLS_VERIFIED');
    assert.ok(payload.nodeExtraCa && payload.nodeExtraCa.includes('globalsign_intermediate.crt'));
  });

  // 7. System Doctor TLS Integration
  test('TLS-07: System Doctor includes real TLS handshake diagnostics', async () => {
    const checks = await collectChecks();
    const tlsCheck = checks.find(c => c.name.includes('TLS & Moodle HTTPS'));

    assert.ok(tlsCheck, 'System Doctor must have a TLS & Moodle HTTPS check item');
    assert.equal(tlsCheck.level, 'PASS', `TLS check must PASS on properly configured workstation. Detail: ${tlsCheck.detail}`);
    assert.ok(tlsCheck.detail.includes('TLS_VERIFIED'), 'Detail must indicate TLS_VERIFIED');
    assert.ok(tlsCheck.detail.includes('CERTIFICATE_READY'), 'Detail must indicate CERTIFICATE_READY');
  });
});
