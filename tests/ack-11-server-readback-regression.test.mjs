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
import { createHash } from 'node:crypto';

const { fillMoodleFileManager } = await import(
  pathToFileURL(
    resolve('dist/src/lms/advanced-adapters.js')
  ).href
);

test(
  'ACK-11: client checksum echo cannot prove server persistence',
  async () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'atqa-server-readback-')
    );

    try {
      const file = join(dir, 'report.pdf');
      const data = Buffer.from('%PDF-1.4 local sample');

      writeFileSync(file, data);

      const sha = createHash('sha256')
        .update(data)
        .digest('hex');

      // The server deliberately stores NO file.
      const serverDraft = new Map();
      let clicked = false;

      // Browser DOM echoes checksum optimistically.
      // This is not an independent server readback.
      const content = {
        evaluate: async () => ({
          found: clicked,
          hasMetadata: clicked,
          sha256Match: clicked ? true : null,
          sizeMatch: clicked ? true : null
        })
      };

      const manager = {
        count: async () => 1,

        getAttribute: async key =>
          key === 'data-itemid' ? 'DRAFT_A' : null,

        locator: key =>
          key === '.fp-content'
            ? content
            : { click: async () => {} }
      };

      const page = {
        keyboard: {},

        url: () =>
          'http://127.0.0.1:31888/mod/quiz/attempt.php',

        waitForResponse: async predicate => {
          const response = {
            url: () =>
              'http://127.0.0.1:31888/repository/repository_ajax.php?action=upload',

            request: () => ({
              method: () => 'POST',
              postData: () =>
                'repo_upload_file=report.pdf&itemid=DRAFT_A'
            }),

            status: () => 200,

            json: async () => ({
              status: 'ok',
              filename: 'report.pdf',
              itemid: 'DRAFT_A',
              sha256: sha
            })
          };

          if (!predicate(response)) {
            throw Error('Unmatched upload request');
          }

          // ACK received, but server did NOT persist file.
          return response;
        },

        locator: key =>
          key.includes('data-atqa-id')
            ? manager
            : key.includes('fp-upload-form input')
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

      const question = {
        id: 'm1_att',
        kind: 'moodle-file',
        prompt: 'Attach report',
        options: []
      };

      await assert.rejects(
        fillMoodleFileManager(
          page,
          question,
          {
            id: question.id,
            localFilePath: file
          }
        ),
        /draft|persist|unconfirmed|verify|server/i,
        'Client DOM hash plus upload ACK cannot prove persistence'
      );

      assert.equal(clicked, true);
      assert.equal(
        serverDraft.size,
        0,
        'The server did not store the file'
      );
    } finally {
      rmSync(dir, {
        recursive: true,
        force: true
      });
    }
  }
);
