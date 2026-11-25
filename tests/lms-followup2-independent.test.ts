/** Independent follow-up 2 audit regressions for AutoTask AI LMS Pilot Gate.
 * Copy this file to tests/lms-followup2-independent.test.ts and run:
 *   npx tsx --test tests/lms-followup2-independent.test.ts
 * Baseline expectation before remediation: 0/3 PASS, 3/3 FAIL.
 * Uses only fabricated URL/page text and no network or real LMS account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { evaluateAttemptExecutionGate, evaluateQuizStartPolicy, resetStartGrantLedger, setDurableLedgerPath } from '../src/quiz-start-policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import type { AppConfig, Task } from '../src/types.js';

const origin = 'https://lms.hust.edu.vn';
const config = (mode?: 'READ_ONLY' | 'ASSESSMENT_RESTRICTED' | 'PRACTICE_ASSISTED') => ({
  allowedHosts: ['lms.hust.edu.vn'],
  approvedForAIUse: true,
  operationMode: mode,
  parallelTabs: 1,
  tasks: [],
  provider: { kind: 'openai-compatible', model: 'test-model' }
}) as unknown as AppConfig;

const task = (url: string, attrs: Partial<Task> = {}) => ({
  id: 'self-practice-task',
  title: 'Practice Quiz',
  url,
  aiPermitted: true,
  ...attrs
}) as Task;

function fakePage(url: string, body: string): Page {
  return {
    url: () => url,
    title: async () => 'Practice Quiz',
    evaluate: async () => body
  } as unknown as Page;
}

test('AUD-F2-01: policy-cleared task for quiz 55 must NOT authorize unlinked attempt 999 lacking cmid', async () => {
  const t = task(`${origin}/mod/quiz/view.php?id=55`);
  const p = fakePage(`${origin}/mod/quiz/attempt.php?attempt=999`, 'Question: Sample practice item.');
  const d = await evaluateAttemptExecutionGate({
    page: p,
    task: t,
    config: config('PRACTICE_ASSISTED'),
    platform: 'moodle',
    policyCleared: true
  });
  assert.equal(d.allowed, false, `Unexpectedly authorized unlinked attempt without cmid: ${JSON.stringify(d)}`);
});

test('AUD-F2-02: verified identity for attempt 77 must NOT authorize switched attempt 99 even with same cmid', async () => {
  const t = task(`${origin}/mod/quiz/view.php?id=55`, {
    verifiedAttemptIdentity: {
      canonicalOrigin: origin,
      pathname: '/mod/quiz/attempt.php',
      cmid: '55',
      attemptId: '77',
      taskId: 'self-practice-task'
    }
  });
  const p = fakePage(`${origin}/mod/quiz/attempt.php?attempt=99&cmid=55`, 'Question: Sample practice item.');
  const d = await evaluateAttemptExecutionGate({
    page: p,
    task: t,
    config: config('PRACTICE_ASSISTED'),
    platform: 'moodle',
    policyCleared: true
  });
  assert.equal(d.allowed, false, `Unexpectedly authorized switched attempt ID: ${JSON.stringify(d)}`);
});

test('AUD-F2-03: persisted config with confirmStartNewAttempt must NOT be reused across config reload / restart', async () => {
  const tempLedger = join(tmpdir(), 'autotask-f2-03-' + Date.now() + '.json');
  setDurableLedgerPath(tempLedger);
  resetStartGrantLedger();
  const configJson = JSON.stringify({
    id: 'task-consent-reload',
    confirmStartNewAttempt: true,
    url: `${origin}/mod/quiz/view.php?id=55`
  });
  const url = `${origin}/mod/quiz/view.php?id=55`;
  const p = fakePage(url, 'Practice Quiz — ungraded self-practice');
  const inspection = {
    hasContinueAttemptControl: false,
    hasNewAttemptControl: true,
    newAttemptLabel: 'Attempt quiz now',
    hasStartAttemptForm: true,
    exhaustedAttempts: false,
    scope: 'PRACTICE_VERIFIED' as const,
    scopeEvidence: 'explicit ungraded practice'
  };

  // Process A loads configuration from JSON
  const taskProcessA = JSON.parse(configJson);
  const first = await evaluateQuizStartPolicy({
    page: p,
    task: taskProcessA,
    config: config('PRACTICE_ASSISTED'),
    platform: 'moodle',
    inspection
  });
  assert.equal(first.action, 'START_NEW_ATTEMPT');

  // Process A terminates; Process B restarts and reloads config afresh from disk/JSON
  resetStartGrantLedger();
  const taskProcessB = JSON.parse(configJson); // Fresh load of the saved configuration
  const second = await evaluateQuizStartPolicy({
    page: p,
    task: taskProcessB,
    config: config('PRACTICE_ASSISTED'),
    platform: 'moodle',
    inspection
  });
  assert.notEqual(second.action, 'START_NEW_ATTEMPT', `Persisted boolean consent was reused after config reload: ${JSON.stringify(second)}`);
});
