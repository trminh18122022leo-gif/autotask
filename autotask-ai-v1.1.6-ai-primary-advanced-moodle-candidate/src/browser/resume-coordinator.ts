/** Resume Coordinator: multi-page state verification, navigation orchestration, and lifecycle safety.
 * Coordinates resuming interrupted multi-page tasks without duplicate submissions, synthetic actions, or desync.
 */
import type { Page } from 'playwright';
import {
  type TaskCheckpoint,
  verifyResumeState,
  type ResumeVerificationResult
} from '../task-manager.js';
import { observeAccess, mostRestrictive, type AccessGate } from '../access-gates.js';
import { scanQuestions } from '../scanner.js';
import { locateNext } from '../interaction.js';
import { ensureAllowed, isApprovedSsoOrigin, originTrustFromConfig } from '../config.js';
import { resolveEffectiveOperationMode } from '../operation-mode.js';
import { executeVerifiedNavigation, isAuthRequired } from './verified-navigation.js';
import type { AppConfig } from '../types.js';

export type ResumeState =
  | 'RESUME_READY'
  | 'NAVIGATION_REQUIRED'
  | 'STATE_MISMATCH'
  | 'WAITING_FOR_AUTH'
  | 'WAITING_FOR_ACCESS'
  | 'NEEDS_REVIEW'
  | 'COMPLETED_VERIFIED';

export interface ResumeStateResult {
  state: ResumeState;
  currentStep: number;
  targetStep: number;
  reason: string;
  matchedQuestions?: number;
  verifiedValuesCount?: number;
  canAdvance?: boolean;
  accessGate?: AccessGate;
  details?: Record<string, any>;
}

export class ResumeCoordinator {
  /** Detects whether the current live page represents a login or authentication barrier */
  static isAuthRequired = isAuthRequired;

  /** Detects the current page's step index based on live DOM questions matching answersByStep */
  static async detectCurrentStep(page: Page, checkpoint: TaskCheckpoint): Promise<number> {
    if (!checkpoint.answersByStep || Object.keys(checkpoint.answersByStep).length === 0) {
      return 1;
    }

    try {
      const liveQuestions = await scanQuestions(page);
      if (liveQuestions.length === 0) {
        return 1;
      }
      const domIds = new Set(liveQuestions.map(q => q.id));

      let bestStep = 1;
      let maxMatches = -1;

      for (const [stepStr, stepAnswers] of Object.entries(checkpoint.answersByStep)) {
        const sKeys = Object.keys(stepAnswers || {});
        const matches = sKeys.filter(k => domIds.has(k)).length;
        if (matches > maxMatches && matches > 0) {
          maxMatches = matches;
          bestStep = Number(stepStr);
        }
      }

      if (maxMatches <= 0) {
        const u = new URL(page.url());
        if (/\/mod\/quiz\/attempt\.php$/i.test(u.pathname) && u.searchParams.has('page')) {
          const p = Number(u.searchParams.get('page'));
          if (Number.isInteger(p) && p >= 0 && p + 1 === (checkpoint.stepsCompleted || 0) + 1) {
            return p + 1;
          }
        }
      }

      return bestStep;
    } catch {
      return 1;
    }
  }

  /** Evaluates comprehensive resume readiness of the current live page against task checkpoint */
  static async evaluateState(page: Page, checkpoint: TaskCheckpoint, config?: AppConfig): Promise<ResumeStateResult> {
    const currentUrl = page.url();

    // 0. Shared mode guard: a checkpoint can never resume (fill/advance) under a global READ_ONLY / ASSESSMENT_RESTRICTED policy.
    const globalMode = resolveEffectiveOperationMode(config);
    if (globalMode === 'READ_ONLY' || globalMode === 'ASSESSMENT_RESTRICTED') {
      return {
        state: 'NEEDS_REVIEW',
        currentStep: 1,
        targetStep: checkpoint.stepsCompleted + 1,
        reason: `[${globalMode}] Chế độ toàn cục không cho phép khôi phục/điền tiếp từ checkpoint`
      };
    }

    // 1. Strict Origin & SSO Redirect verification
    try {
      const parsedCurrent = new URL(currentUrl);
      const parsedTarget = new URL(checkpoint.url);
      if (parsedCurrent.origin.toLowerCase() !== parsedTarget.origin.toLowerCase()) {
        // Check if the redirect is to an authorized SSO / login provider with strict origin validation
        const isAuthScreen = await this.isAuthRequired(page);
        const isApprovedSso = isApprovedSsoOrigin(currentUrl, config);

        if (isAuthScreen && isApprovedSso) {
          return {
            state: 'WAITING_FOR_AUTH',
            currentStep: 1,
            targetStep: checkpoint.stepsCompleted + 1,
            reason: `Trang đã chuyển hướng đến cổng xác thực SSO được cấp phép (${parsedCurrent.origin}). Vui lòng đăng nhập trước khi tiếp tục.`
          };
        }

        const mismatchKind =
          parsedCurrent.hostname.toLowerCase() !== parsedTarget.hostname.toLowerCase()
            ? `Trang hiện tại (${parsedCurrent.hostname}) khác hostname trong checkpoint (${parsedTarget.hostname})`
            : `Trang hiện tại (${parsedCurrent.origin}) khác giao thức/port origin trong checkpoint (${parsedTarget.origin})`;

        return {
          state: 'NEEDS_REVIEW',
          currentStep: 1,
          targetStep: checkpoint.stepsCompleted + 1,
          reason: mismatchKind
        };
      }

      if (config?.allowedHosts?.length) {
        ensureAllowed(currentUrl, config.allowedHosts, originTrustFromConfig(config));
      }
    } catch (e) {
      return {
        state: 'NEEDS_REVIEW',
        currentStep: 1,
        targetStep: checkpoint.stepsCompleted + 1,
        reason: `URL/Origin trang hiện tại không hợp lệ hoặc bị chặn: ${currentUrl} (${e instanceof Error ? e.message : String(e)})`
      };
    }

    // 2. Irreversible or terminal checkpoint status check
    if (checkpoint.status === 'COMPLETED' || checkpoint.status === 'SUBMITTED' || checkpoint.status === 'UNCONFIRMED') {
      return {
        state: 'NEEDS_REVIEW',
        currentStep: checkpoint.stepsCompleted,
        targetStep: checkpoint.stepsCompleted,
        reason: `Biểu mẫu đã ở trạng thái ${checkpoint.status}. Không tự động thực thi lại để tránh gửi trùng lặp.`
      };
    }

    // 3. Submitted / completed keywords on live DOM
    try {
      const bodyText = (await page.locator('body').innerText({ timeout: 3000 })).toLowerCase();
      const submittedKeywords = [
        'câu trả lời của bạn đã được ghi nhận',
        'your response has been recorded',
        'đã nộp bài',
        'submitted successfully',
        'đã hoàn thành bài kiểm tra',
        'attempts allowed: 1',
        'bạn đã làm bài này'
      ];
      for (const kw of submittedKeywords) {
        if (bodyText.includes(kw)) {
          return {
            state: 'NEEDS_REVIEW',
            currentStep: checkpoint.stepsCompleted,
            targetStep: checkpoint.stepsCompleted,
            reason: `Trang hiển thị trạng thái đã hoàn thành/nộp bài ("${kw}"). Cần kiểm tra thủ công trước khi tiếp tục.`
          };
        }
      }
    } catch {}

    // 4. Authentication / Login gate detection
    if (await this.isAuthRequired(page)) {
      return {
        state: 'WAITING_FOR_AUTH',
        currentStep: 1,
        targetStep: checkpoint.stepsCompleted + 1,
        reason: 'Trang yêu cầu đăng nhập tài khoản trước khi tiếp tục biểu mẫu.'
      };
    }

    // 5. Site access gate detection (FAMI 15m reading gate, quiz timer, scheduled opening)
    try {
      const gates = await observeAccess(page);
      const waiting = mostRestrictive(gates);
      if (waiting) {
        return {
          state: 'WAITING_FOR_ACCESS',
          currentStep: checkpoint.stepsCompleted,
          targetStep: checkpoint.stepsCompleted + 1,
          reason: `Tác vụ bị tạm giữ bởi cổng kiểm soát truy cập: ${waiting.reason}`,
          accessGate: waiting
        };
      }
    } catch {}

    // 6. Fresh task / zero progress in checkpoint
    const hasRecorded = (checkpoint.answersRecorded && Object.keys(checkpoint.answersRecorded).length > 0) ||
      (checkpoint.answersByStep && Object.keys(checkpoint.answersByStep).length > 0);

    if (checkpoint.stepsCompleted === 0 && !hasRecorded) {
      return {
        state: 'RESUME_READY',
        currentStep: 1,
        targetStep: 1,
        reason: 'Tác vụ mới hoặc chưa có câu trả lời nào được ghi nhận trong checkpoint'
      };
    }

    // 7. Multi-page checkpoint with answersByStep
    if (checkpoint.answersByStep && Object.keys(checkpoint.answersByStep).length > 0) {
      const currentStep = await this.detectCurrentStep(page, checkpoint);
      const targetStep = (checkpoint.stepsCompleted || 0) + 1;

      // Verify DOM values for the current step
      const stepVerification = await verifyResumeState(page, checkpoint, { step: currentStep });
      if (!stepVerification.canResume) {
        return {
          state: 'STATE_MISMATCH',
          currentStep,
          targetStep,
          reason: `Giá trị DOM bước ${currentStep} không khớp với checkpoint: ${stepVerification.reason}`,
          matchedQuestions: stepVerification.matchedQuestions,
          verifiedValuesCount: stepVerification.verifiedValuesCount
        };
      }

      // If current step is behind the furthest completed step, navigation via Next is required
      if (currentStep < targetStep) {
        return {
          state: 'NAVIGATION_REQUIRED',
          currentStep,
          targetStep,
          canAdvance: true,
          reason: `Bước ${currentStep} đã được xác minh chính xác trên DOM; cần chuyển tiếp đến bước đang thực hiện (${targetStep})`,
          matchedQuestions: stepVerification.matchedQuestions,
          verifiedValuesCount: stepVerification.verifiedValuesCount
        };
      }

      if (checkpoint.totalSteps && checkpoint.stepsCompleted >= checkpoint.totalSteps) {
        return {
          state: 'COMPLETED_VERIFIED',
          currentStep,
          targetStep: checkpoint.totalSteps,
          reason: 'Tất cả các bước đã hoàn thành và được xác minh chính xác',
          matchedQuestions: stepVerification.matchedQuestions,
          verifiedValuesCount: stepVerification.verifiedValuesCount
        };
      }

      return {
        state: 'RESUME_READY',
        currentStep,
        targetStep,
        reason: `Bước ${currentStep} đã sẵn sàng tiếp tục điền`,
        matchedQuestions: stepVerification.matchedQuestions,
        verifiedValuesCount: stepVerification.verifiedValuesCount
      };
    }

    // 8. Legacy / Flat checkpoint (answersRecorded)
    const verification = await verifyResumeState(page, checkpoint);
    if (verification.canResume) {
      if (checkpoint.totalSteps && checkpoint.stepsCompleted >= checkpoint.totalSteps) {
        return {
          state: 'COMPLETED_VERIFIED',
          currentStep: 1,
          targetStep: checkpoint.totalSteps,
          reason: 'Tất cả câu hỏi đã được xác minh trên DOM',
          matchedQuestions: verification.matchedQuestions,
          verifiedValuesCount: verification.verifiedValuesCount
        };
      }
      return {
        state: 'RESUME_READY',
        currentStep: 1,
        targetStep: (checkpoint.stepsCompleted || 0) + 1,
        reason: verification.reason,
        matchedQuestions: verification.matchedQuestions,
        verifiedValuesCount: verification.verifiedValuesCount
      };
    }

    // Check if verification failed because questions belong to a later page
    if (checkpoint.stepsCompleted > 1) {
      // Check if all questions currently on page DOM match recorded answers
      const liveQuestions = await scanQuestions(page);
      const recorded = checkpoint.answersRecorded || {};
      const presentKeys = liveQuestions.map(q => q.id).filter(id => id in recorded);

      if (presentKeys.length > 0) {
        let partialMatches = 0;
        for (const k of presentKeys) {
          const rec = recorded[k];
          const matches = await page.evaluate(({ key, recVal }) => {
            const el = document.querySelector<HTMLInputElement>(`[name="${key}"], #${CSS.escape(key)}, [data-atqa-id="${key}"]`);
            if (!el) return false;
            if (el.type === 'radio' || el.type === 'checkbox') return el.checked;
            if (el.type === 'file') return (el.files?.length || 0) > 0;
            const exp = typeof recVal === 'string' ? recVal : (recVal?.text || '');
            return (el.value || '').trim() === exp.trim();
          }, { key: k, recVal: rec }).catch(() => false);

          if (matches) partialMatches++;
        }

        if (partialMatches === presentKeys.length) {
          return {
            state: 'NAVIGATION_REQUIRED',
            currentStep: 1,
            targetStep: checkpoint.stepsCompleted + 1,
            canAdvance: true,
            reason: `Các trường trên trang hiện tại (${partialMatches}/${presentKeys.length}) khớp checkpoint; cần chuyển tiếp tới bước ${checkpoint.stepsCompleted + 1}`,
            matchedQuestions: partialMatches,
            verifiedValuesCount: partialMatches
          };
        }
      }
    }

    return {
      state: 'STATE_MISMATCH',
      currentStep: 1,
      targetStep: (checkpoint.stepsCompleted || 0) + 1,
      reason: verification.reason,
      matchedQuestions: verification.matchedQuestions,
      verifiedValuesCount: verification.verifiedValuesCount
    };
  }

  /** Safely navigates step-by-step from currentStep to targetStep by verifying each page and clicking Next */
  static async advanceToStep(
    page: Page,
    checkpoint: TaskCheckpoint,
    targetStep: number,
    config: AppConfig,
    nextButtonSelector?: string
  ): Promise<boolean> {
    let currentStep = await this.detectCurrentStep(page, checkpoint);

    while (currentStep < targetStep) {
      // 1. Verify current page answers before proceeding
      if (checkpoint.answersByStep && checkpoint.answersByStep[currentStep]) {
        const check = await verifyResumeState(page, checkpoint, { step: currentStep });
        if (!check.canResume) {
          return false;
        }
      }

      // 2. Execute unified Observe -> Act -> Verify navigation
      const navResult = await executeVerifiedNavigation(page, config, nextButtonSelector, currentStep);
      if (!navResult.success) {
        return false;
      }

      currentStep++;
    }

    return true;
  }
}
