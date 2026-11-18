import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import {
  KNOWN_MOODLE_HOSTS,
  platformForUrl,
  moodleDomSignals,
  detectPlatform
} from '../src/platforms.js';
import { ensureAllowed, validateConfig } from '../src/config.js';
import { scanQuestions } from '../src/scanner.js';
import { isAuthRequired } from '../src/browser/verified-navigation.js';
import { openHtml } from './fixtures/browser-harness.js';

let browser: Browser;

describe('Phase 1 — LMS Platform Matrix, Spoofed Host Protection & Scope Isolation', () => {
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('PMAT-01: distinguishes HUSTLMS, Fintech Moodle, FAMI/Số hóa, English Discoveries, and Forms by URL', () => {
    assert.deepEqual([...KNOWN_MOODLE_HOSTS], ['lms.hust.edu.vn', 'lms.fintech.hust.edu.vn']);

    // Verified HUST Moodle hosts
    assert.equal(platformForUrl('https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=10&cmid=4'), 'moodle');
    assert.equal(platformForUrl('https://LMS.FINTECH.HUST.EDU.VN/course/view.php?id=18'), 'moodle');

    // HUST Số hóa / FAMI has its own dedicated adapter, never classified as Moodle
    assert.equal(platformForUrl('https://fami.hust.edu.vn/sohoa/phong-hoc'), 'fami');
    assert.equal(platformForUrl('https://fami.hust.edu.vn/sohoa/thi-lt'), 'fami');

    // English Discoveries is a distinct platform, never defaulted to Moodle
    assert.equal(platformForUrl('https://englishdiscoveries.net/'), 'english-discoveries');
    assert.equal(platformForUrl('https://ed.englishdiscoveries.net/Runtime/Lesson'), 'english-discoveries');
    assert.equal(platformForUrl('https://hust.englishdiscoveries.net/student/dashboard'), 'english-discoveries');

    // Unknown academic host defaults to generic until verified by user config or allowed DOM signal
    assert.equal(platformForUrl('https://moodle.dept.example.edu/mod/quiz/view.php?id=5'), 'generic');
    assert.equal(
      platformForUrl('https://moodle.dept.example.edu/mod/quiz/view.php?id=5', ['moodle.dept.example.edu']),
      'moodle'
    );
  });

  test('PMAT-02: rejects spoofed hostnames in both platform classification and ensureAllowed()', () => {
    const spoofedUrls = [
      'https://lms.hust.edu.vn.evil.com/mod/quiz/attempt.php',
      'https://lms.fintech.hust.edu.vn.attacker.org/login/index.php',
      'https://evil-lms.hust.edu.vn/mod/quiz/view.php',
      'https://sub.lms.hust.edu.vn/mod/quiz/view.php',
      'https://fakeenglishdiscoveries.net/lesson/1',
      'https://englishdiscoveries.net.phish.io/lesson/1',
      'https://fami.hust.edu.vn.evil.net/sohoa/phong-hoc'
    ];
    const approved = ['lms.hust.edu.vn', 'lms.fintech.hust.edu.vn', 'englishdiscoveries.net', 'ed.englishdiscoveries.net', 'fami.hust.edu.vn'];

    for (const bad of spoofedUrls) {
      assert.equal(platformForUrl(bad), 'generic', `Spoofed URL must not match an LMS adapter: ${bad}`);
      assert.throws(
        () => ensureAllowed(bad, approved),
        /không nằm trong allowedHosts/i,
        `Spoofed URL must be blocked by ensureAllowed: ${bad}`
      );
    }
  });

  test('PMAT-03: detectPlatform uses Moodle DOM signals ONLY for hosts already in allowedHosts and never mutates allowedHosts', async () => {
    const moodleHtml = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"></head>
      <body class="path-mod-quiz"><div class="que multichoice"><div class="formulation"><div class="qtext">Q?</div></div></div></body></html>`;

    // Case A: Custom Moodle host IS in allowedHosts -> recognized via DOM signals without mutating allowedHosts
    const allowedA = Object.freeze(['moodle.dept.example.edu']);
    const pageA = await openHtml(browser, 'https://moodle.dept.example.edu/mod/quiz/attempt.php?attempt=1', moodleHtml);
    try {
      assert.equal(await moodleDomSignals(pageA), true);
      assert.equal(await detectPlatform(pageA, allowedA), 'moodle');
      assert.deepEqual([...allowedA], ['moodle.dept.example.edu']);
    } finally {
      await pageA.context().close();
    }

    // Case B: Unapproved host has Moodle DOM signals -> MUST NOT be promoted to 'moodle' and allowedHosts stays unchanged
    const allowedB = Object.freeze(['lms.hust.edu.vn']);
    const pageB = await openHtml(browser, 'https://unapproved-moodle.example.org/mod/quiz/attempt.php?attempt=1', moodleHtml);
    try {
      assert.equal(await moodleDomSignals(pageB), true);
      assert.equal(await detectPlatform(pageB, allowedB), 'generic');
      assert.deepEqual([...allowedB], ['lms.hust.edu.vn']);
    } finally {
      await pageB.context().close();
    }

    // Case C: FAMI and English Discoveries are NEVER reclassified as Moodle even if DOM contains .qtext
    const pageFami = await openHtml(browser, 'https://fami.hust.edu.vn/sohoa/phong-hoc', moodleHtml);
    const pageEd = await openHtml(browser, 'https://ed.englishdiscoveries.net/lesson/2', moodleHtml);
    try {
      assert.equal(await detectPlatform(pageFami, ['fami.hust.edu.vn']), 'fami');
      assert.equal(await detectPlatform(pageEd, ['ed.englishdiscoveries.net']), 'english-discoveries');
    } finally {
      await pageFami.context().close();
      await pageEd.context().close();
    }
  });

  test('PMAT-04: moodleHosts in AppConfig validates hostnames strictly and does not bypass allowedHosts', () => {
    assert.throws(() => validateConfig({
      allowedHosts: ['lms.hust.edu.vn'],
      moodleHosts: ['https://custom-moodle.edu.vn/path'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [{ id: 't1', url: 'https://lms.hust.edu.vn/mod/quiz/view.php?id=1', aiPermitted: true }],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
    }), /moodleHosts/i);

    // Listing a host in moodleHosts without listing it in allowedHosts STILL blocks task execution
    assert.throws(() => validateConfig({
      allowedHosts: ['lms.hust.edu.vn'],
      moodleHosts: ['custom-moodle.edu.vn'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [{ id: 't1', url: 'https://custom-moodle.edu.vn/mod/quiz/view.php?id=1', aiPermitted: true }],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
    }), /không nằm trong allowedHosts/i);
  });

  test('PMAT-05: Moodle / SSO login pages are never scanned as quiz questions', async () => {
    const loginHtml = `<!DOCTYPE html><html lang="vi"><head><meta name="generator" content="Moodle"><title>HUSTLMS: Đăng nhập</title></head>
      <body class="pagelayout-login">
        <form id="login" action="https://lms.hust.edu.vn/login/index.php" method="post">
          <label for="username">Tên tài khoản</label>
          <input type="text" name="username" id="username" autocomplete="username">
          <label for="password">Mật khẩu</label>
          <input type="password" name="password" id="password" autocomplete="current-password">
          <input type="checkbox" name="rememberusername" id="rememberusername" value="1">
          <label for="rememberusername">Nhớ tên tài khoản</label>
          <button type="submit" id="loginbtn">Đăng nhập</button>
        </form>
      </body></html>`;
    const page = await openHtml(browser, 'https://lms.hust.edu.vn/login/index.php', loginHtml);
    try {
      const qs = await scanQuestions(page);
      assert.deepEqual(qs, [], 'Login form fields (username, password, remember-me) must never be extracted as questions');
      assert.equal(await isAuthRequired(page), true);
    } finally {
      await page.context().close();
    }
  });
});
