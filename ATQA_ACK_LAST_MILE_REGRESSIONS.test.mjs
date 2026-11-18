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

async function scenario(
  { requestBody, serverJson, expectedDraft = 'DRAFT_A' },
  assertion
) {
  const dir = mkdtempSync(
    join(tmpdir(), 'atqa-ack-last-mile-')
  );

  try {
    const path = join(dir, 'report.pdf');
    writeFileSync(path, '%PDF-1.4 local fixture');

    let clicked = false;
    let matched = null;

    const manager = {
      count: async () => 1,

      getAttribute: async name =>
        name === 'data-itemid'
          ? expectedDraft
          : null,

      locator: selector =>
        selector === '.fp-content'
          ? {
              evaluate: async () => ({
                found: clicked,
                hasMetadata: false,
                sha256Match: null,
                sizeMatch: null
              })
            }
          : {
              click: async () => {}
            }
    };

    const response = {
      url: () =>
        'http://127.0.0.1:31888/repository/repository_ajax.php?action=upload',

      request: () => ({
        method: () => 'POST',
        postData: () => requestBody
      }),

      status: () => 200,
      json: async () => serverJson
    };

    const page = {
      keyboard: {},

      url: () =>
        'http://127.0.0.1:31888/mod/quiz/attempt.php',

      waitForResponse: async predicate => {
        matched = predicate(response);

        if (!matched) {
          throw new Error('No matching upload response');
        }

        return response;
      },

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
            clicked = true;
          }
        })
      })
    };

    await assertion({
      page,
      path,
      matched: () => matched,
      clicked: () => clicked
    });
  } finally {
    rmSync(dir, {
      force: true,
      recursive: true
    });
  }
}

test(
  'ACK-09: missing request/response draft identity must not verify widget',
  async () => {
    await scenario(
      {
        expectedDraft: 'DRAFT_A',
        requestBody: 'repo_upload_file=report.pdf',
        serverJson: {
          status: 'ok',
          filename: 'report.pdf'
        }
      },

      async ({ page, path, matched, clicked }) => {
        await assert.rejects(
          fillMoodleFileManager(
            page,
            question,
            {
              id: question.id,
              localFilePath: path
            }
          ),
          /draft|itemid|not verified|identity|response/i
        );

        assert.equal(clicked(), true);
        assert.equal(
          matched(),
          false,
          'Unbound response must not be linked to widget A'
        );
      }
    );
  }
);

test(
  'ACK-10: transient UI plus positive ACK does not prove server draft persistence',
  async () => {
    await scenario(
      {
        expectedDraft: 'DRAFT_A',

        requestBody:
          'repo_upload_file=report.pdf&itemid=DRAFT_A',

        serverJson: {
          status: 'ok',
          filename: 'report.pdf',
          itemid: 'DRAFT_A'
        }
      },

      async ({ page, path, clicked }) => {
        // The fake UI displays a filename after clicking,
        // while no independent server draft readback occurs.

        await assert.rejects(
          fillMoodleFileManager(
            page,
            question,
            {
              id: question.id,
              localFilePath: path
            }
          ),
          /server|draft|persist|unconfirmed|verified/i
        );

        assert.equal(clicked(), true);
      }
    );
  }
);
