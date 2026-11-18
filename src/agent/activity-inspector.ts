/** Activity & Quiz Status Inspector for AutoTask AI Autonomous Agent */
import type { Page } from 'playwright';
import { parseDeadline } from '../calendar.js';

export interface ActivityItem {
  title: string;
  kind: 'quiz' | 'assignment' | 'resource' | 'activity';
  url: string;
  sectionTitle?: string;
  isCompleted?: boolean;
  isExpired?: boolean;
  completionConfirmed?: boolean;
  grade?: string;
  dueText?: string;
  dueAt?: string;
  remainingHours?: number;
  innerDetails?: string;
}

export interface QuizStatusDetails {
  isDone: boolean;
  isExpired?: boolean;
  isErrorPage?: boolean;
  isAuthPage?: boolean;
  isAssignment?: boolean;
  isDraft?: boolean;
  canAttempt: boolean;
  canReattempt?: boolean;
  canEditSubmission?: boolean;
  isInProgress?: boolean;
  hasReattemptOption?: boolean;
  attemptsAllowed?: string;
  grade?: string;
  dueText?: string;
  state?: 'COMPLETED' | 'READY_TO_ATTEMPT' | 'CLOSED' | 'ERROR' | 'AUTH_REQUIRED';
  details: string;
}

/** Extracts all course activities (quizzes, assignments, resources) and their completion & expiration status */
export async function inspectCourseActivities(page: Page): Promise<ActivityItem[]> {
  const rawItems = await page.evaluate(() => {
    const items: {
      title: string;
      kind: 'quiz' | 'assignment' | 'resource' | 'activity';
      url: string;
      sectionTitle?: string;
      isCompleted?: boolean;
      isExpired?: boolean;
      completionConfirmed?: boolean;
      dueText?: string;
    }[] = [];

    // Moodle 4.x / 3.x / Canvas selectors for activities
    const activityNodes = document.querySelectorAll(
      '.activity-item, .activity, li.activity, li.modtype_quiz, li.modtype_assign, li.modtype_resource, [data-region="activity-information"], .course-section li'
    );

    activityNodes.forEach(node => {
      const link = node.querySelector<HTMLAnchorElement>(
        'a[href*="/mod/quiz/view.php"], a[href*="/mod/assign/view.php"], a.aalink[href*="/mod/"], a[href*="/mod/"]'
      );
      if (!link || !link.href) return;

      const href = link.href;
      if (items.some(i => i.url === href)) return;

      // Extract title: remove common screenreader prefixes
      let rawText = '';
      const instanceName = node.querySelector('.instancename, .activityname');
      if (instanceName) {
        const clone = instanceName.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.accesshide, .sr-only, [data-region="completion-info"], .activity-dates').forEach(e => e.remove());
        rawText = clone.textContent || '';
      }
      if (!rawText) {
        const clone = link.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.accesshide, .sr-only').forEach(e => e.remove());
        rawText = clone.textContent || '';
      }
      const title = rawText
        .replace(/\s+/g, ' ')
        .replace(/^(Trắc nghiệm|Quiz|Bài tập|Assignment|Tài liệu)\s*:\s*/i, '')
        .replace(/\s+(Trắc nghiệm|Quiz|Bài tập|Assignment)$/i, '')
        .trim();
      if (!title || title.length < 2) return;

      // Determine kind across Moodle + generic/SohoA/HUSTack/MOOC/Canvas/Azota/OLM
      let kind: 'quiz' | 'assignment' | 'resource' | 'activity' = 'activity';
      if (href.includes('/mod/resource/') || href.includes('/mod/folder/') || href.includes('/mod/url/')) {
        kind = 'resource';
      } else if (
        href.includes('/mod/quiz/') ||
        node.className.includes('quiz') ||
        /\/(?:quizzes|kiem-tra|thi-lt|de-thi|exam|assessment)\b/i.test(href) ||
        /trắc nghiệm|quiz|kiểm\s*tra|đề\s*thi/i.test(title)
      ) {
        kind = 'quiz';
      } else if (
        href.includes('/mod/assign/') ||
        node.className.includes('assign') ||
        /\/(?:assignments|programming-contest|problem|exercise|bai-tap)\b/i.test(href) ||
        /bài tập|assignment|nộp\s*bài/i.test(title)
      ) {
        kind = 'assignment';
      }

      // 1. Check completion status from DOM badges / indicators
      let isCompleted = false;
      const isQuizOrAssign = kind === 'quiz' || kind === 'assignment';

      const manualBtns = node.querySelectorAll(
        'button[data-action="toggle-manual-completion"], button[data-toggletype^="manual:"], [data-toggletype^="manual:"]'
      );
      let hasManualTodo = false;
      manualBtns.forEach(btn => {
        const checked = btn.getAttribute('aria-checked');
        const toggleType = (btn.getAttribute('data-toggletype') || '').toLowerCase();
        const cls = (btn.className || '').toLowerCase();
        const btnText = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (
          checked === 'false' ||
          toggleType.includes('mark-done') ||
          /đánh\s*dấu\s*(?:là\s*)?đã\s*hoàn\s*thành|mark\s*as\s*done|^\s*to\s*do\s*$|^\s*cần\s*làm\s*$/i.test(btnText) ||
          /^mark\b.*\bas\s*done\b|^đánh\s*dấu\b.*\bđã\s*hoàn\s*thành/i.test(ariaLabel)
        ) {
          hasManualTodo = true;
        } else if (
          checked === 'true' ||
          toggleType.includes('undo') ||
          cls.includes('btn-success') ||
          cls.includes('btn-outline-success') ||
          /^(?:done|đã\s*hoàn\s*thành|hoàn\s*thành)$/.test(btnText)
        ) {
          isCompleted = true;
        }
      });

      const compRegions = node.querySelectorAll(
        '[data-region="completion-info"], .activity-completion, .automatic-completion-conditions'
      );
      let hasAutomaticTodo = false;
      compRegions.forEach(reg => {
        const clone = reg.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(
          'button[data-action="toggle-manual-completion"], [data-toggletype^="manual:"]'
        ).forEach(el => el.remove());

        const regText = (clone.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!regText) return;

        const hasTodo = /cần\s*làm|to\s*do|chưa\s*hoàn\s*thành|chưa\s*làm|\bfailed\b|không\s*đạt/i.test(regText);
        if (hasTodo) hasAutomaticTodo = true;

        // Strip "Done: View" / "Hoàn thành: Xem" on quizzes & assignments so merely viewing the intro does not mark them completed
        const cleanedForDone = isQuizOrAssign
          ? regText.replace(/(?:đã\s*hoàn\s*thành|hoàn\s*thành|done)\s*[:：]?\s*(?:xem|view)\b/gi, ' ')
          : regText;
        const hasDone = /đã\s*hoàn\s*thành|hoàn\s*thành\s*[:：]|done\s*[:：]|\bdone\b|đã\s*làm|đã\s*nộp|\bcompleted\b/i.test(cleanedForDone);
        if (hasDone && !hasTodo) {
          isCompleted = true;
        }

        // Check individual automatic condition badges (only mark complete if no remaining To-Do condition exists in this region)
        if (!hasTodo) {
          clone.querySelectorAll('.badge, span, li').forEach(b => {
            const bt = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!bt || /cần\s*làm|to\s*do/i.test(bt)) return;
            const isViewOnly = /^(?:(?:đã\s*)?hoàn\s*thành|done)?\s*[:：]?\s*(?:xem|view)$/i.test(bt);
            if (isQuizOrAssign && isViewOnly) return;
            if (
              (b.className.includes('badge-success') || b.className.includes('bg-success') || /^(?:hoàn thành|đã hoàn thành|done)\b/i.test(bt)) &&
              (/làm\s*bài|make\s*attempts|nộp|submit|nhận\s*điểm|receive\s*a\s*grade|xem|view/i.test(bt) || bt === 'done' || bt === 'hoàn thành' || bt === 'đã hoàn thành')
            ) {
              isCompleted = true;
            }
          });
        }
      });

      if (!hasAutomaticTodo && !hasManualTodo) {
        node.querySelectorAll('.badge-success, .bg-success').forEach(badge => {
          if (badge.closest('button[data-action="toggle-manual-completion"], [data-toggletype^="manual:"]')) return;
          const badgeText = (badge.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!badgeText || /cần\s*làm|to\s*do/i.test(badgeText)) return;
          const isViewOnly = /^(?:(?:đã\s*)?hoàn\s*thành|done)?\s*[:：]?\s*(?:xem|view)$/i.test(badgeText);
          if (isQuizOrAssign && isViewOnly) return;
          isCompleted = true;
        });
      }

      const img = node.querySelector(
        'img[src*="completion-auto-y"], img[src*="completion-manual-y"], img[title*="Completed" i], img[title*="Đã hoàn thành" i], img[alt*="Completed" i], img[alt*="Đã hoàn thành" i]'
      );
      if (img) {
        isCompleted = true;
      }

      if (node.className.includes('completion-complete') || node.className.includes('is-completed')) {
        isCompleted = true;
      }

      // 2. Check expiration / closed status from activity dates or description
      let isExpired = false;
      let dueText: string | undefined;
      const dateEl = node.querySelector('[data-region="activity-dates"], .activity-dates, .description');
      const dateRaw = ((dateEl ? dateEl.textContent : node.textContent) || '').replace(/\s+/g, ' ').trim();
      if (dateRaw) {
        // Past-tense closed / overdue labels on Moodle
        if (/đã\s*đóng(?:\s*[:：]|\s+vào\b)|\bclosed(?:\s*[:：]|\s+on\b)|quá\s*hạn|\boverdue\b|hết\s*hạn\s*nộp|không\s*còn\s*khả\s*dụng/i.test(dateRaw)) {
          isExpired = true;
        }
        const closeLineMatch = dateRaw.match(
          /((?:Đã\s+đóng|Đóng(?:\s+vào)?|Hạn\s+(?:nộp|chót)|Ngày\s+đến\s+hạn|Kết\s+thúc|Closed?|Closes?|Due(?:\s+date)?)\s*[:：]?\s*[^\n;|]{4,90})/i
        );
        if (closeLineMatch) {
          dueText = closeLineMatch[1].trim();
        }
      }

      const sectionEl = node.closest('li.section, .course-section, [data-for="section"], .section');
      const sectionHeadingEl = sectionEl?.querySelector('.sectionname, .section-title, h3.sectionname, [data-for="section_title"]');
      const sectionTitle = (sectionHeadingEl?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;

      items.push({
        title,
        kind,
        url: href,
        ...(sectionTitle ? { sectionTitle } : {}),
        isCompleted,
        completionConfirmed: isCompleted,
        isExpired,
        dueText
      });
    });

    // Fallback: search for Moodle or multi-platform LMS quiz/assignment/exercise anchors
    if (items.length === 0) {
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/mod/quiz/view.php"], a[href*="/mod/assign/view.php"], a[href*="/kiem-tra"], a[href*="/thi-lt"], a[href*="/quizzes/"], a[href*="/assignments/"], a[href*="/programming-contest/"], a[href*="/problem"], a[href*="/exercise"], a[href*="/de-thi"], a[href*="/bai-tap"], a[href*="/luyen-tap"], a[href*="/exam"], a[href*="/assessment"], a[href*="/courseware/"]'
      ).forEach(a => {
        const title = (a.textContent || a.title || '').replace(/\s+/g, ' ').trim();
        if (title.length > 2 && !items.some(i => i.url === a.href)) {
          const isAssignLike = /\/mod\/assign\/|\/assignments\/|\/programming-contest\/|\/problem|\/exercise|\/bai-tap/i.test(a.href);
          const kind = isAssignLike ? 'assignment' : 'quiz';
          items.push({ title, kind, url: a.href, isCompleted: false, completionConfirmed: false, isExpired: false });
        }
      });
    }

    return items;
  }).catch(() => []);

  // Post-process dueText with parseDeadline to catch future vs past closing timestamps and compute remainingHours accurately
  const now = Date.now();
  return rawItems.map((item): ActivityItem => {
    if (item.dueText) {
      const parsedIso = parseDeadline(item.dueText);
      if (parsedIso) {
        const dueMs = new Date(parsedIso).getTime();
        const remainingHours = Math.round(((dueMs - now) / 3600000) * 10) / 10;
        return {
          ...item,
          dueAt: parsedIso,
          remainingHours,
          isExpired: Boolean(item.isExpired || dueMs < now)
        };
      }
    }
    return item;
  });
}

/** Detects if the current quiz or assignment page is already completed, expired/closed, or can be attempted */
export async function inspectQuizOrAssignmentStatus(page: Page): Promise<QuizStatusDetails | null> {
  const url = page.url();
  const isQuizAttempt = url.includes('/mod/quiz/attempt.php');
  const isQuizView = url.includes('/mod/quiz/view.php') || (url.includes('/mod/quiz/') && !isQuizAttempt);
  const isAssignView = url.includes('/mod/assign/view.php') || url.includes('/mod/assign/');
  const isNonMoodleExercise =
    !isQuizView &&
    !isAssignView &&
    !/\/course\/view\.php|\/courses\/?$|\/my\//i.test(url) &&
    /\/(?:quiz|quizzes|kiem-tra|thi-lt|de-thi|bai-tap|luyen-tap|exam|assessment|problem|exercise|programming-contest|courseware|assign)/i.test(url);

  if (isQuizAttempt) {
    return {
      isDone: false,
      isExpired: false,
      canAttempt: true,
      isInProgress: true,
      state: 'READY_TO_ATTEMPT',
      details: 'Đang ở trong trang làm bài trắc nghiệm (attempt.php)'
    };
  }

  if (!isQuizView && !isAssignView && !isNonMoodleExercise) {
    if (/\/login\/|login\.|sso\.|saml|oauth/i.test(url)) {
      return {
        isDone: false,
        isExpired: false,
        isAuthPage: true,
        canAttempt: false,
        state: 'AUTH_REQUIRED',
        details: `Trang yêu cầu đăng nhập / phiên đã hết hạn (${url})`
      };
    }
    return null;
  }

  const evalIsAssign = isAssignView || (isNonMoodleExercise && /assign|bai-tap|problem/i.test(url));
  const evalIsQuiz = isQuizView || (isNonMoodleExercise && !evalIsAssign);

  const rawStatus = await page.evaluate(({ isQuiz, isAssign }) => {
    const pageTitle = (document.title || '').replace(/\s+/g, ' ').trim();
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');

    const hasInteractiveBtn = Boolean(
      document.querySelector('button, input[type="submit"], form[action*="startattempt.php"], table.quizattemptsummary')
    );

    // Detect auth / login / guest restriction page on quiz/assign view
    const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
    const hasNotLoggedInBody = Boolean(document.body?.classList.contains('notloggedin'));
    const hasQuizActionControls = Boolean(
      document.querySelector('form[action*="startattempt.php"], table.quizattemptsummary, .quizinfo')
    );
    const looksLikeGuestBlock =
      /guests\s*cannot|bạn\s*chưa\s*đăng\s*nhập|you\s*are\s*not\s*logged\s*in/i.test(bodyText) && !hasQuizActionControls;
    if ((hasPasswordInput || hasNotLoggedInBody || looksLikeGuestBlock) && !hasQuizActionControls) {
      return { kind: 'auth' as const, bodySnippet: bodyText.slice(0, 180) };
    }

    // Detect genuine LMS error pages (invalid cmid, deleted activity, database/permission error)
    const hasErrorBox = Boolean(
      document.querySelector('.errormessage, #notice.errorbox, [data-rel="fatalerror"]')
    );
    const looksLikeErrorPage =
      !hasInteractiveBtn &&
      (hasErrorBox ||
        /^(?:error|lỗi)\b/i.test(pageTitle) ||
        /^\s*(?:404\s*)?not\s*found\s*$/i.test(bodyText) ||
        /invalid\s*course\s*module\s*id|can\s*not\s*find\s*data\s*record|không\s*tìm\s*thấy\s*(?:bản\s*ghi|hoạt\s*động)|coding\s*error\s*detected|error\/moodle/i.test(bodyText));
    if (looksLikeErrorPage) {
      return { kind: 'error' as const, bodySnippet: bodyText.slice(0, 180) };
    }

    // Extract closing/due line cleanly (prefer activity-dates/quizinfo box over full bodyText)
    const dateBoxText = (document.querySelector('[data-region="activity-dates"], .activity-dates, .quizinfo')?.textContent || '').replace(/\s+/g, ' ').trim();
    const closeMatchSource = dateBoxText || bodyText;
    const closeLineRegex =
      /((?:Đã\s+đóng|Đóng(?:\s+vào)?|Bài\s+(?:thi|trắc\s+nghiệm|tập)\s+(?:này\s+)?đã\s+đóng|Hạn\s+(?:nộp|chót)|Ngày\s+đến\s+hạn|This\s+quiz\s+closed|Closed?|Closes?|Due(?:\s+date)?)\s*(?:[:：]|\s+(?:on|vào)\b)?\s*[^\n;|]{4,90})/i;
    const closeLineMatch = closeMatchSource.match(closeLineRegex) || (dateBoxText ? bodyText.match(closeLineRegex) : null);
    let dueText = closeLineMatch ? closeLineMatch[1].trim() : undefined;
    if (dueText) {
      dueText = dueText.replace(/\s+(?:Opened?|Mở(?:\s+vào)?|Time\s*limit|Attempts?\s*allowed|Grading\s*method|Thời\s*gian|Số\s*lần|Kiểm\s*tra\s*nội\s*dung|Re-?attempt|Attempt\s*quiz|Bắt\s*đầu\s*làm|Làm\s*lại).*$/i, '').trim();
    }

    if (isQuiz) {
      const attemptsMatch = bodyText.match(/(?:attempts\s*allowed|số\s*lần\s*(?:làm\s*bài|thử)\s*(?:cho\s*phép)?)\s*[:：]\s*([0-9]+|không\s*giới\s*hạn|unlimited)/i);
      const attemptsAllowed = attemptsMatch ? attemptsMatch[1].trim() : undefined;
      // 1. Distinguish First-Start vs Continue vs Re-attempt buttons
      let hasFirstStartBtn = false;
      let hasContinueBtn = false;
      let hasReattemptBtn = false;

      const allButtons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], input[type="button"], a.btn, [role="button"], form[action*="startattempt.php"] button, form[action*="startattempt.php"] input[type="submit"]'
        )
      );

      for (const btn of allButtons) {
        if ((btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true') continue;
        const t = (btn.textContent || (btn as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t) continue;

        if (t.includes('tiếp tục lần làm bài') || t.includes('continue the last attempt') || t.includes('continue your attempt') || t.includes('tiếp tục làm bài')) {
          hasContinueBtn = true;
        } else if (
          t.includes('làm lại bài thi') ||
          t.includes('re-attempt quiz') ||
          t.includes('reattempt quiz') ||
          t.includes('thử lại bài thi') ||
          t.includes('làm lại bài') ||
          t.includes('thực hiện lại') ||
          t.includes('attempt quiz again') ||
          t.includes('làm lại trắc nghiệm')
        ) {
          hasReattemptBtn = true;
        } else if (
          t.includes('bắt đầu làm bài') ||
          t.includes('start attempt') ||
          t.includes('attempt quiz') ||
          t.includes('làm bài thi ngay') ||
          t.includes('thực hiện bài thi')
        ) {
          hasFirstStartBtn = true;
        }
      }

      // 2. Check Previous attempts summary table & finished states
      const table = document.querySelector('table.generaltable, table.quizattemptsummary, .quizattemptsummary');
      const tableBodyText = (table?.querySelector('tbody')?.textContent || table?.textContent || '').replace(/\s+/g, ' ');
      const hasCompletedAttemptInTable = Boolean(
        table && /đã\s*kết\s*thúc|finished|hoàn\s*thành|đã\s*nộp|submitted/i.test(tableBodyText)
      );

      // Extract actual student grade (excluding Moodle metadata/headers like "Grade to pass" or "Grade / 10.00")
      let grade: string | undefined;
      const bodyForGrade = bodyText
        .replace(/(?:grade\s*to\s*pass|passing\s*grade|maximum\s*grade|điểm\s*(?:để\s*)?đạt|điểm\s*tối\s*đa)\s*[:=/]?\s*[0-9]+(?:[.,][0-9]+)?(?:\s*(?:\/|trên|out\s+of)\s*[0-9]+(?:[.,][0-9]+)?)?/gi, ' ');
      const gradeMatch = bodyForGrade.match(
        /(?:điểm\s*cao\s*nhất(?:\s*của\s*bạn)?|highest\s*grade(?:\s*achieved)?|điểm\s*tổng\s*kết|final\s*grade(?:\s*for\s*this\s*quiz)?|tổng\s*điểm|điểm\s*của\s*bạn|your\s*final\s*grade(?:\s*for\s*this\s*quiz)?|grade\s*for\s*this\s*quiz)\s*(?:is|là|:|=|\/)?\s*([0-9]+(?:[.,][0-9]+)?(?:\s*(?:\/|trên|out\s+of)\s*[0-9]+(?:[.,][0-9]+)?)?(?:\s*\([0-9.,]+%\))?)/i
      ) || (hasCompletedAttemptInTable
        ? tableBodyText.match(/([0-9]+(?:[.,][0-9]+)?\s*(?:\/|trên|out\s+of)\s*[0-9]+(?:[.,][0-9]+)?(?:\s*\([0-9.,]+%\))?)/i)
          || tableBodyText.match(/(?:điểm|grade|marks?)\s*[:=/]?\s*([0-9]+(?:[.,][0-9]+)?)/i)
        : null);
      if (gradeMatch) {
        grade = gradeMatch[1].trim();
      }

      // Check completion badges on the quiz view page (exclude manual toggle buttons & "Done: View" only pills)
      const compEl = document.querySelector('[data-region="completion-info"], .activity-information, .automatic-completion-conditions');
      let compText = '';
      let hasManualDoneBtn = false;
      if (compEl) {
        const clone = compEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('button[data-action="toggle-manual-completion"], [data-toggletype^="manual:"]').forEach(btn => {
          const checked = btn.getAttribute('aria-checked');
          const toggleType = (btn.getAttribute('data-toggletype') || '').toLowerCase();
          const btnText = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (checked === 'true' || toggleType.includes('undo') || /^(?:done|đã\s*hoàn\s*thành|hoàn\s*thành)$/.test(btnText)) {
            hasManualDoneBtn = true;
          }
          btn.remove();
        });
        compText = (clone.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      }
      const cleanedCompText = compText.replace(/(?:đã\s*hoàn\s*thành|hoàn\s*thành|done)\s*[:：]?\s*(?:xem|view)\b/gi, ' ');
      const hasDoneBadge =
        hasManualDoneBtn ||
        (/đã\s*hoàn\s*thành|hoàn\s*thành\s*[:：]|done\s*[:：]|\bdone\b/i.test(cleanedCompText) && !/cần\s*làm|to\s*do|\bfailed\b|không\s*đạt/i.test(compText)) ||
        /hoàn\s*thành\s*[:：]\s*(?:làm\s*bài|nhận\s*điểm)|done\s*[:：]\s*(?:make\s*attempts|receive\s*a\s*grade)/i.test(compText);

      const hasNoMoreAttempts = /không\s*còn\s*lần\s*làm\s*bài|no\s*more\s*attempts|số\s*lần\s*làm\s*bài\s*đã\s*hết/i.test(bodyText);
      const isFinishedText = /trạng\s*thái\s*đã\s*kết\s*thúc|state\s*finished|đã\s*nộp\s*vào|submitted\s*on/i.test(bodyText);

      // Check explicit closed/expired notices on page
      const isExplicitlyClosed =
        /bài\s*(?:thi|trắc\s*nghiệm)\s*(?:này\s*)?đã\s*đóng|đã\s*đóng(?:\s*[:：]|\s+vào\b)|this\s*quiz\s*closed|\bclosed(?:\s*[:：]|\s+on\b)|currently\s*not\s*available|hiện\s*không\s*khả\s*dụng|đã\s*quá\s*hạn|hết\s*hạn\s*làm\s*bài/i.test(bodyText);

      // A quiz is considered ALREADY DONE only when positive completion evidence exists (not merely "No more attempts" on an unattempted closed quiz)
      const hasPositiveEvidence = hasCompletedAttemptInTable || Boolean(grade) || hasDoneBadge || isFinishedText;
      const isAlreadyCompleted =
        !hasContinueBtn &&
        (hasPositiveEvidence || hasReattemptBtn || (hasNoMoreAttempts && hasPositiveEvidence));

      return {
        kind: 'quiz' as const,
        hasFirstStartBtn,
        hasContinueBtn,
        hasReattemptBtn,
        isAlreadyCompleted,
        isExplicitlyClosed,
        attemptsAllowed,
        grade,
        dueText
      };
    }

    // Assignment (/mod/assign/view.php)
    const isDraft = /bản\s*nháp\s*\(?chưa\s*nộp\)?|draft\s*\(?not\s*submitted\)?/i.test(bodyText);
    const isSubmitted = !isDraft && /đã\s*nộp\s*để\s*chấm|submitted\s*for\s*grading|đã\s*nộp\s*bài/i.test(bodyText);
    const assignBtns = Array.from(document.querySelectorAll<HTMLElement>('button, a.btn, input[type="submit"], [role="button"]'));
    const canAddSubmission = assignBtns.some(b => {
      if ((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const t = (b.textContent || (b as HTMLInputElement).value || '').toLowerCase();
      return t.includes('thêm bài nộp') || t.includes('add submission');
    });
    const canEditSubmission = assignBtns.some(b => {
      if ((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const t = (b.textContent || (b as HTMLInputElement).value || '').toLowerCase();
      return (
        t.includes('sửa bài nộp') ||
        t.includes('chỉnh sửa bài nộp') ||
        t.includes('edit submission') ||
        t.includes('update submission') ||
        t.includes('nộp bài tập') ||
        t.includes('submit assignment')
      );
    });
    const hasEditorOnAssign = Boolean(
      document.querySelector('form[action*="assign"] textarea, form[action*="assign"] [contenteditable="true"], form[action*="assign"] input[type="file"], .filemanager')
    );

    const isExplicitlyClosed =
      /quá\s*hạn|overdue\s*by|assignment\s*is\s*closed|bài\s*tập\s*(?:này\s*)?đã\s*đóng|đã\s*đóng(?:\s*[:：]|\s+vào\b)|\bclosed(?:\s*[:：]|\s+on\b)|hết\s*hạn\s*nộp/i.test(bodyText);

    let grade: string | undefined;
    const gradeMatch = bodyText.match(/(?:điểm|grade)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?(?:\s*\/\s*[0-9]+(?:[.,][0-9]+)?)?)/i);
    if (gradeMatch) grade = gradeMatch[1].trim();

    return {
      kind: 'assign' as const,
      isSubmitted,
      isDraft,
      canAddSubmission,
      canEditSubmission: canEditSubmission || hasEditorOnAssign,
      isExplicitlyClosed,
      grade,
      dueText
    };
  }, { isQuiz: evalIsQuiz, isAssign: evalIsAssign }).catch(() => null);

  if (!rawStatus) return null;

  if (rawStatus.kind === 'auth') {
    return {
      isDone: false,
      isExpired: false,
      isAuthPage: true,
      canAttempt: false,
      canReattempt: false,
      state: 'AUTH_REQUIRED',
      details: `Trang yêu cầu đăng nhập hoặc phiên LMS đã hết hạn (${url}${rawStatus.bodySnippet ? `: ${rawStatus.bodySnippet}` : ''})`
    };
  }

  if (rawStatus.kind === 'error') {
    return {
      isDone: false,
      isExpired: false,
      isErrorPage: true,
      canAttempt: false,
      canReattempt: false,
      state: 'ERROR',
      details: `Trang báo lỗi LMS (ID/URL không hợp lệ hoặc không tồn tại trên hệ thống${rawStatus.bodySnippet ? `: ${rawStatus.bodySnippet}` : ''})`
    };
  }

  // Check if dueText parses to a past timestamp
  let isPastDeadline = false;
  if (rawStatus.dueText) {
    const parsedIso = parseDeadline(rawStatus.dueText);
    if (parsedIso && new Date(parsedIso).getTime() < Date.now()) {
      isPastDeadline = true;
    }
  }

  // For non-Moodle URLs, only claim status if actual status/action signals were detected
  if (isNonMoodleExercise && rawStatus.kind === 'quiz' &&
    !rawStatus.hasFirstStartBtn && !rawStatus.hasContinueBtn && !rawStatus.hasReattemptBtn &&
    !rawStatus.isAlreadyCompleted && !rawStatus.isExplicitlyClosed && !isPastDeadline) {
    return null;
  }
  if (isNonMoodleExercise && rawStatus.kind === 'assign' &&
    !rawStatus.isSubmitted && !rawStatus.canAddSubmission && !rawStatus.canEditSubmission &&
    !rawStatus.isExplicitlyClosed && !isPastDeadline) {
    return null;
  }

  if (rawStatus.kind === 'quiz') {
    if (rawStatus.hasContinueBtn) {
      return {
        isDone: false,
        isExpired: false,
        canAttempt: true,
        isInProgress: true,
        grade: rawStatus.grade,
        dueText: rawStatus.dueText,
        state: 'READY_TO_ATTEMPT',
        details: `Bài thi [ĐANG LÀM DỞ DANG] (Có nút 'Tiếp tục lần làm bài cuối cùng')`
      };
    }

    if (rawStatus.isAlreadyCompleted) {
      const closedOrExpired = Boolean(rawStatus.isExplicitlyClosed || isPastDeadline);
      const canReattempt = Boolean(rawStatus.hasReattemptBtn && !closedOrExpired);
      const attemptsNote = rawStatus.attemptsAllowed ? ` | Cho phép: ${rawStatus.attemptsAllowed} lượt` : '';
      const extraNote = canReattempt
        ? ` — Đã có lượt hoàn thành nhưng VẪN CÓ THỂ LÀM LẠI (Nút 'Re-attempt quiz' đang mở${attemptsNote})`
        : (closedOrExpired ? ' — Đã hoàn thành và hiện tại đã đóng hạn' : ', Không còn lượt làm mới');
      return {
        isDone: true,
        isExpired: closedOrExpired,
        canAttempt: false,
        canReattempt,
        hasReattemptOption: rawStatus.hasReattemptBtn,
        attemptsAllowed: rawStatus.attemptsAllowed,
        grade: rawStatus.grade,
        dueText: rawStatus.dueText,
        state: 'COMPLETED',
        details: `${canReattempt ? 'Bài thi [ĐÃ CÓ ĐIỂM - CÓ THỂ LÀM LẠI]' : (closedOrExpired ? 'Bài thi [ĐÃ LÀM XONG - HIỆN ĐÃ ĐÓNG]' : 'Bài thi [ĐÃ LÀM XONG]')} (${rawStatus.grade ? `Điểm: ${rawStatus.grade}` : 'Đã nộp và kết thúc'}${extraNote})`
      };
    }

    if (rawStatus.hasFirstStartBtn && !rawStatus.isExplicitlyClosed && !isPastDeadline) {
      return {
        isDone: false,
        isExpired: false,
        canAttempt: true,
        grade: rawStatus.grade,
        dueText: rawStatus.dueText,
        state: 'READY_TO_ATTEMPT',
        details: `Bài thi [CHƯA LÀM & CÒN HẠN] (Có nút 'Bắt đầu làm bài' / 'Start attempt')`
      };
    }

    // Neither completed nor startable => Expired / Closed WITHOUT any recorded submission
    return {
      isDone: false,
      isExpired: true,
      canAttempt: false,
      grade: rawStatus.grade,
      dueText: rawStatus.dueText,
      state: 'CLOSED',
      details: `Bài thi [ĐÃ ĐÓNG - CHƯA LÀM / KHÔNG CÓ LƯỢT NỘP NÀO] (${rawStatus.dueText || 'Đã quá hạn mà chưa có lượt làm bài'})`
    };
  }

  // Assignment status
  if (rawStatus.isSubmitted) {
    const closedOrExpired = Boolean(rawStatus.isExplicitlyClosed || isPastDeadline);
    const canUpdate = Boolean(rawStatus.canEditSubmission && !closedOrExpired);
    return {
      isDone: true,
      isExpired: closedOrExpired,
      isAssignment: true,
      canAttempt: false,
      canReattempt: canUpdate,
      canEditSubmission: rawStatus.canEditSubmission,
      grade: rawStatus.grade,
      dueText: rawStatus.dueText,
      state: 'COMPLETED',
      details: `Bài nộp [ĐÃ NỘP HOÀN THÀNH${closedOrExpired ? ' - HIỆN ĐÃ ĐÓNG' : ''}] (${rawStatus.grade ? `Điểm: ${rawStatus.grade}` : 'Đã gửi để chấm điểm'}${canUpdate ? ' — Có thể sửa bài nộp' : ''})`
    };
  }

  const canActOnAssign = Boolean(rawStatus.canAddSubmission || rawStatus.canEditSubmission);
  if (rawStatus.isExplicitlyClosed || isPastDeadline || !canActOnAssign) {
    return {
      isDone: false,
      isExpired: true,
      isAssignment: true,
      canAttempt: false,
      grade: rawStatus.grade,
      dueText: rawStatus.dueText,
      state: 'CLOSED',
      details: `Bài nộp [ĐÃ HẾT HẠN / ĐÃ ĐÓNG] (${rawStatus.dueText || 'Đã quá hạn nộp bài hoặc khóa nộp'})`
    };
  }

  return {
    isDone: false,
    isExpired: false,
    isAssignment: true,
    isDraft: rawStatus.isDraft,
    canAttempt: true,
    canEditSubmission: rawStatus.canEditSubmission,
    grade: rawStatus.grade,
    dueText: rawStatus.dueText,
    state: 'READY_TO_ATTEMPT',
    details: rawStatus.isDraft
      ? 'Bài nộp [BẢN NHÁP - CHƯA NỘP CHÍNH THỨC] (Có thể sửa và bấm Nộp bài tập)'
      : 'Bài nộp [CHƯA NỘP & CÒN HẠN] (Có thể viết bài / nộp file)'
  };
}
