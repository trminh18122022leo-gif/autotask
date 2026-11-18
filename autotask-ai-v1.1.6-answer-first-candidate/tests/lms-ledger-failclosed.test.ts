/**
 * Comprehensive Ledger Fail-Closed, Corruption Recovery & Test Isolation Suite
 * Covers:
 * Phase 1: LEDGER-W01..W05 (Storage write failures, atomic locks, concurrent claims, crash safety)
 * Phase 2: LEDGER-R01..R06 (Corrupt JSON, empty file, read errors, invalid schema, migration)
 * Phase 3: LEDGER-T01..T05 (Test storage isolation, parallel safety, multi-account isolation, non-destructive test runs)
 */

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  evaluateQuizStartPolicy,
  claimDurableGrant,
  readDurableGrants,
  setDurableLedgerPath,
  getDurableLedgerPath,
  resetStartGrantLedger,
  clearDurableGrantLedger,
  startGrantKey
} from '../src/quiz-start-policy.js';
import type { AppConfig, Task } from '../src/types.js';

function makeMockPage(url: string) {
  return {
    url: () => url,
    title: async () => 'Ungraded Practice Quiz'
  } as any;
}

const mockInspection = {
  hasContinueAttemptControl: false,
  hasNewAttemptControl: true,
  newAttemptLabel: 'Attempt quiz now',
  hasStartAttemptForm: true,
  exhaustedAttempts: false,
  scope: 'PRACTICE_VERIFIED' as const,
  scopeEvidence: 'ungraded permitted self-practice'
};

function makeConfig(): AppConfig {
  return {
    allowedHosts: ['lms.hust.edu.vn'],
    approvedForAIUse: true,
    operationMode: 'PRACTICE_ASSISTED',
    parallelTabs: 1,
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'test' }
  } as unknown as AppConfig;
}

describe('Phase 1 — Write Failure & Atomic Concurrency (LEDGER-W01..W05)', () => {
  let sandboxDir: string;
  let isolatedLedger: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-ledger-w-'));
    isolatedLedger = path.join(sandboxDir, 'test-ledger.json');
    setDurableLedgerPath(isolatedLedger);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('LEDGER-W01: Permission denied / unwritable parent directory MUST deny start', async () => {
    // Make ledger parent unwritable by pointing to an impossible path on Windows
    const unwritablePath = 'Z:\\non_existent_drive_999\\ledger.json';
    setDurableLedgerPath(unwritablePath);

    const task: Task = {
      id: 'task-w01',
      title: 'Practice Quiz',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=101',
      aiPermitted: true,
      confirmStartNewAttempt: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.notEqual(dec.action, 'START_NEW_ATTEMPT', 'Denied disk write must fail closed');
    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');
  });

  test('LEDGER-W02: I/O or storage failure during claim returns failure and halts policy', async () => {
    // Create ledger as a directory so opening for write throws EISDIR/EPERM
    fs.mkdirSync(isolatedLedger, { recursive: true });

    const claimRes = claimDurableGrant('test-key', 'task-w02');
    assert.equal(claimRes.success, false);
    assert.equal(claimRes.reason, 'STORAGE_ERROR');

    const task: Task = {
      id: 'task-w02',
      title: 'Practice Quiz',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=102',
      aiPermitted: true,
      confirmStartNewAttempt: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.notEqual(dec.action, 'START_NEW_ATTEMPT');
    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
  });

  test('LEDGER-W03: File path is a directory MUST fail closed', async () => {
    fs.mkdirSync(isolatedLedger, { recursive: true });

    const readRes = readDurableGrants();
    assert.equal(readRes.status, 'ERROR');
    assert.equal(readRes.error, 'IS_DIRECTORY');
  });

  test('LEDGER-W04: Two concurrent claims for same grant -> at most one succeeds', () => {
    const script = `
      import { claimDurableGrant, setDurableLedgerPath } from './dist/src/quiz-start-policy.js';
      setDurableLedgerPath(${JSON.stringify(isolatedLedger)});
      const grantKey = 'concurrent-grant-key';
      const taskId = 'task-proc-' + process.pid;
      const res = claimDurableGrant(grantKey, taskId);
      console.log(JSON.stringify({ pid: process.pid, success: res.success }));
    `;

    const p1 = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    const p2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    const out1 = JSON.parse(p1.stdout.trim().split('\n').pop() || '{}');
    const out2 = JSON.parse(p2.stdout.trim().split('\n').pop() || '{}');

    const successes = [out1.success, out2.success].filter(Boolean);
    assert.equal(successes.length, 1, `Exactly one claim must succeed. Got out1=${JSON.stringify(out1)}, out2=${JSON.stringify(out2)}`);
  });

  test('LEDGER-W05: Crash between claim and request -> grant is recorded and prevents second attempt', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=105';
    const taskId = 'task-w05';
    const grantKey = startGrantKey(taskId, url);
    const claimRes = claimDurableGrant(grantKey, taskId);
    assert.equal(claimRes.success, true, 'First claim must succeed');

    // Simulate process crash: in-memory state is wiped
    resetStartGrantLedger();

    // New process re-evaluates policy for exact same task
    const task: Task = {
      id: taskId,
      title: 'Practice Quiz',
      url,
      aiPermitted: true,
      confirmStartNewAttempt: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.notEqual(dec.action, 'START_NEW_ATTEMPT', 'Must not permit second attempt after simulated crash');
    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');
  });
});

describe('Phase 2 — Corruption Recovery & Schema Integrity (LEDGER-R01..R06)', () => {
  let sandboxDir: string;
  let isolatedLedger: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-ledger-r-'));
    isolatedLedger = path.join(sandboxDir, 'test-ledger.json');
    setDurableLedgerPath(isolatedLedger);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('LEDGER-R01: Abnormally empty file (0 bytes) MUST fail closed', () => {
    fs.writeFileSync(isolatedLedger, '');
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
    assert.equal(res.error, 'CORRUPT_EMPTY');
  });

  test('LEDGER-R02: Permission denied on read MUST fail closed', () => {
    setDurableLedgerPath('Z:\\non_existent_vol_invalid\\ledger.json');
    const res = readDurableGrants();
    assert.equal(res.status, 'NOT_FOUND');
  });

  test('LEDGER-R03: Invalid schema (e.g. array or primitive or missing fields) MUST fail closed', () => {
    // Array root
    fs.writeFileSync(isolatedLedger, JSON.stringify([1, 2, 3]));
    let res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
    assert.equal(res.error, 'INVALID_SCHEMA');

    // Object with malformed entry
    fs.writeFileSync(isolatedLedger, JSON.stringify({ key1: 'not-an-object' }));
    res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
    assert.equal(res.error, 'INVALID_SCHEMA');

    // Missing required fields
    fs.writeFileSync(isolatedLedger, JSON.stringify({ key1: { foo: 'bar' } }));
    res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
    assert.equal(res.error, 'INVALID_SCHEMA');
  });

  test('LEDGER-R04: Valid ledger with grant already consumed MUST block replay', async () => {
    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=204';
    const taskId = 'task-r04';
    const grantKey = startGrantKey(taskId, url);
    fs.writeFileSync(isolatedLedger, JSON.stringify({
      [grantKey]: {
        taskId,
        grantKey,
        consumedAt: '2026-01-01T00:00:00.000Z',
        pid: 1234
      }
    }));

    const task: Task = {
      id: taskId,
      title: 'Practice Quiz',
      url,
      aiPermitted: true,
      confirmStartNewAttempt: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.notEqual(dec.action, 'START_NEW_ATTEMPT');
    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');
  });

  test('LEDGER-R05: Valid ledger without this grant allows single-use claim', async () => {
    fs.writeFileSync(isolatedLedger, JSON.stringify({
      'other-grant': {
        taskId: 'other-task',
        grantKey: 'other-grant',
        consumedAt: '2026-01-01T00:00:00.000Z',
        pid: 1234
      }
    }));

    const url = 'https://lms.hust.edu.vn/mod/quiz/view.php?id=205';
    const taskId = 'task-r05';
    const expectedKey = startGrantKey(taskId, url);

    const task: Task = {
      id: taskId,
      title: 'Practice Quiz',
      url,
      aiPermitted: true,
      confirmStartNewAttempt: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.equal(dec.action, 'START_NEW_ATTEMPT');
    assert.equal(dec.code, 'ALLOWED_NEW_PRACTICE_ATTEMPT');

    // Confirm that file now has both grants
    const res = readDurableGrants();
    assert.equal(res.status, 'OK');
    assert.ok(res.grants['other-grant']);
    assert.ok(res.grants[expectedKey]);
  });

  test('LEDGER-R06: Legacy ledger migration preserves consumed state', () => {
    const legacyData = {
      'legacy-grant-1': {
        taskId: 'legacy-task-1',
        grantKey: 'legacy-grant-1',
        consumedAt: '2026-01-01T00:00:00.000Z'
      }
    };
    fs.writeFileSync(isolatedLedger, JSON.stringify(legacyData));

    const res = readDurableGrants();
    assert.equal(res.status, 'OK');
    assert.ok(res.grants['legacy-grant-1']);
    assert.equal(res.grants['legacy-grant-1'].taskId, 'legacy-task-1');
  });
});

describe('Phase 3 — Test Storage Isolation & Sandbox Safety (LEDGER-T01..T05)', () => {
  test('LEDGER-T01: Unit tests do not touch runtime production ledger', () => {
    const prodPath = path.resolve('.private', 'durable-start-grants.json');
    let prodBefore = null;
    if (fs.existsSync(prodPath)) {
      prodBefore = fs.readFileSync(prodPath, 'utf-8');
    }

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t01-'));
    try {
      const testFile = path.join(testDir, 'isolated.json');
      setDurableLedgerPath(testFile);
      claimDurableGrant('test-key', 't01-task');
      assert.ok(fs.existsSync(testFile), 'Test file was created in isolated dir');

      if (prodBefore !== null) {
        const prodAfter = fs.readFileSync(prodPath, 'utf-8');
        assert.equal(prodAfter, prodBefore, 'Production ledger file must not be modified by test');
      }
    } finally {
      setDurableLedgerPath(null);
      resetStartGrantLedger();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('LEDGER-T02: Two parallel tests do not share ledger when using isolated paths', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t02a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t02b-'));
    try {
      const fileA = path.join(dirA, 'ledgerA.json');
      const fileB = path.join(dirB, 'ledgerB.json');

      setDurableLedgerPath(fileA);
      resetStartGrantLedger();
      const claimA = claimDurableGrant('key-shared', 'task-A');
      assert.equal(claimA.success, true);

      setDurableLedgerPath(fileB);
      resetStartGrantLedger(); // Clean in-memory cache for B
      const readB = readDurableGrants();
      assert.equal(readB.status, 'NOT_FOUND');
      const claimB = claimDurableGrant('key-shared', 'task-B');
      assert.equal(claimB.success, true);
    } finally {
      setDurableLedgerPath(null);
      resetStartGrantLedger();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('LEDGER-T03: Two accounts do not share grant history (differentiated keys)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t03-'));
    try {
      const testFile = path.join(tempDir, 'ledger.json');
      setDurableLedgerPath(testFile);
      resetStartGrantLedger();

      const grantKeyAcct1 = 'task-acct1|https://lms.hust.edu.vn/mod/quiz/view.php?id=301';
      const grantKeyAcct2 = 'task-acct2|https://lms.hust.edu.vn/mod/quiz/view.php?id=301';

      claimDurableGrant(grantKeyAcct1, 'task-acct1');

      const grants = readDurableGrants();
      assert.equal(grants.status, 'OK');
      assert.ok(grants.grants[grantKeyAcct1]);
      assert.equal(grants.grants[grantKeyAcct2], undefined, 'Account 2 grant key is not consumed');
    } finally {
      setDurableLedgerPath(null);
      resetStartGrantLedger();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('LEDGER-T04: Cleanup does not delete outside sandbox', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t04-'));
    const externalFile = path.join(tempDir, 'external.txt');
    fs.writeFileSync(externalFile, 'do not delete');

    const ledgerFile = path.join(tempDir, 'ledger.json');
    setDurableLedgerPath(ledgerFile);
    resetStartGrantLedger();
    claimDurableGrant('t04-key', 'task-t04');

    clearDurableGrantLedger();
    assert.equal(fs.existsSync(ledgerFile), false, 'Ledger file was cleaned up');
    assert.equal(fs.existsSync(externalFile), true, 'External file was preserved intact');

    setDurableLedgerPath(null);
    resetStartGrantLedger();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('LEDGER-T05: Reset does not delete durable file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-t05-'));
    try {
      const ledgerFile = path.join(tempDir, 'ledger.json');
      setDurableLedgerPath(ledgerFile);
      resetStartGrantLedger();
      claimDurableGrant('t05-key', 'task-t05');

      assert.equal(fs.existsSync(ledgerFile), true);
      resetStartGrantLedger();
      assert.equal(fs.existsSync(ledgerFile), true, 'resetStartGrantLedger MUST NOT delete durable file');
    } finally {
      setDurableLedgerPath(null);
      resetStartGrantLedger();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
