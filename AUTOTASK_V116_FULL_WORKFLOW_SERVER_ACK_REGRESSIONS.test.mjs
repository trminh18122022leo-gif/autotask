/**
 * AutoTask AI v1.1.6 — Server acknowledgment regressions.
 * No real LMS, account or network requests.
 *
 * Run:
 * node scripts/offline-build.cjs
 * node --test AUTOTASK_V116_FULL_WORKFLOW_SERVER_ACK_REGRESSIONS.test.mjs
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

function fakeTarget(serverResponse) {
  let appeared = false;
  let clicks = 0;

  const content = {
    evaluate: async () => ({
      found: appeared,
      hasMetadata: false,
      sha256Match: null,
      sizeMatch: null
    })
  };

  const manager = {
    count: async () => 1,
    locator: selector =>
      selector === '.fp-content'
        ? content
        : { click: async () => {} }
  };

  const target = {
    keyboard: {},
    waitForResponse: async () => serverResponse,

    locator: selector =>
      selector.includes('data-atqa-id')
        ? manager
        : selector.includes('fp-upload-form input')
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
          clicks++;
          appeared = true;
        }
      })
    })
  };

  return { target, clicks: () => clicks };
}

async function withPdf(run) {
  const dir = mkdtempSync(
    join(tmpdir(), 'autotask-server-ack-')
  );

  try {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, '%PDF-1.4 audit sample');
    await run(file);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}

test(
  'ACK-01: HTTP 200 with error field and success=false must reject',
  async () => withPdf(async file => {
    const fx = fakeTarget({
      status: () => 200,
      json: async () => ({
        success: false,
        error: 'Quota exceeded'
      })
    });

    await assert.rejects(
      fillMoodleFileManager(
        fx.target,
        question,
        {
          id: question.id,
          localFilePath: file
        }
      ),
      /error|fail|not verified|server|quota/i,
      'Visible filename cannot override a server error'
    );

    assert.equal(fx.clicks(), 1);
  })
);

test(
  'ACK-02: missing server upload response must not be confirmed by UI alone',
  async () => withPdf(async file => {
    const fx = fakeTarget(null);

    await assert.rejects(
      fillMoodleFileManager(
        fx.target,
        question,
        {
          id: question.id,
          localFilePath: file
        }
      ),
      /error|fail|not verified|server|response|timeout/i,
      'No server response; a transient filename is insufficient'
    );

    assert.equal(fx.clicks(), 1);
  })
);
