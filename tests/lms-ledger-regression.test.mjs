/**
 * Independent ledger regression tests (LEDGER-01..03).
 *
 * Run from the AutoTask AI project root:
 *
 * node scripts/offline-build.cjs
 * node --test tests/lms-ledger-regression.test.mjs
 *
 * Uses isolated temporary directories.
 * Does not connect to real LMS accounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(process.cwd(), 'dist/src/quiz-start-policy.js')
).href;

function isolateCase(caseName) {
  const dir = mkdtempSync(
    path.join(tmpdir(), 'autotask-audit-ledger-')
  );

  const script = `
    import fs from 'node:fs';

    const {
      evaluateQuizStartPolicy,
      resetStartGrantLedger
    } = await import(${JSON.stringify(moduleUrl)});

    fs.mkdirSync('.private', { recursive: true });

    const f = '.private/durable-start-grants.json';

    if (process.env.CASE === 'unwritable') {
      fs.mkdirSync(f);
    }

    if (process.env.CASE === 'corrupt') {
      fs.writeFileSync(f, '{INVALID_JSON');
    }

    if (process.env.CASE === 'reset') {
      fs.writeFileSync(
        f,
        JSON.stringify({
          used: {
            taskId: 'a',
            grantKey: 'used',
            consumedAt: '2026-01-01'
          }
        })
      );
    }

    if (process.env.CASE === 'reset') {
      resetStartGrantLedger();

      console.log(JSON.stringify({
        exists: fs.existsSync(f)
      }));
    } else {
      const page = {
        url: () =>
          'https://lms.hust.edu.vn/mod/quiz/view.php?id=55',
        title: async () => 'Ungraded practice'
      };

      const inspection = {
        hasContinueAttemptControl: false,
        hasNewAttemptControl: true,
        newAttemptLabel: 'Attempt quiz now',
        hasStartAttemptForm: true,
        exhaustedAttempts: false,
        scope: 'PRACTICE_VERIFIED',
        scopeEvidence: 'ungraded practice'
      };

      const task = {
        id: 'audit-ledger-case',
        title: 'Ungraded practice',
        url: page.url(),
        aiPermitted: true,
        confirmStartNewAttempt: true
      };

      const config = {
        allowedHosts: ['lms.hust.edu.vn'],
        approvedForAIUse: true,
        operationMode: 'PRACTICE_ASSISTED',
        parallelTabs: 1,
        tasks: [],
        provider: {
          kind: 'openai-compatible',
          model: 'test'
        }
      };

      const decision = await evaluateQuizStartPolicy({
        page,
        task,
        config,
        platform: 'moodle',
        inspection
      });

      console.log(JSON.stringify({
        action: decision.action,
        code: decision.code,
        ledgerIsFile: fs.statSync(f).isFile()
      }));
    }
  `;

  try {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CASE: caseName
        },
        timeout: 12000
      }
    );

    assert.equal(
      r.status,
      0,
      `Subprocess failure: ${r.stderr}`
    );

    return JSON.parse(
      r.stdout.trim().split('\n').at(-1)
    );
  } finally {
    rmSync(dir, {
      force: true,
      recursive: true
    });
  }
}

test(
  'LEDGER-01: storage write failure MUST deny start',
  () => {
    const got = isolateCase('unwritable');

    assert.notEqual(
      got.action,
      'START_NEW_ATTEMPT',
      `Denied disk-write still authorized a new attempt: ${JSON.stringify(got)}`
    );
  }
);

test(
  'LEDGER-02: malformed ledger MUST fail closed',
  () => {
    const got = isolateCase('corrupt');

    assert.notEqual(
      got.action,
      'START_NEW_ATTEMPT',
      `Corrupt ledger still authorized a new attempt: ${JSON.stringify(got)}`
    );
  }
);

test(
  'LEDGER-03: test reset MUST NOT delete durable consent history',
  () => {
    const got = isolateCase('reset');

    assert.equal(
      got.exists,
      true,
      'Calling resetStartGrantLedger deleted the durable start-grant file'
    );
  }
);
