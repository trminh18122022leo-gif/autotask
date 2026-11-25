import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { fillMoodleFileManager } = await import(
  pathToFileURL(
    resolve('dist/src/lms/advanced-adapters.js')
  ).href
);

const question = {
  id: 'm1_att',
  kind: 'moodle-file',
  prompt: 'Attach user-selected file',
  options: []
};

function setup(meta) {
  let serverReadbackCount = 0;

  const manager = {
    count: async () => 1,
    getAttribute: async () => 'DRAFT_A',

    locator: selector => {
      if (selector === '.fp-content') {
        return { evaluate: async () => meta };
      }

      throw Error('Unexpected upload action');
    }
  };

  const target = {
    keyboard: {},

    url: () =>
      'http://localhost:12345/mod/quiz/attempt.php',

    locator: selector => {
      if (selector === '[data-atqa-id="m1_att"]') {
        return manager;
      }

      throw Error('Unexpected selector');
    },

    evaluate: async () => {
      serverReadbackCount++;

      return {
        ok: true,
        persisted: false
      };
    },

    waitForResponse: async () => {
      throw Error('No upload request occurred');
    }
  };

  return {
    target,
    readbacks: () => serverReadbackCount
  };
}

async function withFile(callback) {
  const dir = mkdtempSync(
    join(tmpdir(), 'atqa-ack12-')
  );

  try {
    const file = join(dir, 'report.pdf');

    writeFileSync(
      file,
      '%PDF-1.4 local user content'
    );

    await callback(file);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}

test(
  'ACK-12: existing DOM checksum must not bypass independent server readback',
  async () => withFile(async file => {
    const fx = setup({
      found: true,
      hasMetadata: true,
      sha256Match: true,
      sizeMatch: true
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
      /unconfirmed|server|draft|verify|persist/i,
      'Existing DOM checksum does not prove server persistence'
    );

    assert.ok(
      fx.readbacks() > 0,
      'Independent server readback must not be skipped'
    );
  })
);

test(
  'ACK-12B: matching checksum but mismatched size cannot be accepted',
  async () => withFile(async file => {
    const fx = setup({
      found: true,
      hasMetadata: true,
      sha256Match: true,
      sizeMatch: false
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
      /unconfirmed|server|draft|verify|persist|size|mismatch/i,
      'Contradictory metadata must not establish success'
    );
  })
);
