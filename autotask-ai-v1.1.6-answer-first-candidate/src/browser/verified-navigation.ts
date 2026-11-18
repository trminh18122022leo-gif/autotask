/** Verified Navigation Service
 * Unifies the Observe -> Act -> Verify protocol across both normal browser progression and resume recovery.
 * Guarantees that neither normal progression nor resume advancement ever increments a step or records
 * a checkpoint without verified proof of actual DOM transition.
 */
import type { Page } from 'playwright';
import { locateNext } from '../interaction.js';
import { scanQuestions } from '../scanner.js';
import { ensureAllowed, isApprovedSsoOrigin, originTrustFromConfig } from '../config.js';
import { observeAccess, mostRestrictive } from '../access-gates.js';
import type { AppConfig } from '../types.js';

export interface VerifiedNavigationResult {
  success: boolean;
  state:
    | 'ADVANCED'
    | 'NO_CHANGE'
    | 'VALIDATION_ERROR'
    | 'AUTH_REQUIRED'
    | 'ACCESS_RESTRICTED'
    | 'HOST_MISMATCH'
    | 'BUTTON_DISABLED'
    | 'SUBMIT_GUARD'
    | 'TIMEOUT'
    | 'NEEDS_REVIEW'
    | 'ERROR';
  reason: string;
  beforeUrl: string;
  afterUrl: string;
  questionsBefore: number;
  questionsAfter: number;
  httpStatus?: number;
}

/** Detects whether the current live page represents a login or authentication barrier */
export async function isAuthRequired(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const hasPasswordField = Boolean(document.querySelector('input[type="password"]'));
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const authKeywords = [
        'đăng nhập',
        'sign in',
        'log in',
        'xác thực tập trung',
        'cas - central authentication service',
        'nhập mật khẩu',
        'enter password',
        'vui lòng đăng nhập để tiếp tục'
      ];
      const hasAuthText = authKeywords.some(kw => bodyText.includes(kw));
      return hasPasswordField || (hasAuthText && Boolean(document.querySelector('form, button[type="submit"]')));
    });
  } catch {
    return false;
  }
}

/** Executes verified navigation using the strict Observe -> Act -> Verify protocol */
export async function executeVerifiedNavigation(
  page: Page,
  config: AppConfig,
  nextButtonSelector?: string,
  currentStep?: number
): Promise<VerifiedNavigationResult> {
  const beforeUrl = page.url();

  // 1. Observe: Check if page is currently blocked by auth or access gate
  if (await isAuthRequired(page)) {
    return {
      success: false,
      state: 'AUTH_REQUIRED',
      reason: 'Trang hiện tại đang ở màn hình xác thực/đăng nhập',
      beforeUrl,
      afterUrl: beforeUrl,
      questionsBefore: 0,
      questionsAfter: 0
    };
  }

  const initialGates = await observeAccess(page);
  if (mostRestrictive(initialGates)) {
    return {
      success: false,
      state: 'ACCESS_RESTRICTED',
      reason: 'Trang hiện tại đang bị chặn bởi cổng chờ thời gian hoặc quyền truy cập',
      beforeUrl,
      afterUrl: beforeUrl,
      questionsBefore: 0,
      questionsAfter: 0
    };
  }

  // Snapshot before click
  const beforeQuestions = await scanQuestions(page);
  const getDomInputSignature = async (): Promise<string> => {
    return page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, [role="radio"], [role="checkbox"]'
      )).filter(el => {
        const s = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && (rect.width > 0 || rect.height > 0);
      });
      return inputs.map(el => {
        const id = el.id || '';
        const name = (el as HTMLInputElement).name || '';
        const aria = el.getAttribute('aria-label') || '';
        return `${el.tagName}:${id}:${name}:${aria}`;
      }).sort().join('|');
    }).catch(() => '');
  };
  const beforeInputSig = await getDomInputSignature();

  // 2. Locate Next button safely (never click Submit / Finish disguised as Next)
  const originOpts = originTrustFromConfig(config);
  const nextResult = await locateNext(page, config.allowedHosts, nextButtonSelector, originOpts);
  if (!nextResult) {
    return {
      success: false,
      state: 'SUBMIT_GUARD',
      reason: 'Không tìm thấy nút Tiếp theo hợp lệ hoặc kích hoạt bảo vệ nút nộp bài (Submit guard)',
      beforeUrl,
      afterUrl: beforeUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: beforeQuestions.length
    };
  }

  // 3. Verify Next button is enabled
  const isDisabled = await nextResult.next.isDisabled().catch(() => false);
  if (isDisabled) {
    return {
      success: false,
      state: 'BUTTON_DISABLED',
      reason: 'Nút Tiếp theo đang bị vô hiệu hóa (disabled)',
      beforeUrl,
      afterUrl: beforeUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: beforeQuestions.length
    };
  }

  // 4. Act: Click Next with safe timeout while tracking main-frame HTTP navigation status
  let navHttpStatus: number | undefined;
  const onResponse = (resp: import('playwright').Response) => {
    try {
      if (resp.frame() === page.mainFrame() && resp.request().isNavigationRequest()) {
        navHttpStatus = resp.status();
      }
    } catch {}
  };
  page.on('response', onResponse);
  try {
    await nextResult.next.click({ timeout: 5000 });
    await page.waitForTimeout(700);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  } catch (err) {
    return {
      success: false,
      state: 'TIMEOUT',
      reason: `Thao tác click nút Tiếp theo bị timeout hoặc lỗi: ${err instanceof Error ? err.message : String(err)}`,
      beforeUrl,
      afterUrl: beforeUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: beforeQuestions.length
    };
  } finally {
    page.off('response', onResponse);
  }

  // 4b. Verify: Reject HTTP 4xx/5xx server error responses so failed saves never masquerade as page transitions
  if (navHttpStatus !== undefined && navHttpStatus >= 400) {
    const errUrl = page.url();
    return {
      success: false,
      state: 'ERROR',
      httpStatus: navHttpStatus,
      reason: `Máy chủ trả về lỗi HTTP ${navHttpStatus} khi chuyển trang / lưu nháp; dữ liệu chưa được xác nhận lưu trên server`,
      beforeUrl,
      afterUrl: errUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: 0
    };
  }

  // 5. Verify: Check Strict Origin Allowlist & Approved SSO Redirects
  const afterUrl = page.url();
  try {
    ensureAllowed(afterUrl, config.allowedHosts, originOpts);
  } catch (originErr) {
    const isAuth = await isAuthRequired(page);
    let destOrigin = afterUrl;
    try { destOrigin = new URL(afterUrl).origin; } catch {}

    if (isAuth && isApprovedSsoOrigin(afterUrl, config)) {
      return {
        success: false,
        state: 'AUTH_REQUIRED',
        reason: `Chuyển hướng hợp lệ sang cổng xác thực SSO được phê duyệt: ${destOrigin}`,
        beforeUrl,
        afterUrl,
        questionsBefore: beforeQuestions.length,
        questionsAfter: 0
      };
    }

    return {
      success: false,
      state: 'HOST_MISMATCH',
      reason: `Chuyển hướng tới origin ngoài danh sách cho phép (${destOrigin}): ${originErr instanceof Error ? originErr.message : String(originErr)}`,
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: 0
    };
  }

  // 6. Verify: Check Access Gates
  const postGates = await observeAccess(page);
  if (mostRestrictive(postGates)) {
    return {
      success: false,
      state: 'ACCESS_RESTRICTED',
      reason: 'Cổng chờ thời gian hoặc giới hạn truy cập xuất hiện sau khi click',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: 0
    };
  }

  // 7. Verify: Check Validation Errors on DOM
  const hasValidationError = await page.evaluate(() => {
    const errSelectors = '.error, .validation-error, [aria-invalid="true"], .has-error, .is-invalid, .alert-danger, .form-error';
    const hasErrEl = Boolean(document.querySelector(errSelectors));
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const errKeywords = [
      'câu hỏi này là bắt buộc',
      'this question is required',
      'this field is required',
      'vui lòng trả lời',
      'please answer',
      'bắt buộc phải điền',
      'please select an answer',
      'vui lòng chọn một đáp án'
    ];
    return hasErrEl || errKeywords.some(kw => bodyText.includes(kw));
  }).catch(() => false);

  if (hasValidationError) {
    return {
      success: false,
      state: 'VALIDATION_ERROR',
      reason: 'Biểu mẫu phát hiện lỗi xác thực dữ liệu (validation error) trên DOM sau khi click',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: beforeQuestions.length
    };
  }

  // 8. Verify: Check Auth Barrier
  if (await isAuthRequired(page)) {
    return {
      success: false,
      state: 'AUTH_REQUIRED',
      reason: 'Trang yêu cầu xác thực sau khi click Tiếp theo',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: 0
    };
  }

  // 9. Verify: Post-click Question State & Step Transition Assertion
  const afterQuestions = await scanQuestions(page);
  const afterInputSig = await getDomInputSignature();

  const fingerprintQuestion = (q: { kind: string; prompt: string; options?: Array<{ text: string }> }) =>
    `${q.kind}:${q.prompt}:${(q.options || []).map(o => o.text).join('|')}`;
  const beforeQSig = beforeQuestions.map(fingerprintQuestion).sort().join(';;;');
  const afterQSig = afterQuestions.map(fingerprintQuestion).sort().join(';;;');

  const questionsChanged =
    (beforeQuestions.length > 0 && afterQuestions.length > 0 && beforeQSig !== afterQSig) ||
    (beforeInputSig !== '' && afterInputSig !== '' && beforeInputSig !== afterInputSig) ||
    (beforeQuestions.length !== afterQuestions.length && afterQuestions.length > 0);

  const stepChanged = await page.evaluate((expectedStep) => {
    const bodyText = document.body?.innerText || '';
    return (
      bodyText.includes(`Trang ${expectedStep}`) ||
      bodyText.includes(`Page ${expectedStep}`) ||
      bodyText.includes(`Step ${expectedStep}`) ||
      bodyText.includes(`Bước ${expectedStep}`)
    );
  }, (currentStep || 1) + 1).catch(() => false);

  // SPA Same-URL Transition (AUD-114-06):
  // When URL stays identical in an SPA, but DOM questions have changed into a new set, transition is valid!
  if (beforeUrl === afterUrl && questionsChanged) {
    return {
      success: true,
      state: 'ADVANCED',
      reason: 'Chuyển bước thành công trên Single-Page Application (câu hỏi DOM đã chuyển sang tập mới)',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: afterQuestions.length
    };
  }

  // If URL stayed identical, questions did not change, and step indicator did not change: no-op button
  if (beforeUrl === afterUrl && !questionsChanged && !stepChanged) {
    return {
      success: false,
      state: 'NO_CHANGE',
      reason: 'Nút Tiếp theo không làm thay đổi DOM hoặc URL (no-op button)',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: afterQuestions.length
    };
  }

  // If URL changed:
  if (beforeUrl !== afterUrl) {
    // Check if only hash changed without question or step indicator change
    try {
      const uBefore = new URL(beforeUrl);
      const uAfter = new URL(afterUrl);
      const onlyHashChanged =
        uBefore.origin === uAfter.origin &&
        uBefore.pathname === uAfter.pathname &&
        uBefore.hash !== uAfter.hash;

      if (onlyHashChanged && !questionsChanged && !stepChanged) {
        return {
          success: false,
          state: 'NO_CHANGE',
          reason: 'URL chỉ thay đổi hash anchor mà không làm thay đổi câu hỏi trên DOM',
          beforeUrl,
          afterUrl,
          questionsBefore: beforeQuestions.length,
          questionsAfter: afterQuestions.length
        };
      }
    } catch {}

    // Strict DOM evidence rule (AUD-115-05):
    // A pathname or query change alone without question or step change on DOM is UNCERTAIN / NEEDS_REVIEW
    if (!questionsChanged && !stepChanged) {
      return {
        success: false,
        state: 'NEEDS_REVIEW',
        reason: 'URL đã thay đổi nhưng không tìm thấy bằng chứng câu hỏi hoặc chỉ số bước thay đổi trên DOM',
        beforeUrl,
        afterUrl,
        questionsBefore: beforeQuestions.length,
        questionsAfter: afterQuestions.length
      };
    }

    return {
      success: true,
      state: 'ADVANCED',
      reason: 'Chuyển trang thành công sang URL mới với bằng chứng xác thực trên DOM',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: afterQuestions.length
    };
  }

  if (questionsChanged || stepChanged) {
    return {
      success: true,
      state: 'ADVANCED',
      reason: 'Chuyển bước thành công',
      beforeUrl,
      afterUrl,
      questionsBefore: beforeQuestions.length,
      questionsAfter: afterQuestions.length
    };
  }

  return {
    success: false,
    state: 'NO_CHANGE',
    reason: 'Không phát hiện thay đổi trạng thái sau khi click Tiếp theo',
    beforeUrl,
    afterUrl,
    questionsBefore: beforeQuestions.length,
    questionsAfter: afterQuestions.length
  };
}
