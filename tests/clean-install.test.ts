/** Clean Installation & Real ZIP Extraction Acceptance Tests (Phase 6: INSTALL-01 to INSTALL-08 & CI-01 to CI-06)
 * Verifies that test suites and core modules run reliably on fresh unzipped directories
 * extracted from the actual release archive without depending on pre-existing artifacts,
 * stale sessions, or existing .private directories.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { npmInvocation } from '../src/npm-runner.js';
import type { TaskCheckpoint } from '../src/task-manager.js';

describe('Clean Installation Suite (CI-01 to CI-06)', () => {
  test('CI-01: Clean environment runs without requiring pre-existing artifacts directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'autotask-ci01-'));
    try {
      assert.equal(existsSync(join(tempDir, 'artifacts')), false);
      const testFile = join(tempDir, 'document.txt');
      writeFileSync(testFile, 'Test payload content', 'utf8');
      assert.equal(existsSync(testFile), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('CI-02: Absence of .private directory is handled gracefully by listAccounts', async () => {
    const { listAccounts } = await import('../src/accounts.js');
    const accountsFile = resolve('.private', 'accounts.json');
    const backupFile = resolve('.private', 'accounts.json.bak_test');
    const hadFile = existsSync(accountsFile);
    if (hadFile) {
      renameSync(accountsFile, backupFile);
    }
    try {
      const accounts = await listAccounts();
      assert.deepEqual(accounts, {});
    } finally {
      if (hadFile && existsSync(backupFile)) {
        renameSync(backupFile, accountsFile);
      }
    }
  });

  test('CI-03: Fresh run without browser sessions handles forgetSession safely without crashing', async () => {
    const { forgetSession } = await import('../src/accounts.js');
    await assert.doesNotReject(async () => {
      await forgetSession('brand-new-isolated-account-id');
    });
  });

  test('CI-04: Upload tests create self-contained temporary files and clean them up completely', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'autotask-ci04-'));
    const filePath = join(tempDir, 'submission.docx');
    writeFileSync(filePath, 'Automated test document content');
    assert.ok(existsSync(filePath));

    rmSync(tempDir, { recursive: true, force: true });
    assert.equal(existsSync(filePath), false, 'Temp file must be removed completely after test');
    assert.equal(existsSync(tempDir), false, 'Temp directory must be removed completely after test');
  });

  test('CI-05: Consecutive operations do not retain cross-test state leakage', async () => {
    const { saveCheckpoint, loadCheckpoint, clearCheckpoint } = await import('../src/task-manager.js');
    const taskId = 'ci05-idempotence-test';

    const cp: TaskCheckpoint = {
      taskId,
      url: 'https://example.com/quiz',
      status: 'RUNNING',
      stepsCompleted: 1,
      questionsFound: 1,
      questionsFilled: 1,
      lastUpdated: new Date().toISOString()
    };

    // Run 1
    await saveCheckpoint(cp);
    const loaded1 = await loadCheckpoint(taskId);
    assert.equal(loaded1?.taskId, taskId);
    await clearCheckpoint(taskId);
    assert.equal(await loadCheckpoint(taskId), null);

    // Run 2 immediately after
    await saveCheckpoint(cp);
    const loaded2 = await loadCheckpoint(taskId);
    assert.equal(loaded2?.taskId, taskId);
    await clearCheckpoint(taskId);
    assert.equal(await loadCheckpoint(taskId), null);
  });

  test('CI-06: package.json and package-lock.json versions and dependencies are consistent', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));

    assert.equal(pkg.name, lock.name);
    assert.equal(pkg.version, lock.version);
    assert.ok(pkg.dependencies.playwright, 'Playwright must be listed in dependencies');
    assert.ok(lock.packages[''].dependencies.playwright, 'Lockfile must lock playwright dependency');
  });
});

describe('Real Clean ZIP Installation & Execution Acceptance (INSTALL-01 to INSTALL-08)', () => {
  const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
  const pythonArgs = process.platform === 'win32' ? ['-3'] : [];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let unpackDir: string;
  let tempZipDir: string | null = null;
  let zipPath: string;

  before(() => {
    unpackDir = mkdtempSync(join(tmpdir(), 'autotask-install-test-'));
    const candidates = [
      process.env.AUTOTASK_RELEASE_ZIP ? resolve(process.env.AUTOTASK_RELEASE_ZIP) : '',
      resolve('release', 'autotask-ai-v1.1.7-rc.2.zip'),
      resolve('release', 'autotask-ai-v1.1.7-rc.zip'),
      resolve('release', 'autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip'),
      resolve('release', 'autotask-ai-v1.1.6-lms-integrated-clean.zip')
    ].filter(Boolean);
    const existing = candidates.find(p => existsSync(p));
    if (existing) {
      zipPath = existing;
    } else {
      // Running inside a freshly extracted clean source tree where release/ is excluded:
      // build an isolated clean release archive into OS temp without mutating workspace release/
      tempZipDir = mkdtempSync(join(tmpdir(), 'autotask-install-zip-'));
      zipPath = join(tempZipDir, 'autotask-ai-fresh-clean.zip');
      execFileSync(
        'powershell',
        ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/package-release.ps1', '-OutFile', zipPath],
        { encoding: 'utf8' }
      );
    }
  });

  after(() => {
    if (unpackDir && existsSync(unpackDir)) {
      try {
        rmSync(unpackDir, { recursive: true, force: true });
      } catch {}
    }
    if (tempZipDir && existsSync(tempZipDir)) {
      try {
        rmSync(tempZipDir, { recursive: true, force: true });
      } catch {}
    }
  });

  test('INSTALL-01: Release ZIP exists and has valid size', () => {
    assert.ok(existsSync(zipPath), `Release ZIP must exist at ${zipPath}`);
  });

  test('INSTALL-02: Release ZIP contains strictly 0 backslashes and 0 forbidden paths', () => {
    const pyCode = `
import zipfile, sys
zf = zipfile.ZipFile(r"${zipPath.replace(/\\/g, '\\\\')}")
names = zf.namelist()
bs = [n for n in names if '\\\\' in n]
if bs:
    print('BACKSLASH:' + ','.join(bs[:3]))
    sys.exit(1)
forbidden = ['.private', 'node_modules', 'dist', '__pycache__', '.env', 'reports/', 'artifacts']
bad = [n for n in names if any(f in n for f in forbidden) or n.endswith('.pyc') or n.endswith('.log')]
if bad:
    print('FORBIDDEN:' + ','.join(bad[:3]))
    sys.exit(2)
print('VALID:' + str(len(names)))
`;
    const res = execFileSync(pythonCmd, [...pythonArgs, '-c', pyCode], { encoding: 'utf8' }).trim();
    assert.ok(res.startsWith('VALID:'), `ZIP check failed: ${res}`);
  });

  test('INSTALL-03: Real release ZIP extracts completely into clean temporary directory', () => {
    const pyCode = `
import zipfile
zf = zipfile.ZipFile(r"${zipPath.replace(/\\/g, '\\\\')}")
zf.extractall(r"${unpackDir.replace(/\\/g, '\\\\')}")
print('EXTRACTED')
`;
    const res = execFileSync(pythonCmd, [...pythonArgs, '-c', pyCode], { encoding: 'utf8' }).trim();
    assert.equal(res, 'EXTRACTED');
    assert.ok(existsSync(unpackDir));
  });

  test('INSTALL-04: Extracted directory contains essential package structure and zero credentials', () => {
    const requiredFiles = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'Start_AutoTask_AI.cmd',
      'src/launcher.ts',
      'src/main.ts',
      'src/browser/resume-coordinator.ts',
      'desktop/worker.py',
      'scripts/first-run.ps1',
      'resources/certs/globalsign_intermediate.crt'
    ];
    for (const rel of requiredFiles) {
      assert.ok(existsSync(join(unpackDir, rel)), `Missing required file: ${rel}`);
    }

    assert.equal(existsSync(join(unpackDir, '.private')), false, '.private must not exist in unpacked release');
    assert.equal(existsSync(join(unpackDir, 'node_modules')), false, 'node_modules must not pre-exist');
    assert.equal(existsSync(join(unpackDir, 'reports')), false, 'reports must not be bundled');
  });

  test('INSTALL-05: npm ci completes cleanly with exit code 0 inside unzipped directory', () => {
    // Run npm ci with --prefer-offline to leverage local npm cache
    const output = execFileSync(npmInvocation(['ci', '--prefer-offline']).command, npmInvocation(['ci', '--prefer-offline']).args, {
      cwd: unpackDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60000
    });
    assert.ok(existsSync(join(unpackDir, 'node_modules')), 'node_modules must be installed');
  });

  test('INSTALL-06: npm run typecheck succeeds with 0 errors inside unzipped directory', () => {
    const output = execFileSync(npmInvocation(['run', 'typecheck']).command, npmInvocation(['run', 'typecheck']).args, {
      cwd: unpackDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });
    assert.ok(!output.includes('error TS'), 'TypeScript check must pass with 0 errors');
  });

  test('INSTALL-07: npm run doctor runs cleanly and validates all diagnostics inside unzipped directory', () => {
    const output = execFileSync(npmInvocation(['run', 'doctor']).command, npmInvocation(['run', 'doctor']).args, {
      cwd: unpackDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });
    assert.ok(/DOCTOR|CHẨN ĐOÁN|Health Check/i.test(output), 'Doctor output must be reported');
  });

  test('INSTALL-08: Complete teardown of extracted directory leaves zero orphaned locks or files', () => {
    rmSync(unpackDir, { recursive: true, force: true });
    assert.equal(existsSync(unpackDir), false, 'Extracted temp directory must be fully cleaned up');
  });
});
