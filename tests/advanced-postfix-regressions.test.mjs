/**
 * AutoTask AI v1.1.6 — Independent post-fix regressions
 *
 * Run from project root:
 *   node scripts/offline-build.cjs
 *   node --test AUTOTASK_V116_ADVANCED_POSTFIX_REGRESSIONS.test.mjs
 *
 * Local isolated tests. No real LMS or network access.
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

const { fillDragDrop, fillMoodleFileManager } =
  await import(
    pathToFileURL(
      resolve('dist/src/lms/advanced-adapters.js')
    ).href
  );

test(
  'ADV-POST-01: zone 1 must not accept ' +
  'the hidden response of zone 10',
  async () => {
    let dragged = false;

    const question = {
      id: 'm1',
      kind: 'dragdrop',
      prompt: 'Place Alpha in zone 1',
      options: [
        { id: 'm1_o0', text: 'Alpha' },
        { id: 'm1_o1', text: 'Beta' }
      ],
      zones: [
        { id: 'm1_z0', text: 'Zone 1' }
      ]
    };

    const hidden = {
      evaluateAll: async () => [
        `q701:1_p10=${dragged ? '1' : '0'}`
      ]
    };

    const zone = {
      count: async () => 1,

      // Placement verification fails:
      // the intended item is not in zone 1.
      evaluate: async (_fn, itemId) =>
        itemId === undefined ? '1' : false
    };

    const source = {
      count: async () => 1,
      locator: () => ({
        count: async () => 0
      }),
      dragTo: async () => {
        dragged = true;
      }
    };

    const root = {
      count: async () => 1,
      locator: selector =>
        selector.includes('input[type="hidden"]')
          ? hidden
          : selector.includes('data-atqa-zone')
            ? zone
            : source
    };

    const target = {
      locator: () => root
    };

    await assert.rejects(
      fillDragDrop(
        target,
        question,
        {
          id: 'm1',
          placements: [
            {
              itemId: 'm1_o0',
              zoneId: 'm1_z0'
            }
          ]
        }
      ),
      /not confirmed|mismatch|wrong|zone|slot/i,
      'Changing _p10 must not confirm target _p1'
    );
  }
);

test(
  'ADV-POST-02: a failed upload must not ' +
  'succeed because an old filename is visible',
  async () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'atqa-postfix-')
    );

    try {
      const file = join(dir, 'report.pdf');

      writeFileSync(
        file,
        '%PDF-1.4 New content NOT uploaded'
      );

      let uploadPressed = false;

      const fileContent = {
        evaluate: async () => ({
          found: true,
          hasMetadata: false,
          sha256Match: null,
          sizeMatch: null
        }),

        // The old filename was already present
        // before the new upload attempt.
        getByText: () => ({
          first: () => ({
            waitFor: async () => {}
          })
        })
      };

      const manager = {
        count: async () => 1,

        locator: selector =>
          selector === '.fp-content'
            ? fileContent
            : {
                click: async () => {},
                first: () => ({
                  waitFor: async () => {
                    throw Error(
                      'No overwrite dialog'
                    );
                  }
                })
              }
      };

      const fileInput = {
        count: async () => 1,
        setInputFiles: async () => {}
      };

      const modal = {
        first: () => ({
          count: async () => 1,
          click: async () => {}
        })
      };

      const upload = {
        first: () => ({
          count: async () => 1,
          click: async () => {
            uploadPressed = true;

            // Simulate server failure:
            // no new file is persisted and
            // the old UI remains unchanged.
          }
        })
      };

      const target = {
        keyboard: {},

        locator: selector =>
          selector.includes('data-atqa-id')
            ? manager
            : selector.includes(
                'fp-upload-form input'
              )
              ? fileInput
              : {
                  first: () => ({
                    waitFor: async () => {
                      throw Error('No overwrite');
                    }
                  })
                },

        getByText: () => modal,
        getByRole: () => upload
      };

      const question = {
        id: 'm1_att',
        kind: 'moodle-file',
        prompt: 'Attach report',
        options: []
      };

      await assert.rejects(
        fillMoodleFileManager(
          target,
          question,
          {
            id: 'm1_att',
            localFilePath: file
          }
        ),
        /upload|server|not verified|not confirmed|unchanged|failed/i,
        'Old filename cannot prove new upload succeeded'
      );

      assert.equal(
        uploadPressed,
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
);
