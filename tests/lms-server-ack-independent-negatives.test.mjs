/**
 * AutoTask AI v1.1.6 — independent server ACK negative regressions.
 *
 * Run from extracted project root:
 *   node scripts/offline-build.cjs
 *   node --test AUTOTASK_V116_SERVER_ACK_INDEPENDENT_NEGATIVES.test.mjs
 *
 * Isolated local tests. No real LMS or API calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { fillMoodleFileManager } = await import(
  pathToFileURL(
    resolve('dist/src/lms/advanced-adapters.js')
  ).href
);

const question = {
  id: 'm1_att',
  kind: 'moodle-file',
  prompt: 'Attach report',
  options: []
};

async function withFixture(responseFactory, verify) {
  const dir = mkdtempSync(
    join(tmpdir(), 'autotask-ack-independent-')
  );

  try {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, '%PDF-1.4 distinct file content');

    let uploaded = false;
    let predicateAccepted = null;

    const content = {
      evaluate: async () => ({
        found: uploaded,
        hasMetadata: false,
        sha256Match: null,
        sizeMatch: null
      })
    };

    const manager = {
      count: async () => 1,
      locator: s => s === '.fp-content'
        ? content
        : { click: async () => {} }
    };

    const response = responseFactory();

    const target = {
      keyboard: {},

      url: () =>
        'http://localhost:34567/mod/quiz/attempt.php',

      waitForResponse: async predicate => {
        predicateAccepted = predicate(response);

        if (predicateAccepted) return response;
        throw new Error('no matching upload response');
      },

      locator: s =>
        s.includes('data-atqa-id')
          ? manager
          : s.includes('fp-upload-form input')
            ? {
                count: async () => 1,
                setInputFiles: async () => {}
              }
            : {},

      getByText: () => ({
        first: () => ({
          count: async () => 1,
          click: async () => {}
        })
      }),

      getByRole: () => ({
        first: () => ({
          count: async () => 1,
          click: async () => {
            uploaded = true;
          }
        })
      })
    };

    await verify({
      target,
      file,
      predicateAccepted: () => predicateAccepted
    });

    assert.equal(
      uploaded,
      true,
      'The test must attempt the upload'
    );
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}

const answer = file => ({
  id: question.id,
  localFilePath: file
});

test(
  'ACK-03: non-JSON response cannot prove upload acceptance',
  async () => {
    await withFixture(
      () => ({
        url: () =>
          'http://localhost:34567/repository/repository_ajax.php?action=upload',

        request: () => ({
          method: () => 'POST'
        }),

        status: () => 200,

        json: async () => {
          throw Error('Unexpected token < in JSON');
        }
      }),

      async ({ target, file }) => {
        await assert.rejects(
          fillMoodleFileManager(
            target,
            question,
            answer(file)
          ),
          /invalid|parse|json|response|not verified|upload|server/i
        );
      }
    );
  }
);

test(
  'ACK-04: unrelated GET must not count as upload ACK',
  async () => {
    await withFixture(
      () => ({
        url: () =>
          'http://localhost:34567/repository/repository_ajax.php?action=list',

        request: () => ({
          method: () => 'GET'
        }),

        status: () => 200,

        json: async () => ({
          items: []
        })
      }),

      async ({ target, file, predicateAccepted }) => {
        await assert.rejects(
          fillMoodleFileManager(
            target,
            question,
            answer(file)
          ),
          /response|timeout|upload|not verified|server/i
        );

        assert.equal(
          predicateAccepted(),
          false,
          'The response filter must reject an unrelated GET'
        );
      }
    );
  }
);

test(
  'ACK-05: empty JSON cannot prove file persistence',
  async () => {
    await withFixture(
      () => ({
        url: () =>
          'http://localhost:34567/repository/repository_ajax.php?action=upload',

        request: () => ({
          method: () => 'POST'
        }),

        status: () => 200,

        json: async () => ({})
      }),

      async ({ target, file }) => {
        await assert.rejects(
          fillMoodleFileManager(
            target,
            question,
            answer(file)
          ),
          /not verified|response|upload|server|identity|ack/i
        );
      }
    );
  }
);
