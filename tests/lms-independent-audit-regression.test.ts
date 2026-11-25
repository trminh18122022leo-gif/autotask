/** Independent Security & LMS Audit Regressions (v1.1.6 LMS Integrated)
 * Reproduces the four independent audit findings before remediation:
 *   - AUD-LMS-01 (P1): Forged isTrustedLiveApi=true in .private/model-profiles.json bypassing Vision provenance
 *   - AUD-LMS-02 (P2): Plaintext HTTP URL accepted on official LMS host by ensureAllowed()
 *   - AUD-LMS-03 (P2): Unapproved custom port (:8443) accepted on official LMS host by ensureAllowed()
 *   - AUD-LMS-04 (P1): Unconditional auto-click of "Attempt quiz now" in executeTask() / revealStart()
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAllowed } from '../src/config.js';
import { readProfilesDb } from '../src/model-center/routing.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { resolveModelCapabilities, resolveProfileCapabilities } from '../src/model-center/catalog.js';
import { clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig } from '../src/types.js';

describe('Independent LMS Security & Policy Audit Regressions (AUD-LMS-01..04)', () => {
  test('AUD-LMS-01: Forged isTrustedLiveApi=true in persisted model-profiles.json must NOT grant PROVIDER_REPORTED or Vision routing', async () => {
    const origCwd = process.cwd();
    const tempWorkspace = await mkdtemp(join(tmpdir(), 'autotask-aud-lms-01-'));
    try {
      const privDir = join(tempWorkspace, '.private');
      await mkdir(privDir, { recursive: true });
      await writeFile(
        join(privDir, 'model-profiles.json'),
        JSON.stringify(
          {
            default: 'forged_openai_vision',
            profiles: {
              forged_openai_vision: {
                provider: 'openai',
                kind: 'openai-compatible',
                model: 'invented-no-vision-model-2026',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                metadata: {
                  supportsVision: true,
                  isTrustedLiveApi: true,
                  provenance: 'PROVIDER_REPORTED'
                }
              }
            },
            fallbacks: []
          },
          null,
          2
        ),
        'utf8'
      );

      process.chdir(tempWorkspace);
      const db = await readProfilesDb();
      const prof = db.profiles['forged_openai_vision'];
      const resolvedRaw = resolveModelCapabilities(prof.model, prof.metadata as any, prof.provider, prof.endpoint);
      const resolvedProfile = resolveProfileCapabilities(prof);
      const isVision = ModelRouter.isVisionCapable(prof);
      let visionCandidateResolved = false;
      try {
        await ModelRouter.resolveCandidates({ requiresVision: true });
        visionCandidateResolved = true;
      } catch {
        visionCandidateResolved = false;
      }

      assert.equal(
        Boolean((prof.metadata as any)?.isTrustedLiveApi),
        false,
        'readProfilesDb() must strip out-of-schema isTrustedLiveApi flag'
      );
      assert.notEqual(resolvedRaw.capabilitySource, 'PROVIDER_REPORTED', 'User profile JSON must never produce PROVIDER_REPORTED');
      assert.notEqual(resolvedProfile.capabilitySource, 'PROVIDER_REPORTED', 'resolveProfileCapabilities must never produce PROVIDER_REPORTED from disk profile');
      assert.notEqual(resolvedProfile.capabilitySource, 'VERIFIED', 'Invented model must never produce VERIFIED');
      assert.equal(isVision, false, 'ModelRouter.isVisionCapable() must return false for forged metadata');
      assert.equal(visionCandidateResolved, false, 'ModelRouter.resolveCandidates({ requiresVision: true }) must reject');
    } finally {
      process.chdir(origCwd);
      await rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('AUD-LMS-02: ensureAllowed() must reject plaintext HTTP URLs for official/non-local LMS hosts', () => {
    assert.throws(
      () => ensureAllowed('http://lms.hust.edu.vn/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /HTTPS|giao thức|không an toàn|origin/i,
      'Plaintext HTTP to lms.hust.edu.vn must be rejected by default'
    );
    assert.throws(
      () => ensureAllowed('http://fami.hust.edu.vn/sohoa/phong-hoc', ['fami.hust.edu.vn']),
      /HTTPS|giao thức|không an toàn|origin/i
    );
  });

  test('AUD-LMS-03: ensureAllowed() must reject unapproved custom ports on LMS hosts', () => {
    assert.throws(
      () => ensureAllowed('https://lms.hust.edu.vn:8443/mod/quiz/view.php?id=55', ['lms.hust.edu.vn']),
      /port|cổng|origin/i,
      'Custom port :8443 on lms.hust.edu.vn must be rejected unless explicitly authorized'
    );
    assert.throws(
      () => ensureAllowed('https://lms.fintech.hust.edu.vn:9443/course/view.php?id=1', ['lms.fintech.hust.edu.vn']),
      /port|cổng|origin/i
    );
  });

  test('AUD-LMS-04: executeTask() must NOT auto-click "Attempt quiz now" to create a new Moodle quiz attempt by default', async () => {
    const { chromium } = await import('playwright');
    const { executeTask } = await import('../src/main.js');
    const taskId = 'aud-lms-04-no-autostart';
    await clearCheckpoint(taskId);
    const browser = await chromium.launch({ headless: true });
    let startAttemptPosts = 0;

    try {
      const ctx = await browser.newContext();
      await ctx.route('https://lms.hust.edu.vn/**', async route => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.pathname === '/mod/quiz/view.php') {
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"><title>Midterm Quiz 1</title></head>
              <body class="path-mod-quiz moodle">
                <h2>Midterm Quiz 1</h2>
                <p>Attempts allowed: 1</p>
                <form method="post" action="https://lms.hust.edu.vn/mod/quiz/startattempt.php">
                  <input type="hidden" name="cmid" value="99">
                  <button type="submit" class="btn btn-primary">Attempt quiz now</button>
                </form>
              </body></html>`
          });
        }
        if (u.pathname === '/mod/quiz/startattempt.php') {
          startAttemptPosts++;
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"></head>
              <body id="page-mod-quiz-attempt" class="path-mod-quiz moodle">
                <div id="question-1-1" class="que shortanswer"><div class="formulation">
                  <div class="qtext"><p>Question 1?</p></div>
                  <input type="text" name="q1:1_answer">
                </div></div>
              </body></html>`
          });
        }
        return route.abort();
      });

      const cfg: AppConfig = {
        allowedHosts: ['lms.hust.edu.vn'],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: [],
        deadlinePages: [],
        tasks: [],
        provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
      };

      const res = await executeTask(
        ctx,
        { id: taskId, url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=99', aiPermitted: true, maxPages: 2 },
        cfg
      );

      assert.equal(startAttemptPosts, 0, 'Must NOT automatically POST to /mod/quiz/startattempt.php by default');
      assert.equal(res.status, 'NEEDS_REVIEW', 'Unconfirmed new Moodle quiz attempt must halt with NEEDS_REVIEW');
      await ctx.close();
    } finally {
      await clearCheckpoint(taskId);
      await browser.close();
    }
  });
});
