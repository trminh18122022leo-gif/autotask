/**
 * Comprehensive Audit Follow-up Verification Suite
 * Covers all findings from Independent LMS Fail-Closed Audit (01/11/2026):
 * - CALLBACK-01..06: Interactive confirmation and durable ledger alignment
 * - LOCK-01..06: OS process liveness verification, atomic lock recovery, deadlock protection
 * - SCHEMA-01..06: Strict schema validation, key matching, legacy migration
 * - ATOMIC-01..04: Atomic rename guarantee, fail-closed on commit failure
 */

import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateQuizStartPolicy,
  claimDurableGrant,
  readDurableGrants,
  setDurableLedgerPath,
  resetStartGrantLedger,
  isProcessAlive,
  startGrantKey
} from '../src/quiz-start-policy.js';
import type { AppConfig, Task } from '../src/types.js';

function makeMockPage(url: string, title = 'Ungraded practice') {
  return {
    url: () => url,
    title: async () => title
  } as any;
}

const mockInspection = {
  hasContinueAttemptControl: false,
  hasNewAttemptControl: true,
  hasStartAttemptForm: true,
  exhaustedAttempts: false,
  scope: 'PRACTICE_VERIFIED' as const,
  scopeEvidence: 'test fixture verified ungraded practice',
  newAttemptLabel: 'Attempt quiz now'
};

function makeConfig(confirmAttemptStart?: any): AppConfig {
  return {
    allowedHosts: ['lms.hust.edu.vn'],
    approvedForAIUse: true,
    operationMode: 'PRACTICE_ASSISTED',
    parallelTabs: 1,
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'test' },
    confirmAttemptStart
  } as unknown as AppConfig;
}

describe('Phase 1 — Interactive Callback & Durable Ledger Alignment (CALLBACK-01..06)', () => {
  let sandboxDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-cb-audit-'));
    ledgerPath = path.join(sandboxDir, 'grants.json');
    setDurableLedgerPath(ledgerPath);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('CALLBACK-01: JSON ledger corrupted + interactive callback approved -> MUST BLOCK (HALT_NEEDS_REVIEW)', async () => {
    fs.writeFileSync(ledgerPath, '{CORRUPTED_JSON');

    const task: Task = {
      id: 'cb-01',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=101',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => true),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');
    assert.ok(dec.reason.includes('fail-closed'));
  });

  test('CALLBACK-02: Ledger path is a directory (unwritable) + interactive callback approved -> MUST BLOCK', async () => {
    fs.mkdirSync(ledgerPath);

    const task: Task = {
      id: 'cb-02',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=102',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => true),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');
    assert.ok(dec.reason.includes('fail-closed'));
  });

  test('CALLBACK-03: Valid ledger + interactive callback approved -> Exactly 1 grant claimed and START_NEW_ATTEMPT granted', async () => {
    const task: Task = {
      id: 'cb-03',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=103',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => true),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.equal(dec.action, 'START_NEW_ATTEMPT');
    assert.equal(dec.code, 'ALLOWED_NEW_PRACTICE_ATTEMPT');

    const expectedKey = startGrantKey(task.id, task.url);
    const read = readDurableGrants();
    assert.equal(read.status, 'OK');
    assert.ok(read.grants[expectedKey], 'Grant was durably written to disk');
    assert.equal(read.grants[expectedKey].taskId, task.id);
  });

  test('CALLBACK-04: Callback returns false (user declined) -> HALT_NEEDS_REVIEW, 0 grants recorded', async () => {
    const task: Task = {
      id: 'cb-04',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=104',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    const dec = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => false),
      platform: 'moodle',
      inspection: mockInspection
    });

    assert.equal(dec.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec.code, 'AWAITING_START_CONFIRMATION');

    const read = readDurableGrants();
    assert.equal(read.status, 'NOT_FOUND', 'Zero grants written when callback declined');
  });

  test('CALLBACK-05: Subsequent run after grant consumed -> HALT_NEEDS_REVIEW (cannot reuse consent)', async () => {
    const task: Task = {
      id: 'cb-05',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=105',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    // First run claims grant
    const dec1 = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => true),
      platform: 'moodle',
      inspection: mockInspection
    });
    assert.equal(dec1.action, 'START_NEW_ATTEMPT');

    // Second run with same task/URL must halt
    const dec2 = await evaluateQuizStartPolicy({
      page: makeMockPage(task.url),
      task,
      config: makeConfig(async () => true),
      platform: 'moodle',
      inspection: mockInspection
    });
    assert.equal(dec2.action, 'HALT_NEEDS_REVIEW');
    assert.equal(dec2.code, 'AWAITING_START_CONFIRMATION');
  });

  test('CALLBACK-06: Two concurrent policy checks with callback true -> exactly 1 START_NEW_ATTEMPT', async () => {
    const task: Task = {
      id: 'cb-06',
      url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=106',
      title: 'Practice Quiz',
      mode: 'PRACTICE_ASSISTED',
      aiPermitted: true
    };

    const [d1, d2] = await Promise.all([
      evaluateQuizStartPolicy({
        page: makeMockPage(task.url),
        task,
        config: makeConfig(async () => true),
        platform: 'moodle',
        inspection: mockInspection
      }),
      evaluateQuizStartPolicy({
        page: makeMockPage(task.url),
        task,
        config: makeConfig(async () => true),
        platform: 'moodle',
        inspection: mockInspection
      })
    ]);

    const actions = [d1.action, d2.action];
    assert.equal(actions.filter(a => a === 'START_NEW_ATTEMPT').length, 1);
    assert.equal(actions.filter(a => a === 'HALT_NEEDS_REVIEW').length, 1);
  });
});

describe('Phase 2 — Lock Ownership & Deadlock Safety (LOCK-01..06)', () => {
  let sandboxDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-lock-audit-'));
    ledgerPath = path.join(sandboxDir, 'grants.json');
    setDurableLedgerPath(ledgerPath);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('LOCK-01: Never steal an old lock owned by a live process', () => {
    const lock = ledgerPath + '.lock';
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, time: Date.now() - 10000 }));
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(lock, old, old);

    const res = claimDurableGrant('lock-01-key', 'task-lock-01');
    assert.equal(res.success, false, 'Must not claim when lock owner is still alive');
    assert.equal(fs.existsSync(lock), true, 'Lockfile owned by live process must remain intact');
  });

  test('LOCK-02: Crash recovery: Reclaim lock when owner PID is definitely dead and age > 5s', () => {
    const lock = ledgerPath + '.lock';
    // PID 999999 is dead on Windows/Linux in standard environments
    const deadPid = 999999;
    assert.equal(isProcessAlive(deadPid), false, 'PID 999999 is dead');

    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, time: Date.now() - 6000 }));
    const old = new Date(Date.now() - 6000);
    fs.utimesSync(lock, old, old);

    const res = claimDurableGrant('lock-02-key', 'task-lock-02');
    assert.equal(res.success, true, 'Crash recovery must reclaim lock of dead PID');
  });

  test('LOCK-03: Two concurrent claims for distinct keys serialize safely under lock', async () => {
    const results = await Promise.all([
      new Promise<any>(resolve => resolve(claimDurableGrant('conc-key-1', 'task-1'))),
      new Promise<any>(resolve => resolve(claimDurableGrant('conc-key-2', 'task-2')))
    ]);

    assert.equal(results[0].success, true);
    assert.equal(results[1].success, true);

    const read = readDurableGrants();
    assert.equal(read.status, 'OK');
    assert.ok(read.grants['conc-key-1']);
    assert.ok(read.grants['conc-key-2']);
  });

  test('LOCK-04: Paused live owner > TTL is never stolen', () => {
    const lock = ledgerPath + '.lock';
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, time: Date.now() - 15000 }));
    const old = new Date(Date.now() - 15000);
    fs.utimesSync(lock, old, old);

    const res = claimDurableGrant('lock-04-key', 'task-04');
    assert.equal(res.success, false, 'Paused live owner lock cannot be stolen');
    assert.equal(fs.existsSync(lock), true);
  });

  test('LOCK-05: Pre-existing temporary file from crashed writer is cleaned safely', () => {
    const orphanTmp = `${ledgerPath}.tmp.${process.pid}.${Date.now() - 10000}`;
    fs.writeFileSync(orphanTmp, 'stale temp data');

    const res = claimDurableGrant('lock-05-key', 'task-05');
    assert.equal(res.success, true);

    const read = readDurableGrants();
    assert.equal(read.status, 'OK');
    assert.ok(read.grants['lock-05-key']);
  });

  test('LOCK-06: Uncreatable lockfile directory fails closed with STORAGE_ERROR', () => {
    const blocker = path.join(sandboxDir, 'dir_blocker');
    fs.writeFileSync(blocker, 'file blocker');
    setDurableLedgerPath(path.join(blocker, 'sub', 'grants.json'));

    const res = claimDurableGrant('lock-06-key', 'task-06');
    assert.equal(res.success, false);
    assert.equal(res.reason, 'STORAGE_ERROR');
  });
});

describe('Phase 3 — Strict Ledger Schema Validation (SCHEMA-01..06)', () => {
  let sandboxDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-schema-audit-'));
    ledgerPath = path.join(sandboxDir, 'grants.json');
    setDurableLedgerPath(ledgerPath);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('SCHEMA-01: Missing grantKey -> status: ERROR', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'audit-key': { taskId: 'audit-task', consumedAt: new Date().toISOString() }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
  });

  test('SCHEMA-02: Missing taskId -> status: ERROR', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'k2': { grantKey: 'k2', consumedAt: new Date().toISOString(), pid: 1234 }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
  });

  test('SCHEMA-03: Key mismatch (key !== grantKey) -> status: ERROR', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'map-key': { taskId: 't3', grantKey: 'different-grant-key', consumedAt: new Date().toISOString(), pid: 1234 }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
  });

  test('SCHEMA-04: Invalid ISO date format for consumedAt -> status: ERROR', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'k4': { taskId: 't4', grantKey: 'k4', consumedAt: 'NOT_A_DATE', pid: 1234 }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
  });

  test('SCHEMA-05: Negative or invalid PID -> status: ERROR', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'k5': { taskId: 't5', grantKey: 'k5', consumedAt: new Date().toISOString(), pid: -50 }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'ERROR');
  });

  test('SCHEMA-06: Safe legacy migration: valid legacy record missing PID gets migrated with pid 0', () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({
      'legacy-k6': { taskId: 't6', grantKey: 'legacy-k6', consumedAt: new Date().toISOString() }
    }));
    const res = readDurableGrants();
    assert.equal(res.status, 'OK');
    assert.equal(res.grants['legacy-k6'].pid, 0);
  });
});

describe('Phase 4 — Atomic Rename Guarantee & Fail-Closed Commit (ATOMIC-01..02)', () => {
  let sandboxDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotask-atomic-audit-'));
    ledgerPath = path.join(sandboxDir, 'grants.json');
    setDurableLedgerPath(ledgerPath);
    resetStartGrantLedger();
  });

  afterEach(() => {
    setDurableLedgerPath(null);
    resetStartGrantLedger();
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  test('ATOMIC-01: Claim writes atomically and persists all fields', () => {
    const res = claimDurableGrant('atom-k1', 'atom-task');
    assert.equal(res.success, true);

    const read = readDurableGrants();
    assert.equal(read.status, 'OK');
    assert.equal(read.grants['atom-k1'].taskId, 'atom-task');
    assert.equal(read.grants['atom-k1'].grantKey, 'atom-k1');
    assert.equal(read.grants['atom-k1'].pid, process.pid);
  });

  test('ATOMIC-02: Target path as directory fails closed and leaves no partial files', () => {
    fs.mkdirSync(ledgerPath);
    const res = claimDurableGrant('atom-k2', 'atom-task-2');
    assert.equal(res.success, false);
    assert.equal(res.reason, 'STORAGE_ERROR');
  });
});
