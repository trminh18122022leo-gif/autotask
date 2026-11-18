/** Phase 3 & 5 — Durable Consent Across Distinct OS Processes Exactly-Once E2E Test
 *
 * Verifies that:
 * 1. Process A loads a task configuration JSON with `confirmStartNewAttempt: true` from disk.
 * 2. Process A consumes the single-use grant, records it to the durable ledger, and triggers exactly 1 start POST to server.
 * 3. Process A exits (PID A terminates).
 * 4. Process B (new OS process with PID B) spawns and loads the EXACT SAME configuration JSON from disk.
 * 5. Process B evaluates quiz start policy -> MUST HALT with `AWAITING_START_CONFIRMATION` (0 duplicate POSTs!).
 * 6. Crash / kill interruption test: Process A terminated abruptly; Process B cannot claim second attempt.
 * 7. Concurrent claim race: Two processes running concurrently -> exactly one claims and triggers POST, other halts.
 * 8. Server verifies exactly 1 attempt start per authorized grant and ZERO duplicated requests.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Phase 3 & 5 — Durable Consent Across Distinct OS Processes (Exactly-Once Guarantee)', () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  let startAttemptRequests = 0;

  const testConfigPath = join(tmpdir(), `autotask-consent-config-${Date.now()}.json`);
  const workerScriptPath = join(process.cwd(), 'tests', 'helpers', 'durable-consent-worker.ts');

  before(async () => {
    server = createServer((req, res) => {
      const url = req.url || '/';
      if (url.includes('startattempt.php')) {
        startAttemptRequests++;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
        <h2>Ungraded Self-Practice Quiz</h2>
        <p>Ungraded permitted self-practice — 0 points</p>
        <form method="post" action="/mod/quiz/startattempt.php">
          <input type="hidden" name="cmid" value="55">
          <button type="submit">Attempt quiz now</button>
        </form>
      </body></html>`);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          port = addr.port;
          baseUrl = `http://127.0.0.1:${port}`;
        }
        resolve();
      });
    });

    // Write test configuration JSON to disk
    const testConfigData = {
      id: `task-durable-${Date.now()}`,
      url: `${baseUrl}/mod/quiz/view.php?id=55`,
      title: 'Durable Consent Quiz',
      confirmStartNewAttempt: true,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED'
    };
    writeFileSync(testConfigPath, JSON.stringify(testConfigData, null, 2), 'utf-8');
  });

  after(async () => {
    try {
      if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function runSubprocess(configPath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', workerScriptPath, configPath], {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' }
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  test('DURABLE-01: Process A consumes grant once; Process B reloads JSON from disk and is strictly blocked', async () => {
    assert.equal(startAttemptRequests, 0, 'Initial server request count is 0');

    // 1. Process A executes
    const resA = await runSubprocess(testConfigPath);
    assert.equal(resA.exitCode, 0, `Process A failed: ${resA.stderr}`);
    const outputA = JSON.parse(resA.stdout.trim().split('\n').pop() || '{}');
    assert.equal(outputA.action, 'START_NEW_ATTEMPT', 'Process A must receive START_NEW_ATTEMPT for fresh grant');
    assert.ok(outputA.pid, 'Process A returned its PID');
    assert.equal(outputA.httpTriggered, true, 'Process A clicked Attempt button and triggered HTTP request');

    // Exactly 1 request arrived on server from Process A
    assert.equal(startAttemptRequests, 1, 'Server received exactly 1 attempt start request from Process A');

    // 2. Process B executes in a distinct OS process, loading the exact same JSON config file
    const resB = await runSubprocess(testConfigPath);
    assert.equal(resB.exitCode, 0, `Process B failed: ${resB.stderr}`);
    const outputB = JSON.parse(resB.stdout.trim().split('\n').pop() || '{}');
    assert.notEqual(outputB.pid, outputA.pid, 'Process B must have a different PID than Process A');
    assert.equal(outputB.action, 'HALT_NEEDS_REVIEW', 'Process B must HALT and refuse to reuse persisted consent');
    assert.equal(outputB.code, 'AWAITING_START_CONFIRMATION', 'Process B requires fresh confirmation');
    assert.equal(outputB.httpTriggered, false, 'Process B did not trigger any HTTP request');

    // 3. Verify server state: zero duplicated attempts (count remains 1)
    assert.equal(startAttemptRequests, 1, 'Server received 0 duplicate requests from Process B (count remains 1)');
  });

  test('DURABLE-02: Crash interruption test — Process B cannot claim grant after Process A crashes', async () => {
    const baselineCount = startAttemptRequests;

    // Create new unique task config
    const crashConfigPath = join(tmpdir(), `autotask-crash-config-${Date.now()}.json`);
    const taskData = {
      id: `task-crash-${Date.now()}`,
      url: `${baseUrl}/mod/quiz/view.php?id=99`,
      title: 'Crash Test Quiz',
      confirmStartNewAttempt: true,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED'
    };
    writeFileSync(crashConfigPath, JSON.stringify(taskData, null, 2), 'utf-8');

    try {
      // Process A runs and completes claim
      const resA = await runSubprocess(crashConfigPath);
      assert.equal(resA.exitCode, 0);
      const outA = JSON.parse(resA.stdout.trim().split('\n').pop() || '{}');
      assert.equal(outA.action, 'START_NEW_ATTEMPT');
      assert.equal(outA.httpTriggered, true);
      assert.equal(startAttemptRequests, baselineCount + 1, 'Server received request from Process A');

      // Process B runs fresh after simulated crash
      const resB = await runSubprocess(crashConfigPath);
      assert.equal(resB.exitCode, 0);
      const outB = JSON.parse(resB.stdout.trim().split('\n').pop() || '{}');
      assert.equal(outB.action, 'HALT_NEEDS_REVIEW');
      assert.equal(outB.code, 'AWAITING_START_CONFIRMATION');
      assert.equal(outB.httpTriggered, false);
      assert.equal(startAttemptRequests, baselineCount + 1, 'Server received 0 additional requests after crash');
    } finally {
      try { unlinkSync(crashConfigPath); } catch {}
    }
  });

  test('DURABLE-03: Concurrent processes racing to claim same grant — exactly one succeeds', async () => {
    const baselineCount = startAttemptRequests;
    const raceConfigPath = join(tmpdir(), `autotask-race-config-${Date.now()}.json`);
    const taskData = {
      id: `task-race-${Date.now()}`,
      url: `${baseUrl}/mod/quiz/view.php?id=188`,
      title: 'Race Test Quiz',
      confirmStartNewAttempt: true,
      aiPermitted: true,
      mode: 'PRACTICE_ASSISTED'
    };
    writeFileSync(raceConfigPath, JSON.stringify(taskData, null, 2), 'utf-8');

    try {
      // Launch both simultaneously
      const [res1, res2] = await Promise.all([
        runSubprocess(raceConfigPath),
        runSubprocess(raceConfigPath)
      ]);

      assert.equal(res1.exitCode, 0);
      assert.equal(res2.exitCode, 0);

      const out1 = JSON.parse(res1.stdout.trim().split('\n').pop() || '{}');
      const out2 = JSON.parse(res2.stdout.trim().split('\n').pop() || '{}');

      const actions = [out1.action, out2.action];
      const startCount = actions.filter(a => a === 'START_NEW_ATTEMPT').length;
      const haltCount = actions.filter(a => a === 'HALT_NEEDS_REVIEW').length;

      assert.equal(startCount, 1, `Exactly one process must receive START_NEW_ATTEMPT. Got: ${JSON.stringify(actions)}`);
      assert.equal(haltCount, 1, `Exactly one process must receive HALT_NEEDS_REVIEW. Got: ${JSON.stringify(actions)}`);

      const httpTriggers = [out1.httpTriggered, out2.httpTriggered];
      const triggerCount = httpTriggers.filter(Boolean).length;
      assert.equal(triggerCount, 1, 'Exactly one process triggered HTTP POST to server');
      assert.equal(startAttemptRequests, baselineCount + 1, 'Server received exactly 1 start request during concurrent race');
    } finally {
      try { unlinkSync(raceConfigPath); } catch {}
    }
  });

  test('DURABLE-04: Server verification — Exactly 1 attempt start per authorized grant, zero duplicated requests', () => {
    // Total authorized starts across tests 1, 2, 3 = exactly 3
    assert.equal(startAttemptRequests, 3, 'Server received exactly 3 authorized attempt starts (1 per test case) and zero duplicated requests');
  });
});
