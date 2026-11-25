/**
 * Advanced Moodle Negative Regression Tests
 *
 * Reproducing AUD-ADV-01 and AUD-ADV-02:
 * 1. ADV-AUD-01: Drag-and-drop must fail closed when an unrelated hidden input changes
 *    (e.g., sequencecheck / CSRF / unrelated question state) but the dragged item is NOT
 *    verified inside the target drop zone.
 * 2. ADV-AUD-02: File Manager must not treat same filename with different content / hash / size
 *    as already uploaded (must verify file identity against server draft state and update if changed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fillDragDrop, fillMoodleFileManager } from '../dist/src/lms/advanced-adapters.js';

test.describe('Advanced Moodle Negative Regressions (AUD-ADV-01 & AUD-ADV-02)', () => {
  let browser;

  test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  });

  test.after(async () => {
    await browser?.close();
  });

  test('ADV-AUD-01: drag-drop MUST NOT pass when unrelated hidden input changes but item is not in target zone', async () => {
    const page = await browser.newPage();
    try {
      const html = `
        <html><body>
          <div class="que ddwtos" id="question-701-1" data-atqa-id="m1">
            <div class="qtext">Match item to zone</div>
            <div class="formulation">
              <!-- Moodle question state fields -->
              <input type="hidden" name="q701:1_:sequencecheck" value="1">
              <input type="hidden" name="q701:1_sub1" value="0">
              
              <div class="draghome" data-atqa-choice="m1_o0">
                <span class="drag" draggable="true">Alpha</span>
              </div>
              <div class="dropzone drop" data-atqa-zone="m1_z0" data-place="1">
                Drop Zone 1
              </div>
            </div>
          </div>
          <script>
            // Simulate an unrelated event (e.g. sequencecheck counter increment or heartbeat)
            // that modifies an unrelated hidden input, while the drop action itself FAILS to place the item.
            document.addEventListener('dragend', () => {
              const seq = document.querySelector('input[name="q701:1_:sequencecheck"]');
              if (seq) seq.value = '2'; // unrelated hidden input changes!
              // Notice: q701:1_sub1 stays '0' and no item is placed in dropzone!
            });
          </script>
        </body></html>
      `;
      await page.setContent(html);

      const q = {
        id: 'm1',
        kind: 'dragdrop',
        prompt: 'Match item to zone',
        options: [{ id: 'm1_o0', text: 'Alpha' }],
        zones: [{ id: 'm1_z0', text: 'Drop Zone 1' }],
        required: false,
        hasVisual: false
      };

      const answer = {
        id: 'm1',
        placements: [{ itemId: 'm1_o0', zoneId: 'm1_z0' }]
      };

      // Execution MUST reject because the item was NOT placed into m1_z0,
      // and the only changed hidden input was an unrelated sequencecheck field.
      await assert.rejects(
        fillDragDrop(page, q, answer),
        /Drag\/drop was not confirmed; item not placed in target zone/i,
        'Should reject when target zone does not contain the item despite unrelated hidden input mutation'
      );
    } finally {
      await page.close();
    }
  });

  test('ADV-AUD-02: file manager MUST NOT consider same filename with different content as already uploaded', async () => {
    const page = await browser.newPage();
    const tempDir = mkdtempSync(join(tmpdir(), 'adv-audit-file-'));
    try {
      const fileV2 = join(tempDir, 'report.pdf');
      writeFileSync(fileV2, '%PDF-1.4 NEW REVISED REPORT CONTENT V2 (SHA-DIFFERENT)');
      const hashV2 = createHash('sha256').update(readFileSync(fileV2)).digest('hex');

      let uploadTriggered = false;

      // Page currently shows an OLD "report.pdf" in .fp-content from an earlier version
      // with metadata indicating older hash or smaller size
      const html = `
        <html><body>
          <div class="que essay" id="question-801-1">
            <div class="formulation">
              <input type="hidden" name="q801:1_attachments[itemid]" value="445566">
              <div class="filemanager" data-atqa-id="m1_att" data-itemid="445566">
                <div class="fp-navbar">
                  <a class="fp-btn-add" role="button" href="#">Add...</a>
                </div>
                <div class="fp-content">
                  <!-- Stale version of report.pdf on server -->
                  <div class="fp-file" data-file-size="20" data-file-sha256="old_hash_v1">
                    <span class="fp-filename">report.pdf</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="filepicker-modal" style="display:none;">
            <span class="fp-repo-name">Upload a file</span>
            <div class="fp-upload-form">
              <input type="file" name="repo_upload_file">
              <button type="button" class="fp-upload-btn">Upload this file</button>
            </div>
          </div>

          <script>
            document.querySelector('.fp-btn-add').addEventListener('click', (e) => {
              e.preventDefault();
              document.getElementById('filepicker-modal').style.display = 'block';
            });
            document.querySelector('.fp-upload-btn').addEventListener('click', () => {
              window.onUploadTriggered();
              const f = document.querySelector('.fp-file');
              if (f) {
                f.setAttribute('data-file-sha256', '${hashV2}');
              }
            });
          </script>
        </body></html>
      `;
      await page.setContent(html);

      await page.exposeFunction('onUploadTriggered', () => {
        uploadTriggered = true;
      });

      const q = {
        id: 'm1_att',
        kind: 'moodle-file',
        prompt: 'Upload report',
        options: [],
        required: false,
        hasVisual: false
      };

      const answer = {
        id: 'm1_att',
        localFilePath: fileV2
      };

      // In current code, fillMoodleFileManager sees "report.pdf" in .fp-content and returns immediately
      // without uploading the new fileV2.
      // Expected behavior: The system detects that the local file has changed (different hash/size than existing server record)
      // and therefore MUST execute the upload flow to update the draft.
      await fillMoodleFileManager(page, q, answer);

      assert.equal(
        uploadTriggered,
        true,
        'File Manager must upload new file when content/identity has changed, even if filename matches'
      );
    } finally {
      await page.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
