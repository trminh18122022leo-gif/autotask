/** Phase 9C - release-candidate guards: shell-free spawning, retry policy, version sync, CA bootstrap, write-safety.
 *  No real LMS, no real API key, no real model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { chromium } from 'playwright';
import { npmRunInvocation, npmInvocation, findNpmCli, ALLOWED_NPM_SCRIPTS } from '../src/npm-runner.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { startPracticeSandbox } from './helpers/practice-sandbox.js';
import { makeConfig, makeTask } from './helpers/practice-harness.js';
import { executeTask } from '../src/main.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'phase9c-rc-guards.test.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (['node_modules', 'dist', '.private', 'reports', 'artifacts', 'release', '.git'].includes(n)) continue;
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else if (/\.(ts|mjs|cjs|js)$/.test(n)) out.push(p);
  }
  return out;
}

test.describe('RC-A: no shell on any spawn path (Node DEP0190)', () => {
  test('RC-01: no source/script/test file spawns a child process with a shell', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'scripts', 'tests']) {
      for (const f of walk(join(ROOT, dir))) {
        if (f.endsWith(SELF)) continue;
        readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/\bshell\s*:\s*(true|isWin|process\.platform|IS_WIN)/.test(line)) offenders.push(`${f.replace(ROOT, '')}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('RC-02: launcher accepts only allowlisted `npm run <script>` and rejects injection-shaped input', () => {
    for (const bad of ['browser; calc', 'doctor && whoami', '--version', '', 'run', '../x', 'browser\nnotes', '$(id)']) {
      assert.throws(() => npmRunInvocation(bad), /not allowed/, JSON.stringify(bad));
    }
    for (const ok of ALLOWED_NPM_SCRIPTS) assert.doesNotThrow(() => npmRunInvocation(ok));
  });

  test('RC-03: invocation is `node npm-cli.js run <script>` as an argv array (no shell string)', () => {
    const inv = npmRunInvocation('doctor');
    assert.equal(inv.command, process.execPath);
    assert.match(inv.args[0], /npm-cli\.c?js$/);
    assert.deepEqual(inv.args.slice(1), ['run', 'doctor']);
    assert.ok(findNpmCli());
  });

  test('RC-04: executing npm through the runner works and emits no DEP0190 warning', () => {
    const inv = npmInvocation(['--version']);
    const r = spawnSync(inv.command, inv.args, { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
    assert.ok(!/DEP0190/.test(r.stderr), r.stderr);
  });

  test('RC-05: launcher source delegates to npm-runner and has no shell option', () => {
    const src = readFileSync(join(ROOT, 'src', 'launcher.ts'), 'utf8');
    assert.match(src, /from '\.\/npm-runner\.js'/);
    assert.ok(!/\bshell\s*:/.test(src));
  });
});

test.describe('RC-B: retry policy (conservative defaults)', () => {
  const db: any = { default: 'p1', fallbacks: [], profiles: { p1: { provider: 'openai', kind: 'openai-compatible', model: 'm', endpoint: 'https://example.invalid/v1', createdAt: 'x' } } };
  const resolveFn: any = async () => ({ spec: {}, apiKey: 'x' });

  test('RC-06: default = exactly ONE model call per execution (no retry, no fallback model)', async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error('fetch failed'); };
    await assert.rejects(ModelRouter.execute({ system: 's', text: 't' } as any, { db, resolveFn }, failing as any));
    assert.equal(calls, 1);
  });

  test('RC-07: more than one attempt only happens when explicitly configured, capped at 3', async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error('fetch failed'); };
    await assert.rejects(ModelRouter.execute({ system: 's', text: 't' } as any, { db, resolveFn, maxAttemptsPerModel: 99 }, failing as any));
    assert.equal(calls, 3);
  });
});

test.describe('RC-C: write safety', () => {
  test('RC-08: a state-changing URL is refused BEFORE any HTTP request reaches the server (no retry, no replay)', async () => {
    const sb = await startPracticeSandbox();
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const task = makeTask(sb, 'rc_mutating_url', { url: `${sb.baseUrl}/mod/quiz/startattempt.php?cmid=1&sesskey=testSesskey1` });
      const res = await executeTask(ctx, task, { ...makeConfig({ kind: 'openai-compatible', profileId: 'test-double', model: 'test-double' }), tasks: [task] });
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(sb.counters.pageLoads, 0);
      assert.deepEqual(sb.counters.unknownGets, [], 'server saw no request at all');
      assert.equal(sb.counters.autosaveRequests + sb.counters.submitRequests, 0);
      await ctx.close();
    } finally { await browser.close(); await sb.close(); }
  });
});

test.describe('RC-D: version sync', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  test('RC-09: package.json, package-lock.json, launcher cmd, packager and notes agree on v1.1.7-rc', () => {
    assert.match(pkg.version, /^1\.1\.7-rc\.\d+$/);
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.match(readFileSync(join(ROOT, 'Start_AutoTask_AI.cmd'), 'utf8'), /v1\.1\.7-rc/);
    assert.match(readFileSync(join(ROOT, 'scripts', 'package-release.ps1'), 'utf8'), /autotask-ai-v1\.1\.7-rc/);
    assert.ok(statSync(join(ROOT, 'RELEASE_NOTES_v1.1.7-rc.md')).size > 500);
  });
});

test.describe('RC-E: CA bootstrap keeps strict TLS', () => {
  test('RC-10: with a CA file present, the process respawns once with NODE_EXTRA_CA_CERTS set and TLS verification untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atqa-ca-'));
    try {
      mkdirSync(join(dir, '.private'));
      const pem = join(dir, '.private', 'globalsign_intermediate.pem');
      writeFileSync(pem, tls.rootCertificates[0] + '\n'); // a real, public root certificate used purely as a fixture
      const env = { ...process.env } as Record<string, string | undefined>;
      delete env.NODE_EXTRA_CA_CERTS; delete env._AUTOTASK_CA_RESPAWNED; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'tests', 'helpers', 'ca-probe.ts')], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
      assert.equal(out.respawned, '1');
      assert.equal(resolve(out.extraCa).toLowerCase(), resolve(pem).toLowerCase());
      assert.equal(out.rejectUnauthorized, null, 'TLS verification must not be disabled');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
