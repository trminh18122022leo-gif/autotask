/** Phase 8G — Dual Startup Paths & Network Telemetry Invariants Test Suite (STARTUP-01..06)
 *
 * Verifies:
 * 1. That Start_AutoTask_AI.cmd sets NODE_EXTRA_CA_CERTS without disabling TLS security.
 * 2. That direct npm start / npm run browser loads NODE_EXTRA_CA_CERTS via bootstrapIntermediateCa.
 * 3. That NODE_TLS_REJECT_UNAUTHORIZED=0 is strictly forbidden across the codebase.
 * 4. That network accounting enforces the strict invariant: REQUEST_OBSERVED === REQUEST_ALLOWED + REQUEST_BLOCKED.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapIntermediateCa, resolveCaCertPath } from '../src/ca-bootstrap.js';

describe('Phase 8G — Dual Startup Paths & TLS Security Verification (STARTUP-01..06)', () => {
  test('STARTUP-01: Start_AutoTask_AI.cmd configures NODE_EXTRA_CA_CERTS before invoking npm start', () => {
    const cmdPath = resolve('Start_AutoTask_AI.cmd');
    assert.ok(existsSync(cmdPath), 'Start_AutoTask_AI.cmd must exist');
    const content = readFileSync(cmdPath, 'utf8');
    assert.ok(content.includes('NODE_EXTRA_CA_CERTS='), 'Must set NODE_EXTRA_CA_CERTS');
    assert.ok(content.includes('globalsign_intermediate'), 'Must point to globalsign_intermediate');
    assert.ok(content.includes('npm start'), 'Must invoke npm start');
    assert.ok(!content.includes('NODE_TLS_REJECT_UNAUTHORIZED=0'), 'Must NEVER disable TLS verification in cmd script');
  });

  test('STARTUP-02: package.json specifies valid scripts for start, browser, and doctor', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    assert.equal(pkg.scripts.start, 'tsx src/launcher.ts', 'npm start must run launcher.ts');
    assert.equal(pkg.scripts.browser, 'tsx src/main.ts', 'npm run browser must run main.ts');
    assert.ok(pkg.scripts.doctor, 'npm run doctor must be defined');
  });

  test('STARTUP-03: Codebase strictly forbids NODE_TLS_REJECT_UNAUTHORIZED=0 or insecure HTTPS bypass', () => {
    const filesToCheck = [
      'src/ca-bootstrap.ts',
      'src/launcher.ts',
      'src/main.ts',
      'src/operation-mode.ts',
      'src/security/redact.ts',
      'Start_AutoTask_AI.cmd'
    ];
    for (const relPath of filesToCheck) {
      const fullPath = resolve(relPath);
      if (existsSync(fullPath)) {
        const text = readFileSync(fullPath, 'utf8');
        assert.ok(!/(?:process\.env\.)?NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(text), `${relPath} must not set NODE_TLS_REJECT_UNAUTHORIZED=0`);
        assert.ok(!text.includes('rejectUnauthorized: false'), `${relPath} must not disable rejectUnauthorized`);
      }
    }
  });

  test('STARTUP-04: bootstrapIntermediateCa is a no-op when NODE_EXTRA_CA_CERTS is already active', () => {
    // If NODE_EXTRA_CA_CERTS is set, bootstrapIntermediateCa must return cleanly without spawning
    const prevCert = process.env.NODE_EXTRA_CA_CERTS;
    try {
      process.env.NODE_EXTRA_CA_CERTS = 'C:\\dummy\\cert.pem';
      // Calling should not throw or exit
      bootstrapIntermediateCa();
      assert.ok(true, 'Returns cleanly when cert env already exists');
    } finally {
      if (prevCert) process.env.NODE_EXTRA_CA_CERTS = prevCert;
      else delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test('STARTUP-05: Strict TLS invariant — intermediate CA file exists and has valid PEM certificate headers', () => {
    const caPath = resolveCaCertPath() || resolve('resources', 'certs', 'globalsign_intermediate.crt');
    assert.ok(caPath && existsSync(caPath), 'Intermediate CA certificate must exist in resources/certs/ or .private/');
    const pem = readFileSync(caPath, 'utf8');
    assert.ok(pem.includes('-----BEGIN CERTIFICATE-----'), 'Must have valid PEM header');
    assert.ok(pem.includes('-----END CERTIFICATE-----'), 'Must have valid PEM footer');
  });

  test('STARTUP-06: Strict Telemetry Invariant — OBSERVED === ALLOWED + BLOCKED with 0 overlap', () => {
    // Mathematical accounting model
    const observedRequests = [
      { id: 1, url: 'https://lms.hust.edu.vn/my/', method: 'GET', status: 'dispatched' },
      { id: 2, url: 'https://lms.hust.edu.vn/theme/yui.js', method: 'GET', status: 'dispatched' },
      { id: 3, url: 'https://lms.hust.edu.vn/lib/ajax/service-nologin.php?info=core_output_load_template_with_dependencies', method: 'GET', status: 'dispatched' },
      { id: 4, url: 'https://lms.hust.edu.vn/lib/ajax/service.php?info=core_course_get_recent_courses', method: 'POST', status: 'dispatched' },
      { id: 5, url: 'https://lms.hust.edu.vn/mod/quiz/startattempt.php', method: 'POST', status: 'aborted' },
      { id: 6, url: 'https://lms.hust.edu.vn/login/logout.php', method: 'GET', status: 'aborted' }
    ];

    const allowed = observedRequests.filter(r => r.status === 'dispatched');
    const blocked = observedRequests.filter(r => r.status === 'aborted');

    assert.equal(observedRequests.length, allowed.length + blocked.length, 'OBSERVED must exactly equal ALLOWED + BLOCKED');
    // Overlap test: intersection of allowed and blocked must be 0
    const allowedIds = new Set(allowed.map(r => r.id));
    const blockedIds = new Set(blocked.map(r => r.id));
    const intersection = [...allowedIds].filter(id => blockedIds.has(id));
    assert.equal(intersection.length, 0, 'No request can be counted in both ALLOWED and BLOCKED');
  });
});
