import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkDuplicateRisk } from '../src/task-manager.js';

test('Duplicate Protection: checkDuplicateRisk correctly identifies fresh tasks', async () => {
  // Brand new task
  const fresh = await checkDuplicateRisk('fresh-task-001', 'https://example.com/fresh-quiz');
  assert.equal(fresh.isDuplicateRisk, false);
});

test('Duplicate Protection: checkDuplicateRisk flags previously completed submissions from actual report history', async () => {
  await mkdir('reports', { recursive: true });
  const testReportFile = resolve('reports', 'report-test-duplicate-history.json');
  const mockReport = {
    createdAt: new Date().toISOString(),
    results: [
      {
        id: 'prior-completed-task',
        url: 'https://lms.university.edu/mod/quiz/view.php?id=9999',
        title: 'Quiz 1 History',
        status: 'SUBMITTED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        questionsFound: 10,
        questionsFilled: 10,
        warnings: [],
        scoreObserved: '10.0 / 10.0'
      }
    ],
    deadlines: []
  };

  try {
    await writeFile(testReportFile, JSON.stringify(mockReport, null, 2), 'utf8');

    // 1. Same task ID and URL -> Must flag duplicate risk
    const riskBoth = await checkDuplicateRisk('prior-completed-task', 'https://lms.university.edu/mod/quiz/view.php?id=9999');
    assert.equal(riskBoth.isDuplicateRisk, true);
    assert.equal(riskBoth.previousStatus, 'SUBMITTED');
    assert.equal(riskBoth.previousScore, '10.0 / 10.0');
    assert.ok(riskBoth.message?.includes('prior-completed-task'));

    // 2. Same URL but different task ID -> Must flag duplicate risk (prevents re-submitting same form under new task ID)
    const riskUrl = await checkDuplicateRisk('new-alias-id', 'https://lms.university.edu/mod/quiz/view.php?id=9999');
    assert.equal(riskUrl.isDuplicateRisk, true);
    assert.equal(riskUrl.previousStatus, 'SUBMITTED');

    // 3. Different URL and different task ID -> Fresh task
    const clean = await checkDuplicateRisk('fresh-other-id', 'https://lms.university.edu/mod/quiz/view.php?id=8888');
    assert.equal(clean.isDuplicateRisk, false);
  } finally {
    await rm(testReportFile, { force: true }).catch(() => {});
  }
});
