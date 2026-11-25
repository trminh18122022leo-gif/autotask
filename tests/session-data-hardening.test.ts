/** Phase 8G — Session Data Hardening & Safe Read-Only AJAX Test Suite (HARDEN-01..16)
 *
 * Verifies:
 * 1. Complete secret redaction for sesskey, MoodleSession, OAuth tokens, tickets, codes, URL-encoded parameters, and repeated secrets.
 * 2. Accurate classification of safe read-only Moodle AJAX services vs dangerous mutating endpoints.
 * 3. Fail-closed behavior for unknown or ambiguous network requests in READ_ONLY mode.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactObject } from '../src/security/redact.js';
import { isSafeReadOnlyAjaxRequest, SAFE_READ_ONLY_AJAX_METHODS, isStateMutatingActionUrl } from '../src/operation-mode.js';

describe('Phase 8G — Session Data Hardening & Secret Redaction (HARDEN-01..08)', () => {
  test('HARDEN-01: Redacts sesskey query param from Moodle service URLs', () => {
    const rawUrl = 'https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=testSesskeyVal99&info=media_videojs_get_language';
    const redacted = redactSecrets(rawUrl);
    assert.ok(!redacted.includes('testSesskeyVal99'), 'Raw sesskey must not appear in redacted output');
    assert.ok(redacted.includes('sesskey=[REDACTED]'), 'sesskey must be replaced with [REDACTED]');
    assert.ok(redacted.includes('info=media_videojs_get_language'), 'Non-sensitive query params must be preserved');
  });

  test('HARDEN-02: Redacts multiple repeated occurrences of sesskey in the same string', () => {
    const input = 'sesskey=AAA111BBB and later redirected to /view.php?sesskey=CCC222DDD&action=view';
    const redacted = redactSecrets(input);
    assert.ok(!redacted.includes('AAA111BBB'), 'First sesskey must be redacted');
    assert.ok(!redacted.includes('CCC222DDD'), 'Second sesskey must be redacted');
  });

  test('HARDEN-03: Redacts URL-encoded query parameters (%26sesskey%3D..., %3Fticket%3D...)', () => {
    const encodedUrl = 'https://sso.hust.edu.vn/cas/login?service=https%3A%2F%2Flms.hust.edu.vn%2Flogin%2Findex.php%3Fsesskey%3DsecretSessKey123%26ticket%3DST-987654321-cas';
    const redacted = redactSecrets(encodedUrl);
    assert.ok(!redacted.includes('secretSessKey123'), 'URL-encoded sesskey must not appear');
    assert.ok(!redacted.includes('ST-987654321-cas'), 'URL-encoded ticket must not appear');
    assert.ok(redacted.includes('%3Fsesskey%3D[REDACTED]') || redacted.includes('sesskey%3D[REDACTED]'), 'Must replace with [REDACTED]');
  });

  test('HARDEN-04: Redacts Microsoft OAuth code, state, access_token and wantsurl', () => {
    const oauthUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=my-app-id&code=M.R3_BAY.secret_auth_code_7788&state=state_entropy_9988&wantsurl=https://lms.hust.edu.vn/my/';
    const redacted = redactSecrets(oauthUrl);
    assert.ok(!redacted.includes('secret_auth_code_7788'), 'OAuth code must be redacted');
    assert.ok(!redacted.includes('state_entropy_9988'), 'OAuth state must be redacted');
    assert.ok(redacted.includes('code=[REDACTED]'), 'code must be replaced with [REDACTED]');
    assert.ok(redacted.includes('state=[REDACTED]'), 'state must be replaced with [REDACTED]');
    assert.ok(redacted.includes('wantsurl=[REDACTED]'), 'wantsurl must be replaced with [REDACTED]');
  });

  test('HARDEN-05: Redacts MoodleSession and ESTSAUTH cookies in cookie headers', () => {
    const cookieHeader = 'Cookie: MoodleSession=moodle_session_hash_abcdef123456; ESTSAUTH=ests_cookie_val_xyz; ESTSAUTHPERSISTENT=persistent_token_123';
    const redacted = redactSecrets(cookieHeader);
    assert.ok(!redacted.includes('moodle_session_hash_abcdef123456'), 'MoodleSession cookie value must be redacted');
    assert.ok(!redacted.includes('ests_cookie_val_xyz'), 'ESTSAUTH cookie value must be redacted');
    assert.ok(!redacted.includes('persistent_token_123'), 'ESTSAUTHPERSISTENT cookie value must be redacted');
  });

  test('HARDEN-06: redactObject recursively sanitizes objects and Error cause structures', () => {
    const payload = {
      sesskey: 'sensitive_sesskey_value_999',
      ticket: 'ST-00000-xyz',
      nested: {
        code: 'auth_code_123',
        url: 'https://lms.hust.edu.vn/my/?sesskey=embedded_sesskey_456'
      }
    };
    const cleaned = redactObject(payload);
    assert.equal(cleaned.sesskey, '[REDACTED_KEY]');
    assert.equal(cleaned.ticket, '[REDACTED_CREDENTIAL]');
    assert.equal(cleaned.nested.code, '[REDACTED_CREDENTIAL]');
    assert.ok(!cleaned.nested.url.includes('embedded_sesskey_456'));
    assert.ok(cleaned.nested.url.includes('sesskey=[REDACTED]'));
  });

  test('HARDEN-07: Error instances sanitize sensitive tokens in both message and stack', () => {
    const err = new Error('Failed to fetch https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=err_sesskey_leak_789');
    const cleanedErr = redactObject(err);
    assert.ok(!cleanedErr.message.includes('err_sesskey_leak_789'), 'Error message must not leak sesskey');
    assert.ok(cleanedErr.message.includes('sesskey=[REDACTED]'), 'Error message must show [REDACTED]');
    if (cleanedErr.stack) {
      assert.ok(!cleanedErr.stack.includes('err_sesskey_leak_789'), 'Error stack must not leak sesskey');
    }
  });

  test('HARDEN-08: Synthetic token corpus fuzzing proves zero leak across 20 synthetic secrets', () => {
    const syntheticSecrets = Array.from({ length: 20 }, (_, i) => `synthetic_secret_${i}_${Math.random().toString(36).substring(2)}`);
    for (const secret of syntheticSecrets) {
      const url = `https://lms.hust.edu.vn/endpoint?sesskey=${secret}&other=safe`;
      const cleaned = redactSecrets(url);
      assert.ok(!cleaned.includes(secret), `Synthetic secret ${secret} must never leak in cleaned URL`);
    }
  });
});

describe('Phase 8G — Safe Read-Only AJAX Services & Moodle Metadata Allowlist (HARDEN-09..16)', () => {
  test('HARDEN-09: SAFE_READ_ONLY_AJAX_METHODS contains required official Moodle metadata services', () => {
    assert.ok(SAFE_READ_ONLY_AJAX_METHODS.has('core_course_get_enrolled_courses_by_timeline_classification'));
    assert.ok(SAFE_READ_ONLY_AJAX_METHODS.has('core_course_get_recent_courses'));
    assert.ok(SAFE_READ_ONLY_AJAX_METHODS.has('core_calendar_get_action_events_by_timesort'));
    assert.ok(SAFE_READ_ONLY_AJAX_METHODS.has('media_videojs_get_language'));
    assert.ok(SAFE_READ_ONLY_AJAX_METHODS.has('core_output_load_template_with_dependencies'));
  });

  test('HARDEN-10: GET to service-nologin.php with template loading is safe', () => {
    const url = 'https://lms.hust.edu.vn/lib/ajax/service-nologin.php?info=core_output_load_template_with_dependencies&cachekey=1789354411';
    assert.equal(isSafeReadOnlyAjaxRequest('GET', url), true);
  });

  test('HARDEN-11: POST to service.php with enrolled courses timeline classification is safe', () => {
    const url = 'https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=mockSesskey123&info=core_course_get_enrolled_courses_by_timeline_classification';
    assert.equal(isSafeReadOnlyAjaxRequest('POST', url), true);
  });

  test('HARDEN-12: POST to service.php with recent courses is safe', () => {
    const url = 'https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=mockSesskey123&info=core_course_get_recent_courses';
    assert.equal(isSafeReadOnlyAjaxRequest('POST', url), true);
  });

  test('HARDEN-13: POST to service.php with videojs language is safe', () => {
    const url = 'https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=mockSesskey123&info=media_videojs_get_language';
    assert.equal(isSafeReadOnlyAjaxRequest('POST', url), true);
  });

  test('HARDEN-14: POST to service.php with JSON body containing safe method is safe', () => {
    const url = 'https://lms.hust.edu.vn/lib/ajax/service.php?sesskey=mockSesskey123';
    const body = JSON.stringify([{ index: 0, methodname: 'core_calendar_get_action_events_by_timesort', args: {} }]);
    assert.equal(isSafeReadOnlyAjaxRequest('POST', url, body), true);
  });

  test('HARDEN-15: Dangerous mutating calls (quiz attempt, autosave, submission) are strictly rejected', () => {
    const dangerousUrls = [
      'https://lms.hust.edu.vn/lib/ajax/service.php?info=mod_quiz_save_attempt',
      'https://lms.hust.edu.vn/lib/ajax/service.php?info=mod_quiz_process_attempt',
      'https://lms.hust.edu.vn/lib/ajax/service.php?info=core_enrol_unenrol_user_enrolment',
      'https://lms.hust.edu.vn/lib/ajax/service-nologin.php?info=mod_quiz_save_attempt'
    ];
    for (const dUrl of dangerousUrls) {
      assert.equal(isSafeReadOnlyAjaxRequest('POST', dUrl), false, `Must reject dangerous endpoint ${dUrl}`);
      assert.equal(isSafeReadOnlyAjaxRequest('GET', dUrl), false, `Must reject dangerous endpoint ${dUrl} via GET`);
    }
  });

  test('HARDEN-16: Unknown AJAX services fail closed (return false)', () => {
    const unknownUrl = 'https://lms.hust.edu.vn/lib/ajax/service.php?info=custom_third_party_unknown_service';
    assert.equal(isSafeReadOnlyAjaxRequest('POST', unknownUrl), false, 'Unknown service must fail closed');

    const nonServiceUrl = 'https://lms.hust.edu.vn/mod/quiz/startattempt.php';
    assert.equal(isSafeReadOnlyAjaxRequest('POST', nonServiceUrl), false, 'Direct mutating path is never safe AJAX');
  });
});
