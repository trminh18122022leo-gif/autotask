/** Independent follow-up audit regressions for AutoTask AI LMS Pilot Gate.
 * Copy this file to tests/lms-pilot-gate-followup.test.ts and run: npx tsx --test tests/lms-pilot-gate-followup.test.ts
 * These tests intentionally express the safer expected behavior and should be RED before remediation.
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
  allowedHosts: ['lms.hust.edu.vn'], approvedForAIUse: true, operationMode: mode,
  parallelTabs: 1, tasks: [], provider: { kind: 'openai-compatible', model: 'test-model' }
}) as unknown as AppConfig;
const task = (url: string, attrs: Partial<Task> = {}) => ({ id: 'self-practice-task', title: 'Practice Quiz', url, aiPermitted: true, ...attrs }) as Task;
function fakePage(url: string, body: string): Page {
  return { url: () => url, title: async () => 'Practice Quiz', evaluate: async () => body } as unknown as Page;
}

test('FOLLOWUP-01: policyCleared must NOT bypass newly observed graded-assessment metadata on the current page', async () => {
  const t = task(`${origin}/mod/quiz/view.php?id=101`);
  const p = fakePage(`${origin}/mod/quiz/attempt.php?attempt=202`, 'Midterm exam — Grading method: Highest grade — Grade to pass: 7/10');
  const d = await evaluateAttemptExecutionGate({ page: p, task: t, config: config('PRACTICE_ASSISTED'), platform: 'moodle', policyCleared: true });
  assert.equal(d.allowed, false, `Unexpectedly allowed graded attempt: ${JSON.stringify(d)}`);
});

test('FOLLOWUP-02: checkpoint approval for quiz 101 must NOT authorize a different quiz/attempt on the same origin', async () => {
  const t = task(`${origin}/mod/quiz/view.php?id=101`);
  const p = fakePage(`${origin}/mod/quiz/attempt.php?attempt=202`, 'Question: Sample item.');
  const checkpoint = {
    taskId: t.id, url: t.url,
    scopeVerified: {scope: 'PRACTICE_VERIFIED' as const, mode: 'PRACTICE_ASSISTED' as const, origin, verifiedAt: new Date().toISOString() }
  } as any;
  const d = await evaluateAttemptExecutionGate({ page: p, task: t, config: config('PRACTICE_ASSISTED'), platform: 'moodle', checkpoint, policyCleared: false });
  assert.equal(d.allowed, false, `Checkpoint unexpectedly authorized an unrelated attempt: ${JSON.stringify(d)}`);
});

test('FOLLOWUP-03: unset operation mode must NOT implicitly permit automated interaction on non-Moodle platforms', async () => {
  const t = task(`${origin}/practice/exercise`);
  const p = fakePage(`${origin}/practice/exercise`, 'Question: Sample item.');
  const d = await evaluateAttemptExecutionGate({ page: p, task: t, config: config(), platform: 'english-discoveries', policyCleared: false });
  assert.equal(d.allowed, false, `Unset mode unexpectedly authorized operation: ${JSON.stringify(d)}`);
});

test('FOLLOWUP-04: persisted confirmStartNewAttempt flag must NOT be reusable after an application restart', async () => {
  const tempLedger = join(tmpdir(), 'autotask-pilot-followup-' + Date.now() + '.json');
  setDurableLedgerPath(tempLedger);
  resetStartGrantLedger();
  const url = `${origin}/mod/quiz/view.php?id=101`;
  const t = task(url, { confirmStartNewAttempt: true });
  const p = fakePage(url, 'Practice Quiz — ungraded self-practice');
  const inspection = {
    hasContinueAttemptControl: false, hasNewAttemptControl: true, newAttemptLabel: 'Attempt quiz now',
    hasStartAttemptForm: true, exhaustedAttempts: false, scope: 'PRACTICE_VERIFIED' as const, scopeEvidence: 'explicit ungraded practice'
  };
  const first = await evaluateQuizStartPolicy({ page: p, task: t, config: config('PRACTICE_ASSISTED'), platform: 'moodle', inspection });
  assert.equal(first.action, 'START_NEW_ATTEMPT');
  resetStartGrantLedger(); // models a process restart: only in-process grant bookkeeping survives nowhere
  const second = await evaluateQuizStartPolicy({ page: p, task: t, config: config('PRACTICE_ASSISTED'), platform: 'moodle', inspection });
  assert.notEqual(second.action, 'START_NEW_ATTEMPT', `Stale persisted consent was reused after restart: ${JSON.stringify(second)}`);
});
