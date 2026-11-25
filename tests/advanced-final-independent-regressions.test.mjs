/** Independent negative regressions against unmodified Advanced Moodle Candidate.
 * Run from extracted project root after `node scripts/offline-build.cjs`:
 *   node --test tests/advanced-final-independent-regressions.test.mjs
 * No LMS, network or Playwright dependency. Isolated fake DOM locators exercise production functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve('dist/src/lms/advanced-adapters.js')).href;
const { fillDragDrop, fillMoodleFileManager } = await import(moduleUrl);

const qFile = { id: 'm1_att', kind: 'moodle-file', prompt: 'Attach report', options: [], required: false, hasVisual: false };
function fileFixture(meta) {
  let addClicks = 0;
  const content = {
    evaluate: async (_fn, _args) => meta,
    getByText: () => ({ first: () => ({ waitFor: async () => {} }) })
  };
  const manager = {
    count: async () => 1,
    locator: (sel) => {
      if (sel === '.fp-content') return content;
      if (sel === '.fp-btn-add') return { click: async () => { addClicks++; } };
      throw Error('Unexpected manager selector ' + sel);
    }
  };
  const target = {
    locator: (sel) => {
      if (sel === '[data-atqa-id="m1_att"]') return manager;
      throw Error('Unexpected selector ' + sel);
    }
  };
  return { target, uploads: () => addClicks };
}
function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'autotask-adv-independent-'));
  const path = join(dir, 'report.pdf');
  writeFileSync(path, '%PDF-1.4 DIFFERENT CONTENT');
  return Promise.resolve().then(() => fn(path)).finally(() => rmSync(dir, { force: true, recursive: true }));
}

test('ADV-FINAL-01: filename without server metadata must not be accepted as matching upload', async () => withFile(async file => {
  const fx = fileFixture({ found: true, hasMetadata: false, sha256Match: null, sizeMatch: null });
  let falselySucceeded = false;
  try {
    await fillMoodleFileManager(fx.target, qFile, { id: 'm1_att', localFilePath: file });
    falselySucceeded = true;
  } catch {
    /* fail closed is acceptable if identity cannot be proved */
  }
  assert.ok(!falselySucceeded || fx.uploads() > 0,
    'Must reject unverified existing file or attempt upload; cannot silently treat same name as identical');
}));

test('ADV-FINAL-02: matching size but absent checksum cannot establish identical content', async () => withFile(async file => {
  const fx = fileFixture({ found: true, hasMetadata: true, sha256Match: null, sizeMatch: true });
  let falselySucceeded = false;
  try {
    await fillMoodleFileManager(fx.target, qFile, { id: 'm1_att', localFilePath: file });
    falselySucceeded = true;
  } catch {
    /* fail closed is acceptable if identity cannot be proved */
  }
  assert.ok(!falselySucceeded || fx.uploads() > 0,
    'A size match without verified checksum is not sufficient to skip upload');
}));

test('ADV-FINAL-03: nonzero answer hidden field for a different item must not prove requested drag item was placed', async () => {
  let dragged = false;
  const q = { id: 'm1', kind: 'dragdrop', prompt: 'Assign', options: [{ id: 'm1_o0', text: 'Alpha' }, { id: 'm1_o1', text: 'Beta' }], zones: [{ id: 'm1_z0', text: 'Drop 1' }] };
  const zone = { count: async () => 1, evaluate: async (fn, arg) => arg ? false : '1' };
  const source = {
    count: async () => 1,
    locator: () => ({ count: async () => 0 }),
    dragTo: async () => { dragged = true; }
  };
  const hidden = { evaluateAll: async () => ['q701:1_sub1=' + (dragged ? '2' : '0')] }; // '2' is wrong option (Beta), not Alpha
  const root = {
    count: async () => 1,
    locator: sel => sel.includes('input[type="hidden"]') ? hidden : sel.includes('data-atqa-zone') ? zone : source
  };
  const target = { locator: () => root };
  await assert.rejects(fillDragDrop(target, q, { id: 'm1', placements: [{ itemId: 'm1_o0', zoneId: 'm1_z0' }] }), /not confirmed|wrong item|mismatch/i);
});
