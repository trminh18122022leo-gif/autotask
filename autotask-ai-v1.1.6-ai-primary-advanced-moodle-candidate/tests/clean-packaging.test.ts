import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('Clean Packaging: package-release.ps1 builds verified clean ZIP with LMS modules and zero private credentials', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'autotask-pkg-verify-'));
  const zipPath = join(tempDir, 'autotask-ai-clean-verify.zip');

  try {
    // Package into an isolated temp path so running tests never overwrites existing release/*.zip artifacts
    execFileSync(
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/package-release.ps1', '-OutFile', zipPath],
      { encoding: 'utf8' }
    );

    assert.ok(existsSync(zipPath), 'Verified clean release ZIP must exist');

    const python = process.env.AUTOTASK_PYTHON || 'python';
    const pyCode = `
import zipfile, sys
zf = zipfile.ZipFile(r"${zipPath.replace(/\\/g, '\\\\')}")
namelist = zf.namelist()

backslash_entries = [n for n in namelist if '\\\\' in n]
if backslash_entries:
    print('BACKSLASH_FOUND:' + ','.join(backslash_entries[:5]))
    sys.exit(1)

forbidden_patterns = ['.private', 'node_modules', 'dist', '__pycache__', '.env', 'reports/', 'artifacts']
bad = [n for n in namelist if any(x in n for x in forbidden_patterns) or n.endswith('.pyc') or n.endswith('.log')]
if bad:
    print('FORBIDDEN:' + ','.join(bad))
    sys.exit(2)

essential = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'Start_AutoTask_AI.cmd',
    'src/main.ts',
    'src/scanner.ts',
    'src/platforms.ts',
    'src/interaction.ts',
    'src/task-manager.ts',
    'src/evaluation/answer-quality.ts',
    'src/evaluation/real-model-benchmark.ts',
    'src/browser/resume-coordinator.ts',
    'src/model-center/model-router.ts',
    'desktop/worker.py',
    'scripts/first-run.ps1',
    'scripts/run-real-model-benchmark.ts',
    'tests/moodle-dom-accuracy.test.ts',
    'tests/answer-quality-benchmark.test.ts',
    'tests/english-discoveries.test.ts',
    'tests/fami-sohoa.test.ts',
    'tests/lms-platform-matrix.test.ts',
    'tests/lms-browser-restart-e2e.test.ts',
    'tests/helpers/lms-moodle-worker.ts',
    'tests/fixtures/moodle-fixtures.ts',
    'tests/fixtures/browser-harness.ts'
]
missing = [e for e in essential if e not in namelist]
if missing:
    print('MISSING:' + ','.join(missing))
    sys.exit(3)

crc_err = zf.testzip()
if crc_err is not None:
    print('CRC_FAIL:' + crc_err)
    sys.exit(4)

print(f"COUNT:{len(namelist)}")
`;

    const inspect = execFileSync(python, ['-c', pyCode], { encoding: 'utf8' }).trim();
    assert.ok(inspect.startsWith('COUNT:'), `Inspection failed: ${inspect}`);
    const count = parseInt(inspect.replace('COUNT:', ''), 10);
    assert.ok(count >= 100, `Expected at least 100 cleanly packaged files, got ${count}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
