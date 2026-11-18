/**
 * AutoTask AI v1.1.6 — ACK-06/07/08.
 * Run from extracted project root:
 *   node scripts/offline-build.cjs
 *   node --test AUTOTASK_ACK_CORRELATION_FOLLOWUP.test.mjs
 *
 * No real LMS, network, credentials or Playwright.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync
} from 'node:fs';
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

async function fixture(response, verify) {
  const dir = mkdtempSync(
    join(tmpdir(), 'atqa-ack-correlation-')
  );

  try {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, '%PDF-1.4 test content');

    let clicked = false;
    let matched = null;

    const content = {
      evaluate: async () => ({
        found: clicked,
        hasMetadata: false,
        sha256Match: null,
        sizeMatch: null
      })
    };

    const manager = {
      count: async () => 1,

      getAttribute: async attr =>
        attr === 'data-itemid'
          ? '9876543210'
          : null,

      locator: selector =>
        selector === '.fp-content'
          ? content
          : { click: async () => {} }
    };

    const page = {
      keyboard: {},

      url: () =>
        'http://localhost:34567/mod/quiz/attempt.php',

      waitForResponse: async predicate => {
        matched = predicate(response);

        if (matched) return response;

        throw Error('no matching upload response');
      },

      locator: selector => {
        if (selector.includes('data-atqa-id')) {
          return manager;
        }

        if (selector.includes('draftitemid')) {
          return {
            inputValue: async () => '9876543210',
            getAttribute: async () => '9876543210'
          };
        }

        if (selector.includes('fp-upload-form input')) {
          return {
            count: async () => 1,
            setInputFiles: async () => {}
          };
        }

        return {};
      },

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
            clicked = true;
          }
        })
      })
    };

    await verify({
      page,
      file,
      matched: () => matched
    });

    assert.equal(
      clicked,
      true,
      'Test must reach the upload action'
    );
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}

function response(
  url,
  json,
  body = 'repo_upload_file=report.pdf&itemid=9876543210'
) {
  return {
    url: () => url,

    request: () => ({
      method: () => 'POST',
      postData: () => body
    }),

    status: () => 200,
    json: async () => json
  };
}

const upload = (page, file) =>
  fillMoodleFileManager(
    page,
    question,
    {
      id: question.id,
      localFilePath: file
    }
  );

test(
  'ACK-06: status ok without file/draft identity ' +
  'cannot verify persistence',
  async () => {
    await fixture(
      response(
        'http://localhost:34567/repository/repository_ajax.php?action=upload',
        { status: 'ok' }
      ),

      async ({ page, file }) => {
        await assert.rejects(
          upload(page, file),
          'Bare success status and optimistic DOM are insufficient'
        );
      }
    );
  }
);

test(
  'ACK-07: cross-origin POST response ' +
  'must not verify local LMS upload',
  async () => {
    await fixture(
      response(
        'https://unrelated.example/repository/repository_ajax.php?action=upload',
        {
          status: 'ok',
          filename: 'report.pdf'
        }
      ),

      async ({ page, file, matched }) => {
        await assert.rejects(
          upload(page, file),
          'Cross-origin response must not verify upload'
        );

        assert.equal(
          matched(),
          false,
          'Response predicate must reject other origins'
        );
      }
    );
  }
);

test(
  'ACK-08: ACK for another draft itemid ' +
  'must not verify this widget',
  async () => {
    await fixture(
      response(
        'http://localhost:34567/repository/repository_ajax.php?action=upload',
        {
          status: 'ok',
          filename: 'report.pdf',
          itemid: 'OTHER_DRAFT'
        },
        'repo_upload_file=report.pdf&itemid=OTHER_DRAFT'
      ),

      async ({ page, file }) => {
        await assert.rejects(
          upload(page, file),
          'Different draft itemid must not verify this widget'
        );
      }
    );
  }
);
