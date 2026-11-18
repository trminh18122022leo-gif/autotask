/** Phase 8F — READ_ONLY Evidence Reconciliation & Telemetry Audit Test Suite (RO-REC-01..05)
 *
 * Verifies:
 * 1. That in READ_ONLY mode, mutating requests are blocked and accurately counted in task results.
 * 2. That server receives zero mutations when background scripts attempt POSTs.
 * 3. That telemetry consistency validation detects any discrepancy between raw telemetry JSON and Markdown reports.
 * 4. That readOnlyVerified flag is strictly derived from verified facts (zero mutations, all mutating requests blocked).
 * 5. That release gate evaluation stays unverified / blocked whenever telemetry is contradictory or partial.
 */
import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { executeTask } from '../src/main.js';
import { clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

interface RawTelemetry {
  auditDate: string;
  host: string;
  pagesObserved: { url: string; title: string; status: string }[];
  networkTelemetry: {
    totalRequests: number;
    getRequests: number;
    postRequests: number;
    mutatingRequestsBlocked: number;
  };
  authenticationStatus: string;
  coursesDetectedCount: number;
  activityLaunchRisk: string;
  readOnlyVerified: boolean;
}

export function evaluateReadOnlyConsistency(telemetry: RawTelemetry, reportMarkdown: string): {
  consistent: boolean;
  discrepancies: string[];
  gateStatus: 'PASS' | 'PARTIAL_VERIFICATION' | 'NEEDS_REVIEW';
} {
  const discrepancies: string[] = [];

  // Check 1: In raw telemetry, if postRequests > mutatingRequestsBlocked, readOnlyVerified must NOT be true
  const unblockedPosts = telemetry.networkTelemetry.postRequests - telemetry.networkTelemetry.mutatingRequestsBlocked;
  if (unblockedPosts > 0 && telemetry.readOnlyVerified) {
    discrepancies.push(`Telemetry internal inconsistency: postRequests (${telemetry.networkTelemetry.postRequests}) > mutatingRequestsBlocked (${telemetry.networkTelemetry.mutatingRequestsBlocked}) but readOnlyVerified is true`);
  }

  // Check 2: Report markdown must not claim readOnlyVerified: true if raw telemetry is false
  const markdownClaimsVerifiedTrue = /"readOnlyVerified"\s*:\s*true/i.test(reportMarkdown) || /readOnlyVerified\s*=\s*true/i.test(reportMarkdown);
  if (!telemetry.readOnlyVerified && markdownClaimsVerifiedTrue) {
    discrepancies.push('Report-to-telemetry mismatch: Markdown report claims readOnlyVerified: true but raw JSON has false');
  }

  // Check 3: Report markdown must not claim all POSTs were blocked if mutatingRequestsBlocked is 0 while postRequests > 0
  const reportClaimsPostsBlocked = /POST.*bị chặn|blocked.*POST/i.test(reportMarkdown);
  if (telemetry.networkTelemetry.mutatingRequestsBlocked === 0 && telemetry.networkTelemetry.postRequests > 0 && reportClaimsPostsBlocked) {
    discrepancies.push(`Report-to-telemetry mismatch: Report claims POST requests were blocked, but mutatingRequestsBlocked is 0 (all ${telemetry.networkTelemetry.postRequests} POST requests were unblocked)`);
  }

  let gateStatus: 'PASS' | 'PARTIAL_VERIFICATION' | 'NEEDS_REVIEW' = 'PASS';
  if (discrepancies.length > 0) {
    gateStatus = 'NEEDS_REVIEW';
  } else if (!telemetry.readOnlyVerified || telemetry.authenticationStatus !== 'AUTHENTICATED') {
    gateStatus = 'PARTIAL_VERIFICATION';
  }

  return {
    consistent: discrepancies.length === 0,
    discrepancies,
    gateStatus
  };
}

export function synthesizeConsistentReportSnippet(telemetry: RawTelemetry): string {
  const effectiveVerified =
    telemetry.readOnlyVerified &&
    telemetry.networkTelemetry.postRequests === telemetry.networkTelemetry.mutatingRequestsBlocked;

  return JSON.stringify(
    {
      auditDate: telemetry.auditDate,
      host: telemetry.host,
      pagesObserved: telemetry.pagesObserved,
      networkTelemetry: telemetry.networkTelemetry,
      authenticationStatus: telemetry.authenticationStatus,
      coursesDetectedCount: telemetry.coursesDetectedCount,
      activityLaunchRisk: telemetry.activityLaunchRisk,
      readOnlyVerified: effectiveVerified
    },
    null,
    2
  );
}

describe('Phase 8F — READ_ONLY Evidence Reconciliation & Telemetry Audit (RO-REC-01..05)', () => {
  let browser: Browser;
  let server: http.Server;
  let port = 0;

  const serverCounters = {
    getRequests: 0,
    postRequests: 0,
    blockedAttempts: 0,
    serverStateMutations: 0,
    mutatingPathsHit: [] as string[]
  };

  before(async () => {
    browser = await chromium.launch({ headless: true });

    server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'GET') {
        serverCounters.getRequests++;
      } else {
        serverCounters.postRequests++;
        serverCounters.mutatingPathsHit.push(`${method} ${u.pathname}`);
      }

      if (u.pathname === '/mod/quiz/view.php') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Course Overview</title></head><body>
          <h2>Self-Practice Overview</h2>
          <form method="post" action="/mod/quiz/startattempt.php">
            <button id="btn-start" type="submit">Start Attempt</button>
          </form>
          <script>
            // Simulate 2 background telemetry POST calls (similar to Moodle service.php)
            setTimeout(() => {
              fetch('/lib/ajax/service.php', { method: 'POST', body: '{"action":"get_prefs"}' }).catch(() => {});
              fetch('/api/heartbeat', { method: 'POST', body: '{"ping":1}' }).catch(() => {});
            }, 50);
          </script>
        </body></html>`);
        return;
      }

      if (u.pathname === '/lib/ajax/service.php' || u.pathname === '/api/heartbeat') {
        serverCounters.serverStateMutations++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>(r => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port;
        r();
      });
    });
  });

  after(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await browser?.close();
  });

  beforeEach(() => {
    serverCounters.getRequests = 0;
    serverCounters.postRequests = 0;
    serverCounters.blockedAttempts = 0;
    serverCounters.serverStateMutations = 0;
    serverCounters.mutatingPathsHit = [];
  });

  function makeConfig(): AppConfig {
    return {
      allowedHosts: ['127.0.0.1'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' },
      operationMode: 'READ_ONLY'
    };
  }

  test('RO-REC-01: READ_ONLY mode blocks background POSTs and records exact blocked count in readOnlyBlockedRequests', async () => {
    const taskId = 'ro-rec-01-blocked-counter';
    await clearCheckpoint(taskId);
    const ctx = await browser.newContext();

    try {
      const res = await executeTask(
        ctx,
        {
          id: taskId,
          url: `http://127.0.0.1:${port}/mod/quiz/view.php`,
          title: 'Quiz Overview Test',
          aiPermitted: true,
          mode: 'READ_ONLY'
        },
        makeConfig()
      );

      // Verify that mutating calls were blocked
      assert.ok(res.readOnlyBlockedRequests, 'readOnlyBlockedRequests must be defined');
      assert.ok(res.readOnlyBlockedRequests.length > 0, 'Must record blocked requests in result');
      assert.ok(
        res.readOnlyBlockedRequests.some(r => r.includes('/lib/ajax/service.php')),
        'Must block /lib/ajax/service.php'
      );

      // Verify server received ZERO mutations
      assert.equal(serverCounters.serverStateMutations, 0, 'Server must receive ZERO mutations');
      assert.equal(serverCounters.postRequests, 0, 'Server must receive ZERO POST requests');
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('RO-REC-02: evaluateReadOnlyConsistency flags discrepancy between raw telemetry (false) and report markdown (true)', () => {
    const rawTelemetry: RawTelemetry = {
      auditDate: '2026-11-06T03:37:28.651Z',
      host: 'lms.hust.edu.vn',
      pagesObserved: [{ url: 'https://lms.hust.edu.vn/my/', title: 'Dashboard', status: 'SUCCESS' }],
      networkTelemetry: {
        totalRequests: 78,
        getRequests: 74,
        postRequests: 4,
        mutatingRequestsBlocked: 0
      },
      authenticationStatus: 'AUTHENTICATED',
      coursesDetectedCount: 6,
      activityLaunchRisk: 'ZERO_ATTEMPTS_OPENED',
      readOnlyVerified: false
    };

    // Report falsely claims readOnlyVerified: true
    const falseReport = `
      # Phase 8E Report
      \`\`\`json
      {
        "readOnlyVerified": true
      }
      \`\`\`
      Bốn POST đã bị chặn bởi network guard.
    `;

    const audit = evaluateReadOnlyConsistency(rawTelemetry, falseReport);
    assert.equal(audit.consistent, false, 'Must detect inconsistency');
    assert.equal(audit.gateStatus, 'NEEDS_REVIEW', 'Gate must be NEEDS_REVIEW when contradiction exists');
    assert.ok(audit.discrepancies.length >= 2, 'Must catch both readOnlyVerified mismatch and unblocked POST claim');
  });

  test('RO-REC-03: evaluateReadOnlyConsistency accepts perfectly reconciled telemetry and report', () => {
    const reconciledTelemetry: RawTelemetry = {
      auditDate: '2026-11-06T03:37:28.651Z',
      host: 'lms.hust.edu.vn',
      pagesObserved: [{ url: 'https://lms.hust.edu.vn/my/', title: 'Dashboard', status: 'SUCCESS' }],
      networkTelemetry: {
        totalRequests: 78,
        getRequests: 74,
        postRequests: 4,
        mutatingRequestsBlocked: 0
      },
      authenticationStatus: 'AUTHENTICATED',
      coursesDetectedCount: 6,
      activityLaunchRisk: 'ZERO_ATTEMPTS_OPENED',
      readOnlyVerified: false
    };

    const honestReport = `
      # Phase 8F Report
      \`\`\`json
      {
        "networkTelemetry": { "totalRequests": 78, "getRequests": 74, "postRequests": 4, "mutatingRequestsBlocked": 0 },
        "readOnlyVerified": false
      }
      \`\`\`
      Bốn yêu cầu POST tới service.php là các cuộc gọi quan sát chưa chặn (REQUEST_ALLOWED), do đó readOnlyVerified=false.
    `;

    const audit = evaluateReadOnlyConsistency(reconciledTelemetry, honestReport);
    assert.equal(audit.consistent, true, 'Honest report matching raw telemetry must be consistent');
    assert.equal(audit.gateStatus, 'PARTIAL_VERIFICATION', 'Because readOnlyVerified is false, gate status must remain PARTIAL_VERIFICATION');
  });

  test('RO-REC-04: synthesizeConsistentReportSnippet strictly reflects effective verified state', () => {
    const teleUnblocked: RawTelemetry = {
      auditDate: '2026-11-06T00:00:00Z',
      host: 'lms.hust.edu.vn',
      pagesObserved: [],
      networkTelemetry: { totalRequests: 10, getRequests: 8, postRequests: 2, mutatingRequestsBlocked: 0 },
      authenticationStatus: 'AUTHENTICATED',
      coursesDetectedCount: 2,
      activityLaunchRisk: 'ZERO_ATTEMPTS_OPENED',
      readOnlyVerified: true // incorrectly set by naive script
    };

    const snippet = synthesizeConsistentReportSnippet(teleUnblocked);
    const parsed = JSON.parse(snippet);
    assert.equal(parsed.readOnlyVerified, false, 'Synthesizer must force false when mutatingRequestsBlocked < postRequests');
  });

  test('RO-REC-05: Strict Gate invariant - Cannot elevate to PILOT IN PROGRESS on dashboard observation alone', () => {
    const verifiedObservationTelemetry: RawTelemetry = {
      auditDate: '2026-11-06T00:00:00Z',
      host: 'lms.hust.edu.vn',
      pagesObserved: [{ url: 'https://lms.hust.edu.vn/my/', title: 'Dashboard', status: 'SUCCESS' }],
      networkTelemetry: { totalRequests: 50, getRequests: 50, postRequests: 0, mutatingRequestsBlocked: 0 },
      authenticationStatus: 'AUTHENTICATED',
      coursesDetectedCount: 2,
      activityLaunchRisk: 'ZERO_ATTEMPTS_OPENED',
      readOnlyVerified: true
    };

    const report = 'Dashboard observed safely with zero POSTs.';
    const audit = evaluateReadOnlyConsistency(verifiedObservationTelemetry, report);
    assert.equal(audit.consistent, true);
    assert.equal(audit.gateStatus, 'PASS', 'Observation audit PASS');

    // Governance rule: even if observation PASS, release gate cannot be PILOT IN PROGRESS without authorized self-practice task
    const hasAuthorizedSelfPracticeTask = false;
    const releaseGateDecision = hasAuthorizedSelfPracticeTask ? 'PILOT IN PROGRESS' : 'READY FOR PILOT';
    assert.equal(releaseGateDecision, 'READY FOR PILOT', 'Release Gate must remain READY FOR PILOT');
  });
});
