/** Tool Registry and Handlers for AutoTask AI Autonomous Agent */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import type {
  AgentToolName,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentContext,
  PageObservation
} from './types.js';
import { detectPlatform, type Platform } from '../platforms.js';
import { scanDeadlines } from '../calendar.js';
import { isMutatingHttpMethod, isStateMutatingActionUrl, isSafeReadOnlyAjaxRequest } from '../operation-mode.js';
import { ModelRouter } from '../model-center/model-router.js';
import { getLastActiveKeySlot, recordLastActiveKeySlot, handleAgentKeyRotation } from './key-rotation-fx.js';
import { resolveCaCertPath } from '../ca-bootstrap.js';
import { validatePracticeAttachment } from '../lms/advanced-adapters.js';
import { extractLocalDocumentText, type FileKind } from '../documents.js';
import {
  listAccounts,
  getDefaultAccountId,
  saveAccount,
  attemptAutoLogin,
  verifyIsLoggedIn
} from '../accounts.js';
import {
  executeQuizSolve,
  getCheckedActivity,
  recordCheckedActivity,
  type CheckedActivityRecord
} from './quiz-solver.js';
import { inspectCourseActivities, inspectQuizOrAssignmentStatus, type ActivityItem, type QuizStatusDetails } from './activity-inspector.js';
import {
  extractCourseCode,
  findBestMatchingCourse,
  registerAllowedUrlHost,
  stripVietnameseAccents
} from './playbooks.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.open',
    description: 'Khởi chạy hoặc kết nối trình duyệt Chromium an toàn và mở trang khởi đầu nếu có.',
    parameters: {
      url: { type: 'string', description: 'URL khởi đầu tùy chọn (ví dụ: https://lms.hust.edu.vn/my/)' },
      headless: { type: 'boolean', description: 'Chạy không giao diện (mặc định theo cấu hình agent)', default: true }
    }
  },
  {
    name: 'browser.navigate',
    description: 'Điều hướng trình duyệt tới URL được chỉ định (bắt buộc phải thuộc danh sách tên miền được phép).',
    parameters: {
      url: { type: 'string', description: 'URL đầy đủ để điều hướng tới', required: true },
      timeoutMs: { type: 'number', description: 'Thời gian chờ tối đa (ms)', default: 25000 }
    }
  },
  {
    name: 'browser.observe',
    description: 'Quan sát cấu trúc trang hiện tại: tiêu đề, tiêu đề mục, liên kết, nút bấm, khóa học, hạn nộp và biểu mẫu.',
    parameters: {
      detailLevel: {
        type: 'string',
        description: 'Mức độ chi tiết cần trích xuất',
        enum: ['summary', 'detailed', 'courses', 'deadlines'],
        default: 'summary'
      }
    }
  },
  {
    name: 'browser.click',
    description: 'Nhấp chuột vào một phần tử trên trang dựa theo CSS selector, văn bản hiển thị hoặc role.',
    isStateChanging: true,
    parameters: {
      selector: { type: 'string', description: 'CSS selector của phần tử cần nhấp' },
      text: { type: 'string', description: 'Văn bản hiển thị của nút/liên kết cần nhấp (tìm kiếm gần đúng)' },
      timeoutMs: { type: 'number', description: 'Thời gian chờ phần tử xuất hiện (ms)', default: 5000 }
    }
  },
  {
    name: 'browser.fill',
    description: 'Điền giá trị chuỗi vào ô nhập liệu (input, textarea, contenteditable) hoặc chọn tùy chọn cho <select> / checkbox / radio trên trang (kể cả trong iframe).',
    parameters: {
      selector: { type: 'string', description: 'CSS selector của ô nhập liệu (ví dụ: input[type="email"], select[name="choice"], #i0116, input[type="password"])', required: true },
      value: { type: 'string', description: 'Nội dung chuỗi cần điền, nhãn/giá trị option cần chọn (với <select>), hoặc "true"/"false" (với checkbox)', required: true },
      submitAfter: { type: 'boolean', description: 'Có nhấn Enter sau khi điền xong không', default: false }
    }
  },
  {
    name: 'browser.type',
    description: 'Gõ từng ký tự vào phần tử đang focus hoặc theo selector (dùng cho các ô tìm kiếm có gợi ý tự động).',
    parameters: {
      selector: { type: 'string', description: 'CSS selector của phần tử cần gõ vào', required: true },
      text: { type: 'string', description: 'Văn bản cần gõ', required: true },
      delayMs: { type: 'number', description: 'Độ trễ giữa mỗi phím gõ (ms)', default: 50 }
    }
  },
  {
    name: 'browser.scroll',
    description: 'Cuộn trang lên, xuống hoặc cuộn tới vị trí cụ thể.',
    parameters: {
      direction: { type: 'string', description: 'Hướng cuộn', enum: ['down', 'up', 'top', 'bottom'], required: true },
      amount: { type: 'number', description: 'Khoảng cách cuộn tính bằng pixel', default: 500 }
    }
  },
  {
    name: 'browser.readText',
    description: 'Đọc nội dung văn bản thuần túy của toàn trang hoặc một vùng được chỉ định.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector của vùng cần đọc (để trống để đọc nội dung chính)' },
      maxLength: { type: 'number', description: 'Giới hạn số ký tự tối đa trả về', default: 4000 }
    }
  },
  {
    name: 'browser.readLinks',
    description: 'Lấy danh sách các siêu liên kết (links) trên trang hoặc trong một vùng cụ thể kèm văn bản neo.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector của vùng chứa (để trống để lấy toàn trang)' },
      filterText: { type: 'string', description: 'Lọc các liên kết có chứa văn bản này' },
      maxLinks: { type: 'number', description: 'Số liên kết tối đa cần lấy', default: 50 }
    }
  },
  {
    name: 'browser.findElement',
    description: 'Kiểm tra sự tồn tại và trạng thái hiển thị của một phần tử trên trang.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector cần tìm kiếm' },
      text: { type: 'string', description: 'Văn bản cần tìm kiếm' }
    }
  },
  {
    name: 'browser.waitFor',
    description: 'Chờ một phần tử xuất hiện, biến mất hoặc chờ một khoảng thời gian ngắn.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector cần chờ' },
      state: { type: 'string', description: 'Trạng thái cần chờ', enum: ['visible', 'hidden', 'attached'], default: 'visible' },
      timeMs: { type: 'number', description: 'Thời gian chờ cố định (ms), dùng khi cần chờ animation hoặc trang ổn định' }
    }
  },
  {
    name: 'browser.extractStructuredData',
    description: 'Tự động trích xuất dữ liệu cấu trúc LMS: danh sách môn học, bài tập, hạn nộp hoặc hoạt động. Hỗ trợ deepVerify=true để tự động mở vào từng bài kiểm tra sâu xem thực tế đã làm hay chưa và điểm số.',
    parameters: {
      type: {
        type: 'string',
        description: 'Loại dữ liệu cần trích xuất',
        enum: ['courses', 'deadlines', 'activities', 'all'],
        required: true
      },
      deepVerify: {
        type: 'boolean',
        description: 'Mở kiểm tra sâu bên trong từng trang bài tập/quiz (chạy song song nhiều tab) để xác minh chính xác bài đã làm hay chưa, số lượt nộp và điểm số thực tế — đặc biệt cần thiết khi trang khóa học bên ngoài chỉ hiện "Đã đóng" mà không hiện điểm/trạng thái nộp.'
      },
      filterText: {
        type: 'string',
        description: 'Lọc các bài tập/hoạt động theo tên khi kiểm tra sâu (tùy chọn)'
      }
    }
  },
  {
    name: 'browser.captureScreenshot',
    description: 'Chụp ảnh màn hình trang web hiện tại để lưu bằng chứng kiểm tra.',
    parameters: {
      name: { type: 'string', description: 'Tên định danh cho ảnh chụp' },
      fullPage: { type: 'boolean', description: 'Chụp toàn bộ chiều dài trang', default: false }
    }
  },
  {
    name: 'browser.download',
    description: 'Tải tài liệu/slide/file đính kèm từ URL trên trang (PDF, DOCX, TXT, MD, CSV...) về artifacts/downloads/ và tự động trích xuất nội dung chữ để AI đọc.',
    parameters: {
      url: { type: 'string', description: 'URL trực tiếp hoặc đường dẫn tương đối của tài liệu cần tải', required: true },
      filename: { type: 'string', description: 'Tên file lưu (tùy chọn)' },
      extractText: { type: 'boolean', description: 'Tự động trích xuất nội dung văn bản nếu là PDF/DOCX/TXT/MD (mặc định: true)', default: true }
    }
  },
  {
    name: 'agent.summarize',
    description: 'Sử dụng AI để tổng hợp, phân loại hoặc tạo bảng Markdown từ dữ liệu đã thu thập.',
    parameters: {
      instruction: { type: 'string', description: 'Chỉ dẫn tổng hợp (ví dụ: Lập bảng deadline theo thứ tự thời gian)', required: true },
      dataKey: { type: 'string', description: 'Khóa dữ liệu trong collectedFindings cần tổng hợp (để trống để dùng tất cả)' }
    }
  },
  {
    name: 'agent.reportResult',
    description: 'Báo cáo kết quả cuối cùng cho người dùng và hoàn thành mục tiêu tác vụ.',
    parameters: {
      status: {
        type: 'string',
        description: 'Trạng thái kết quả',
        enum: ['DONE', 'NEEDS_REVIEW', 'FAILED', 'WAITING_FOR_AUTH'],
        required: true
      },
      summary: { type: 'string', description: 'Bản tóm tắt câu trả lời đầy đủ kèm bảng biểu Markdown và nguồn dẫn', required: true }
    }
  },
  {
    name: 'account.saveCredentials',
    description: 'Lưu thông tin đăng nhập LMS (username, password) vào Windows Credential Manager mã hóa an toàn để tự động đăng nhập các lần sau.',
    parameters: {
      accountId: { type: 'string', description: 'Mã định danh tài khoản (ví dụ: hust_sv)', required: true },
      username: { type: 'string', description: 'Tên đăng nhập hoặc email sinh viên', required: true },
      password: { type: 'string', description: 'Mật khẩu đăng nhập', required: true },
      loginUrl: { type: 'string', description: 'URL đăng nhập (mặc định: https://lms.hust.edu.vn)', default: 'https://lms.hust.edu.vn' },
      isDefault: { type: 'boolean', description: 'Đặt làm tài khoản mặc định', default: true }
    }
  },
  {
    name: 'account.login',
    description: 'Thực hiện tự động đăng nhập vào LMS bằng tài khoản đã lưu trong Windows Credential Manager.',
    parameters: {
      accountId: { type: 'string', description: 'Mã tài khoản cần dùng (để trống nếu dùng tài khoản mặc định)' }
    }
  },
  {
    name: 'quiz.solve',
    description: 'Tự động giải 1 hoặc toàn bộ bài tập / trắc nghiệm LMS (Moodle, Canvas, Forms): quét câu hỏi, suy luận đáp án, điền và nộp bài. Hỗ trợ giải hàng loạt (solveAll=true), lọc từ sau bài X (afterActivity) hoặc theo dải bài (activityRange).',
    isStateChanging: true,
    parameters: {
      autoSubmit: {
        type: 'boolean',
        description: 'Tự động nộp bài và xác nhận kết thúc sau khi hoàn thành tất cả câu hỏi (mặc định: true)',
        default: true
      },
      maxPages: {
        type: 'number',
        description: 'Số trang câu hỏi tối đa mỗi bài (mặc định: 15)',
        default: 15
      },
      notes: {
        type: 'string',
        description: 'Chỉ dẫn hoặc lưu ý bổ sung từ người dùng cho bài thi'
      },
      allowReattempt: {
        type: 'boolean',
        description: 'Cho phép bấm "Re-attempt quiz" / "Làm lại bài thi" trên bài đã có lượt làm nhưng chưa đóng. CHỈ đặt true khi người dùng yêu cầu làm lại hoặc cải thiện điểm.',
        default: false
      },
      targetActivity: {
        type: 'string',
        description: 'Tên, số (ví dụ: "09", "Ôn tập kiến thức tuần 9") hoặc URL bài quiz/assignment (/mod/quiz/view.php?id=...); KHÔNG truyền URL trang video/bài giảng (/mod/page/). Truyền "ALL" để xét mọi bài.'
      },
      solveAll: {
        type: 'boolean',
        description: 'Đặt true để tự động giải HẾT toàn bộ các bài hợp lệ trong môn học theo tuần tự (không dừng sau 1 bài). Dùng khi người dùng bảo "làm hết", "làm tất cả", "từ bài 10 đến 14", "các bài sau bài 09".',
        default: false
      },
      maxQuizzes: {
        type: 'number',
        description: 'Giới hạn số bài giải tối đa khi bật solveAll (tùy chọn)',
        default: 30
      },
      afterActivity: {
        type: 'string',
        description: 'Chỉ làm các bài đứng SAU mốc bài này trong môn học (ví dụ: "09" -> làm từ bài 10 trở đi và các bài ôn tập phía sau).'
      },
      activityRange: {
        type: 'string',
        description: 'Dải số hoặc danh sách bài cần làm (ví dụ: "10-14", "10, 11, 12", "sau 9").'
      },
      excludeActivities: {
        type: 'array',
        description: 'Danh sách tên/số bài cần bỏ qua (ví dụ: ["01", "09"]).'
      },
      maxGradeToReattempt: {
        type: 'number',
        description: 'Chỉ làm lại nếu điểm hiện tại thấp hơn ngưỡng này (ví dụ: 8 nghĩa là chỉ re-attempt bài < 8 điểm).'
      },
      filePath: {
        type: 'string',
        description: 'Đường dẫn file local cần đính kèm/nộp lên Assignment (hoặc form có nút upload file).'
      },
      documentFormat: {
        type: 'string',
        description: 'Định dạng tài liệu AI sẽ tự soạn để nộp file khi người dùng không đưa file sẵn (docx, pdf, png, txt, md, csv, xlsx).',
        enum: ['docx', 'pdf', 'png', 'txt', 'md', 'csv', 'xlsx']
      },
      essayText: {
        type: 'string',
        description: 'Nội dung bài viết tự luận/Online text cụ thể (nếu người dùng đã soạn sẵn).'
      },
      solveAssignments: {
        type: 'boolean',
        description: 'Đặt true để tự động soạn bài viết và/hoặc nộp file cho các bài tập Assignment (/mod/assign/) trong môn học.',
        default: false
      },
      useWordApp: {
        type: 'boolean',
        description: 'Mở và thao tác trực tiếp Microsoft Word trên máy người dùng để soạn bài luận có cấu trúc, tự lưu file .docx rồi đẩy lên trang nộp bài.'
      },
      wordSavePath: {
        type: 'string',
        description: 'Đường dẫn file .docx cụ thể để lưu bài viết khi thao tác trong Microsoft Word (tùy chọn).'
      },
      wordTemplatePath: {
        type: 'string',
        description: 'Đường dẫn file .docx mẫu có sẵn để Microsoft Word mở và viết tiếp vào phần cuối.'
      },
      studentHeader: {
        type: 'string',
        description: 'Dòng header thông tin sinh viên (Họ tên, MSSV, Lớp...) in trên đầu file Word hoặc bài viết tay.'
      },
      handwritingMode: {
        type: 'boolean',
        description: 'Tạo bài nộp dạng chữ viết tay (trên giấy kẻ/ô ly) xuất PDF/PNG/DOCX dựa theo nét chữ mẫu nếu có.'
      },
      handwritingSamplePath: {
        type: 'string',
        description: 'Đường dẫn ảnh mẫu chữ viết tay (.png/.jpg/.jpeg) hoặc font chữ cá nhân (.ttf/.otf) của người dùng.'
      },
      parallel: {
        type: 'boolean',
        description: 'Chạy song song đa luồng nhiều tab trình duyệt cùng lúc khi giải nhiều bài hoặc nhiều khóa học.'
      },
      concurrency: {
        type: 'number',
        description: 'Số luồng/tab xử lý song song tối đa (2-4).'
      },
      targetCourses: {
        type: 'array',
        description: 'Danh sách từ 2 tên/mã khóa học trở lên để chạy đa luồng đồng thời trên nhiều môn học.'
      }
    }
  },
  {
    name: 'browser.back',
    description: 'Quay lại trang web trước đó trong lịch sử trình duyệt (tương tự nút Back). Dùng khi mở một bài tập/quiz thấy đã làm xong để quay lại danh sách môn học tìm bài khác chưa làm.',
    parameters: {
      timeoutMs: { type: 'number', description: 'Thời gian chờ tải trang (ms)', default: 15000 }
    }
  }
];

/** Verifies whether an HTTP request is an authentication/login request allowed during safe operations */
export function isLoginOrAuthUrl(rawUrl: string, method: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();

    // Block any state-mutating assessment endpoints (quizzes, submissions)
    if (isStateMutatingActionUrl(rawUrl)) return false;

    // Standard LMS login paths
    if (path.includes('/login/index.php') || path.endsWith('/login/') || path.includes('/login')) return true;

    // HUST SSO, CAS, and Auth identity providers
    if (host.includes('id.hust.edu.vn') || host.includes('sso.') || path.includes('/cas/login') || path.includes('/auth')) return true;

    // Microsoft / Google SSO OAuth token endpoints
    if (host.includes('login.microsoftonline.com') || host.includes('accounts.google.com')) return true;

    return false;
  } catch {
    return false;
  }
}

/** Checks if the page is currently on an authentication / login screen and attempts auto-login if account is available */
export async function checkAndHandleAuth(
  page: Page,
  ctx: AgentContext
): Promise<{ isAuthPage: boolean; autoLoggedIn: boolean; observationText?: string }> {
  const currentUrl = page.url();
  let pwdCount = 0;
  let msEmailCount = 0;
  try {
    pwdCount = await page.locator('input[type="password"]:visible').count();
    msEmailCount = await page.locator('input[name="loginfmt"]:visible, #i0116:visible, input[type="email"]:visible').count();
  } catch {}

  const isAuthPage = currentUrl.includes('/login/') ||
    currentUrl.includes('/cas/login') ||
    currentUrl.includes('id.hust.edu.vn') ||
    currentUrl.includes('login.microsoftonline.com') ||
    currentUrl.includes('login.live.com') ||
    pwdCount > 0 ||
    (msEmailCount > 0 && currentUrl.includes('microsoftonline.com'));

  if (!isAuthPage) {
    return { isAuthPage: false, autoLoggedIn: false };
  }

  const pageHost = (() => {
    try {
      return new URL(currentUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  // Check if auto-login is enabled and an account or in-memory credentials are available
  if (ctx.config.autoLogin !== false && pageHost) {
    // 1. Try in-memory credentials first if target host matches or is generic
    if (ctx.config.inMemoryCredentials) {
      let matches = true;
      if (ctx.config.targetWebUrl) {
        try {
          const tHost = new URL(ctx.config.targetWebUrl).hostname.toLowerCase();
          const tParts = tHost.split('.');
          const tRoot = tParts.length >= 2 ? tParts.slice(-2).join('.') : tHost;
          matches = pageHost === tHost ||
            pageHost.endsWith('.' + tHost) ||
            pageHost.endsWith('.' + tRoot) ||
            pageHost.includes('microsoftonline.com') ||
            pageHost.includes('login.live.com') ||
            pageHost.includes('accounts.google.com') ||
            pageHost.includes('id.') ||
            pageHost.includes('sso.') ||
            pageHost.includes('cas.') ||
            pageHost.includes('auth.');
        } catch {}
      }
      if (matches) {
        const trusted = [...ctx.config.allowedHosts, pageHost];
        const loginRes = await attemptAutoLogin(page, 'in_memory', trusted, ctx.config.inMemoryCredentials);
        const isVerified = loginRes.success && (await verifyIsLoggedIn(page));
        if (isVerified) {
          ctx.isLoggedIn = true;
          ctx.activeAccountId = 'in_memory';
          ctx.activeUrl = page.url();
          const afterTitle = await page.title().catch(() => '');
          return {
            isAuthPage: false,
            autoLoggedIn: true,
            observationText: `[ĐÃ TỰ ĐỘNG ĐĂNG NHẬP] Đã sử dụng thông tin tài khoản tự động đăng nhập và xác thực thành công. Hiện đang ở trang: "${afterTitle}" (${ctx.activeUrl})`
          };
        }
        if (loginRes.status === 'MFA_REQUIRED') {
          ctx.isLoggedIn = false;
          return {
            isAuthPage: true,
            autoLoggedIn: false,
            observationText: `[XÁC THỰC MFA] Đã điền thông tin tài khoản. Hệ thống yêu cầu mã xác thực 2 bước (MFA/OTP). Vui lòng hoàn thành trên trình duyệt.`
          };
        }
      }
    }

    // 2. Try saved accounts from Windows Credential Manager that match the current host
    const accounts = await listAccounts();
    const accountIds = Object.keys(accounts);

    const matchesHost = (acc: any) => {
      const trusted = [acc.loginHost, ...(acc.trustedLoginHosts || [])].map(h => h.toLowerCase().trim());
      if (trusted.some(h => pageHost === h || pageHost.endsWith('.' + h))) return true;
      const accParts = acc.loginHost.split('.');
      const accRoot = accParts.length >= 2 ? accParts.slice(-2).join('.') : acc.loginHost;
      if (pageHost.endsWith('.' + accRoot)) return true;
      if (pageHost.includes('microsoftonline.com') || pageHost.includes('login.live.com') || pageHost.includes('accounts.google.com')) {
        return true;
      }
      return false;
    };

    let targetAccountId = ctx.activeAccountId || ctx.config.accountId;
    if (targetAccountId && (!accounts[targetAccountId] || !matchesHost(accounts[targetAccountId]))) {
      targetAccountId = undefined;
    }

    if (!targetAccountId) {
      const defaultId = await getDefaultAccountId();
      if (defaultId && accounts[defaultId] && matchesHost(accounts[defaultId])) {
        targetAccountId = defaultId;
      } else {
        const matchingId = accountIds.find(id => matchesHost(accounts[id]));
        if (matchingId) targetAccountId = matchingId;
      }
    }

    if (targetAccountId && accounts[targetAccountId]) {
      const acc = accounts[targetAccountId];
      const trusted = [acc.loginHost, ...(acc.trustedLoginHosts || [])];

      const loginRes = await attemptAutoLogin(page, targetAccountId, trusted);
      const isVerified = loginRes.success && (await verifyIsLoggedIn(page));
      if (isVerified) {
        ctx.isLoggedIn = true;
        ctx.activeAccountId = targetAccountId;
        ctx.activeUrl = page.url();
        const afterTitle = await page.title().catch(() => '');
        return {
          isAuthPage: false,
          autoLoggedIn: true,
          observationText: `[ĐÃ TỰ ĐỘNG ĐĂNG NHẬP] Đã sử dụng tài khoản "${targetAccountId}" tự động đăng nhập và xác thực thành công. Hiện đang ở trang: "${afterTitle}" (${ctx.activeUrl})`
        };
      }
      if (loginRes.status === 'MFA_REQUIRED') {
        ctx.isLoggedIn = false;
        return {
          isAuthPage: true,
          autoLoggedIn: false,
          observationText: `[XÁC THỰC MFA] Đã điền thông tin tài khoản "${targetAccountId}". Hệ thống yêu cầu mã xác thực 2 bước (MFA/OTP). Vui lòng hoàn thành trên trình duyệt.`
        };
      }
    }
  }

  ctx.isLoggedIn = false;
  const accounts = await listAccounts();
  const accList = Object.keys(accounts);
  const hint = accList.length > 0
    ? `(Tài khoản có sẵn: ${accList.join(', ')}. Hãy gõ 'account use <id>' hoặc 'account add' trong terminal)`
    : `(Chưa có tài khoản nào được lưu. Bạn có thể gõ 'account add' trong terminal để lưu tài khoản tự động đăng nhập)`;

  return {
    isAuthPage: true,
    autoLoggedIn: false,
    observationText: `[XÁC THỰC YÊU CẦU] Trang đăng nhập/SSO phát hiện tại ${currentUrl}. Cần học viên đăng nhập trước khi tiếp tục. ${hint}`
  };
}

/** Verifies that a given URL is permitted under agent configuration */
export function isUrlAllowed(urlStr: string, allowedHosts: string[]): boolean {
  if (urlStr === 'about:blank') return true;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'about:') return true;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host === 'login.microsoftonline.com' || host === 'login.live.com' || host === 'accounts.google.com') return true;
    if (host.includes('hust.edu.vn') || host.includes('sso.') || host.includes('cas.') || host.includes('adfs.') || host.includes('id.')) {
      return true;
    }
    return allowedHosts.some(allowed => {
      const a = allowed.toLowerCase().trim();
      return host === a || host.endsWith('.' + a);
    });
  } catch {
    return false;
  }
}

/** Initializes or retrieves Playwright browser and page with strict read-only security guards */
export async function ensureBrowserPage(ctx: AgentContext, initialUrl?: string): Promise<Page> {
  // Ensure targetWebUrl host is in allowedHosts
  if (ctx.config.targetWebUrl) {
    registerAllowedUrlHost(ctx.config.allowedHosts, ctx.config.targetWebUrl);
  }

  // 1. Resolve active account ID if not already set
  if (!ctx.activeAccountId) {
    if (ctx.config.accountId) {
      ctx.activeAccountId = ctx.config.accountId;
    } else {
      const defaultId = await getDefaultAccountId();
      if (defaultId) ctx.activeAccountId = defaultId;
    }
  }

  if (!ctx.context) {
    const headless = ctx.config.headless !== false;
    if (ctx.browser) {
      // Test double or pre-created shared browser
      ctx.context = await ctx.browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: false
      });
    } else {
      // Real agent mode: persistent session directory
      const sessionAccount = ctx.activeAccountId || 'default';
      const sessionDir = resolve('.private', 'sessions', sessionAccount);
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

      ctx.context = await chromium.launchPersistentContext(sessionDir, {
        headless,
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: false, // Strict HTTPS invariant
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      ctx.browser = ctx.context.browser() || undefined;
    }

    // Attach route guards for read-only safety while allowing safe login & read-only ajax
    await ctx.context.route('**/*', route => {
      const req = route.request();
      const method = req.method().toUpperCase();
      const url = req.url();

      const allowMutating = ctx.config.autoRead === false ||
                            ctx.config.requireStateChangeApproval === false ||
                            ctx.config.userIntent === 'SOLVE_QUIZ';

      if (!allowMutating && isMutatingHttpMethod(method)) {
        if (url.includes('localhost') || url.includes('127.0.0.1')) {
          return route.fallback();
        }
        // Allow legitimate authentication endpoints (login forms, SSO tokens)
        if (isLoginOrAuthUrl(url, method)) {
          return route.fallback();
        }
        // Allow verified safe read-only Moodle AJAX services
        if (isSafeReadOnlyAjaxRequest(method, url, req.postData())) {
          return route.fallback();
        }
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });
  }

  if (!ctx.page || ctx.page.isClosed()) {
    const pages = ctx.context.pages();
    ctx.page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  }

  if (initialUrl && (!ctx.activeUrl || ctx.activeUrl === 'about:blank')) {
    if (isUrlAllowed(initialUrl, ctx.config.allowedHosts)) {
      await ctx.page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      ctx.activeUrl = ctx.page.url();
    }
  }

  return ctx.page;
}

/** Shared formatter for quiz/assignment inspection state across navigation, observation, and clicks */
function formatQuizStatusObservation(
  ctx: AgentContext,
  url: string,
  title: string,
  quizStatus: QuizStatusDetails,
  useObserveCopy = false
): string {
  if (quizStatus.isAuthPage) {
    return `\n★ TRẠNG THÁI BÀI THI: [YÊU CẦU ĐĂNG NHẬP] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Phiên LMS chưa đăng nhập hoặc đã hết hạn! Hãy gọi "account.login" để đăng nhập trước khi làm bài này (TUYỆT ĐỐI KHÔNG báo nhầm là đã hết hạn nộp bài).`;
  }

  if (quizStatus.isErrorPage) {
    return `\n★ TRẠNG THÁI BÀI THI: [TRANG LỖI LMS] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Trang hiện tại báo lỗi trên LMS (liên kết cũ hoặc ID sai). TUYỆT ĐỐI KHÔNG báo nhầm là đã hết hạn! Hãy gọi "browser.back" về trang môn học và chọn đúng liên kết thật từ DOM.`;
  }

  if (quizStatus.isDone) {
    recordCheckedActivity(ctx, url, 'COMPLETED', quizStatus.details, title, quizStatus.grade, quizStatus.canReattempt);
    if (quizStatus.canReattempt) {
      if (ctx.config.allowReattempt) {
        return `\n★ TRẠNG THÁI BÀI THI: [ĐÃ CÓ LƯỢT LÀM - CÒN NÚT RE-ATTEMPT QUIZ] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Người dùng ĐÃ YÊU CẦU làm lại! Hãy gọi ngay "quiz.solve" với { autoSubmit: true, allowReattempt: true } để bấm Re-attempt quiz, giải lại và nộp bài.`;
      }
      return `\n★ TRẠNG THÁI BÀI THI: [ĐÃ LÀM XONG] (${quizStatus.details}). Lưu ý: Bài vẫn còn nút "Re-attempt quiz" (chưa đóng), có thể làm lại nếu người dùng yêu cầu.\n👉 HƯỚNG DẪN: Người dùng chưa yêu cầu làm lại bài cũ! Hãy giữ nguyên kết quả hiện tại và dùng "browser.back" về trang môn học tìm bài chưa làm (chỉ gọi "quiz.solve" với allowReattempt=true nếu người dùng yêu cầu làm lại).`;
    }
    return useObserveCopy
      ? `\n★ TRẠNG THÁI BÀI THI: [ĐÃ LÀM XONG] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Bài này đã làm xong rồi! Hãy dùng công cụ "browser.back" để quay lại trang môn học và chọn bài tiếp theo chưa làm (TUYỆT ĐỐI KHÔNG làm lại bài này)!`
      : `\n★ TRẠNG THÁI BÀI THI: [ĐÃ LÀM XONG] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Bài này đã làm xong rồi! BẮT BUỘC gọi "browser.back" để quay lại trang môn học tìm bài khác chưa làm, TUYỆT ĐỐI KHÔNG làm lại bài này!`;
  }

  if (quizStatus.isExpired || quizStatus.state === 'CLOSED' || !quizStatus.canAttempt) {
    recordCheckedActivity(ctx, url, 'CLOSED', quizStatus.details, title);
    return useObserveCopy
      ? `\n★ TRẠNG THÁI BÀI THI: [ĐÃ HẾT HẠN / ĐÃ ĐÓNG] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Bài này đã quá hạn/đóng, KHÔNG THỂ LÀM. Hãy dùng công cụ "browser.back" để quay lại trang môn học tìm bài khác còn hạn (KHÔNG báo cáo là đã làm xong bài này)!`
      : `\n★ TRẠNG THÁI BÀI THI: [ĐÃ HẾT HẠN / ĐÃ ĐÓNG] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Bài này đã quá hạn/đóng, KHÔNG THỂ LÀM. BẮT BUỘC gọi "browser.back" để quay lại trang môn học tìm bài khác còn hạn!`;
  }

  if (quizStatus.canAttempt) {
    return useObserveCopy
      ? `\n★ TRẠNG THÁI BÀI THI: [CHƯA LÀM / CẦN LÀM] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Hãy gọi ngay "quiz.solve" với autoSubmit=true để tự động giải và nộp bài!`
      : `\n★ TRẠNG THÁI BÀI THI: [CHƯA LÀM & CÒN HẠN] (${quizStatus.details}).\n👉 HƯỚNG DẪN: Hãy gọi ngay "quiz.solve" với autoSubmit=true để giải và nộp bài!`;
  }

  return '';
}

/** Shared post-navigation auth check, auto-login trigger, and session verification for browser.open and browser.navigate. */
async function finalizePageNavigation(
  page: Page,
  ctx: AgentContext,
  actionPrefix: string,
  fallbackTitle = ''
): Promise<ToolResult> {
  const currentUrl = page.url();
  ctx.activeUrl = currentUrl;
  const title = await page.title().catch(() => fallbackTitle);

  const authCheck = await checkAndHandleAuth(page, ctx);
  if (authCheck.autoLoggedIn) {
    const afterTitle = await page.title().catch(() => title);
    return {
      success: true,
      data: { url: ctx.activeUrl, title: afterTitle, autoLoggedIn: true },
      observationText: authCheck.observationText!,
      urlAfter: ctx.activeUrl
    };
  }
  if (authCheck.isAuthPage) {
    return {
      success: true,
      data: { url: currentUrl, title, authRequired: true },
      observationText: authCheck.observationText!,
      urlAfter: currentUrl
    };
  }

  const isSessionActive = await verifyIsLoggedIn(page);
  if (isSessionActive) {
    ctx.isLoggedIn = true;
  }

  let obsText = `${actionPrefix}: "${title}" (${currentUrl})`;
  const quizStatus = await inspectQuizOrAssignmentStatus(page);
  if (quizStatus) {
    obsText += formatQuizStatusObservation(ctx, currentUrl, title, quizStatus, false);
  }

  return {
    success: true,
    data: { url: currentUrl, title, isLoggedIn: ctx.isLoggedIn, quizStatus: quizStatus || undefined },
    observationText: obsText,
    urlAfter: currentUrl
  };
}

function formatRemainingDurationVN(remainingHours: number): string {
  const absH = Math.abs(remainingHours);
  if (absH < 1) {
    return `${Math.max(1, Math.round(absH * 60))} phút`;
  }
  if (absH < 24) {
    return `${Math.round(absH * 10) / 10} giờ`;
  }
  const days = Math.floor(absH / 24);
  const hrs = Math.round(absH % 24);
  return `${days} ngày${hrs > 0 ? ` ${hrs} giờ` : ''}`;
}

function formatLocalTimeVN(iso: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Splits and formats deadlines chronologically against the current real-time clock (GMT+7). */
export function formatDeadlinesObservation(
  deadlines: { label: string; dueAt: string; remainingHours?: number }[],
  nowMs = Date.now()
): string {
  const nowDate = new Date(nowMs);
  const nowLocal = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(nowDate);

  const normalized = deadlines
    .map(d => {
      const dueMs = new Date(d.dueAt).getTime();
      const remHours = typeof d.remainingHours === 'number'
        ? d.remainingHours
        : Math.round(((dueMs - nowMs) / 3600000) * 10) / 10;
      return { ...d, dueMs, remHours };
    })
    .filter(d => Number.isFinite(d.dueMs) && Number.isFinite(d.remHours));

  const upcoming = normalized
    .filter(d => d.remHours > 0)
    .sort((a, b) => a.dueMs - b.dueMs);
  const pastClosed = normalized
    .filter(d => d.remHours <= 0)
    .sort((a, b) => b.dueMs - a.dueMs);

  let out = `- 🕒 Thời gian thực hiện tại (GMT+7): ${nowLocal} (${nowDate.toISOString()})\n`;
  if (upcoming.length > 0) {
    out += `- ⏰ BÀI SẮP ĐẾN HẠN (${upcoming.length} bài có hạn trong tương lai):\n`;
    for (const u of upcoming.slice(0, 20)) {
      out += `  • [SẮP ĐẾN HẠN - còn ${formatRemainingDurationVN(u.remHours)}] ${u.label} | Hạn: ${formatLocalTimeVN(u.dueAt)} (${u.dueAt})\n`;
    }
  } else if (pastClosed.length > 0) {
    out += `- ⚠ KẾT LUẬN THỜI GIAN THỰC: Hiện tại KHÔNG CÓ bài nào sắp đến hạn (0 bài có hạn trong tương lai). Toàn bộ ${pastClosed.length} mốc thời gian trên trang đều ĐÃ QUÁ HẠN / ĐÃ ĐÓNG từ trước — TUYỆT ĐỐI KHÔNG báo các bài cũ này là bài sắp đến hạn!\n`;
  }
  if (pastClosed.length > 0) {
    out += `- Mốc đã đóng gần đây trong quá khứ (${pastClosed.length}, hiển thị tối đa 5 mục gần nhất):\n`;
    for (const p of pastClosed.slice(0, 5)) {
      out += `  • [ĐÃ QUÁ HẠN / ĐÃ ĐÓNG TRONG QUÁ KHỨ - đã đóng ${formatRemainingDurationVN(p.remHours)} trước] ${p.label} | Hạn cũ: ${formatLocalTimeVN(p.dueAt)} (${p.dueAt})\n`;
    }
  }
  return out;
}

/** Visits inside quiz/assignment pages in parallel read-only tabs to verify true completion, attempt history & grades. */
async function deepVerifyCourseActivities(
  page: Page,
  ctx: AgentContext,
  activities: ActivityItem[],
  filterText?: string,
  maxInspect = 16
): Promise<void> {
  const filt = (filterText || '').trim().toLowerCase();
  const candidates = activities
    .filter(a => (a.kind === 'quiz' || a.kind === 'assignment') && Boolean(a.url))
    .filter(a => !filt || a.title.toLowerCase().includes(filt))
    .filter(a => {
      const cached = getCheckedActivity(ctx, a.url);
      return !cached?.completionConfirmed;
    })
    // Prioritize open / unconfirmed items first so expired items don't starve open unsubmitted quizzes later in the course
    .sort((a, b) => Number(Boolean(a.isExpired)) - Number(Boolean(b.isExpired)) || Number(Boolean(a.isCompleted)) - Number(Boolean(b.isCompleted)))
    .slice(0, maxInspect);

  if (candidates.length === 0) return;

  const inspectOne = async (targetPage: Page, act: ActivityItem) => {
    try {
      const resp = await targetPage.goto(act.url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      if (!resp || !resp.ok()) return;
      const status = await inspectQuizOrAssignmentStatus(targetPage);
      if (!status || status.isAuthPage || status.isErrorPage) return;
      const inProgTag = status.isInProgress ? ' [IN PROGRESS - CHƯA NỘP]' : '';
      if (status.isDone) {
        recordCheckedActivity(ctx, act.url, 'COMPLETED', `${status.details}${inProgTag}`, act.title, status.grade, status.canReattempt, Boolean(status.isExpired), true);
      } else if (status.isExpired) {
        if (typeof act.remainingHours === 'number' && act.remainingHours > 0 && !status.dueText) {
          recordCheckedActivity(ctx, act.url, 'OPEN', `${status.details}${inProgTag}`, act.title, status.grade, status.canReattempt, false, false);
        } else {
          recordCheckedActivity(ctx, act.url, 'CLOSED', `${status.details}${inProgTag}`, act.title, status.grade, status.canReattempt, true, true);
        }
      } else {
        recordCheckedActivity(ctx, act.url, 'OPEN', `${status.details}${inProgTag}`, act.title, status.grade, status.canReattempt, false, true);
      }
    } catch {
      // Leave unconfirmed if a single deep check fails/times out
    }
  };

  const courseUrl = page.url();
  if (ctx.context) {
    let cursor = 0;
    const workers = Math.min(4, candidates.length);
    try {
      await Promise.all(
        Array.from({ length: workers }, async () => {
          const tab = await ctx.context!.newPage();
          try {
            while (true) {
              const idx = cursor++;
              if (idx >= candidates.length) break;
              await inspectOne(tab, candidates[idx]);
            }
          } finally {
            await tab.close().catch(() => {});
          }
        })
      );
    } finally {
      ctx.page = page;
      ctx.activeUrl = courseUrl;
    }
  } else {
    try {
      for (const act of candidates) {
        await inspectOne(page, act);
      }
    } finally {
      await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  }
}

/** Enriches scraped course activities with previously verified session statuses and formats a clear summary */
function enrichAndFormatActivities(
  rawActivities: ActivityItem[],
  ctx: AgentContext,
  maxDisplay = 40,
  useSelectorFormat = false
): { activities: ActivityItem[]; summaryBlock: string } {
  const allowReattempt = Boolean(ctx.config.allowReattempt);
  const targetNorm = (ctx.config.targetActivity || '').toLowerCase().trim();

  const enriched = rawActivities.map(a => {
    const checked = getCheckedActivity(ctx, a.url);
    return {
      ...a,
      isCompleted: Boolean(a.isCompleted || checked?.state === 'COMPLETED' || checked?.state === 'SOLVED_NOW'),
      isExpired: Boolean(a.isExpired || checked?.state === 'CLOSED' || checked?.isClosed),
      completionConfirmed: Boolean(a.completionConfirmed || checked?.completionConfirmed),
      grade: a.grade || checked?.grade,
      dueText: a.dueText || (checked?.state === 'CLOSED' && checked.details ? checked.details : undefined),
      innerDetails: a.innerDetails || checked?.details
    };
  });

  const relevantRaw = useSelectorFormat
    ? enriched.filter(a => a.kind === 'quiz' || a.kind === 'assignment')
    : enriched;

  if (relevantRaw.length === 0) {
    return { activities: enriched, summaryBlock: '' };
  }

  // Always place actionable quizzes & assignments ahead of non-gradable pages/forums/resources so courses with many slides never truncate quizzes!
  const gradable = relevantRaw.filter(a => a.kind === 'quiz' || a.kind === 'assignment');
  const others = useSelectorFormat ? [] : relevantRaw.filter(a => a.kind !== 'quiz' && a.kind !== 'assignment');

  const sortMatchesFirst = <T extends ActivityItem>(items: T[]): T[] => (
    targetNorm
      ? [...items].sort((a, b) => {
          const aHit = a.title.toLowerCase().includes(targetNorm) ? 1 : 0;
          const bHit = b.title.toLowerCase().includes(targetNorm) ? 1 : 0;
          return bHit - aHit;
        })
      : items
  );

  const orderedGradable = sortMatchesFirst(gradable);
  const orderedOthers = sortMatchesFirst(others);

  const gradableCap = Math.max(maxDisplay, 50);
  const shownGradable = orderedGradable.slice(0, gradableCap);
  const remainingOtherCap = shownGradable.length > 0
    ? Math.max(0, Math.min(8, maxDisplay - shownGradable.length))
    : maxDisplay;
  const shownOthers = orderedOthers.slice(0, remainingOtherCap);
  const displayItems = [...shownGradable, ...shownOthers];

  let completedCount = 0;
  let openCount = 0;
  let missedClosedCount = 0;
  let unverifiedClosedCount = 0;
  const openUntouchedTitles: string[] = [];
  const inProgressTitles: string[] = [];

  let block = useSelectorFormat
    ? `Danh sách bài tập / trắc nghiệm (${orderedGradable.length}):\n`
    : `- Danh sách bài tập / trắc nghiệm cần chú ý (${orderedGradable.length} quiz/assign trong tổng ${relevantRaw.length} hoạt động):\n`;

  for (const a of orderedGradable) {
    const isInProg = Boolean(a.innerDetails && /IN PROGRESS|đang\s*làm\s*dở|tiếp\s*tục\s*lần\s*làm/i.test(a.innerDetails));
    if (a.isCompleted) {
      completedCount++;
    } else if (!a.isExpired) {
      openCount++;
      if (isInProg) inProgressTitles.push(a.title);
      else openUntouchedTitles.push(a.title);
    } else if (a.completionConfirmed) {
      missedClosedCount++;
    } else {
      unverifiedClosedCount++;
    }
  }

  for (const a of displayItems) {
    const checked = getCheckedActivity(ctx, a.url);
    const gradeStr = a.grade ? ` | Điểm: ${a.grade}` : '';
    const dueNote = a.dueText ? ` (${a.dueText})` : '';
    const isInProg = Boolean(a.innerDetails && /IN PROGRESS|đang\s*làm\s*dở|tiếp\s*tục\s*lần\s*làm/i.test(a.innerDetails));
    let statusTag = isInProg ? '[ĐANG LÀM DỞ - CHƯA NỘP (IN PROGRESS) ⚠]' : '[CHƯA LÀM & ĐANG MỞ ★]';

    if (a.isCompleted && a.isExpired) {
      statusTag = `[ĐÃ LÀM XONG ✓${gradeStr} | Hiện đã đóng${dueNote}]`;
    } else if (a.isCompleted) {
      const reattemptStr = (allowReattempt || checked?.canReattempt) && a.kind === 'quiz' ? ' (Có nút làm lại)' : '';
      statusTag = `[ĐÃ LÀM XONG ✓${gradeStr} | Đang mở${reattemptStr}]`;
    } else if (a.isExpired && a.completionConfirmed) {
      statusTag = `[ĐÃ HẾT HẠN / ĐÓNG - CHƯA LÀM / BỎ LỠ ✗ | Đã đóng mà không có lượt nộp nào${dueNote}]`;
    } else if (a.isExpired) {
      statusTag = `[ĐÃ ĐÓNG HẠN${dueNote} | ❓ Chưa rõ đã làm hay chưa trên trang ngoài — gọi browser.extractStructuredData({ type: "activities", deepVerify: true }) hoặc mở URL bài để kiểm tra]`;
    } else if (typeof a.remainingHours === 'number' && a.remainingHours > 0) {
      statusTag = `[${isInProg ? 'ĐANG LÀM DỞ (IN PROGRESS) ⚠' : 'CHƯA LÀM & ĐANG MỞ ★'} | Sắp đến hạn: còn ${formatRemainingDurationVN(a.remainingHours)}${dueNote}]`;
    } else if (a.dueText) {
      statusTag = `[${isInProg ? 'ĐANG LÀM DỞ (IN PROGRESS) ⚠' : 'CHƯA LÀM & ĐANG MỞ ★'} | ${a.dueText}]`;
    }

    const secNote = a.sectionTitle ? ` [${a.sectionTitle}]` : '';
    if (useSelectorFormat) {
      block += `  • ${statusTag} "${a.title}"${secNote} -> Selector: a[href="${a.url}"]\n`;
    } else {
      block += `  • ${statusTag} "${a.title}"${secNote} (${a.kind}) -> URL: ${a.url}\n`;
    }
  }

  const hiddenGradable = orderedGradable.length - shownGradable.length;
  const hiddenOthers = orderedOthers.length - shownOthers.length;
  if (hiddenGradable > 0 || hiddenOthers > 0) {
    block += `  ... (còn ${hiddenGradable > 0 ? `${hiddenGradable} bài tập/quiz ` : ''}${hiddenOthers > 0 ? `${hiddenOthers} tài liệu/forum/page` : ''}).\n`;
  }

  block += `📊 Tổng hợp trạng thái thực tế: ${completedCount} bài ĐÃ LÀM XONG (có điểm/lượt nộp) | ${openCount} bài ĐANG MỞ CHƯA LÀM${inProgressTitles.length > 0 ? ` (${openUntouchedTitles.length} chưa làm lần nào, ${inProgressTitles.length} đang làm dở)` : ''} | ${missedClosedCount} bài ĐÃ ĐÓNG MÀ CHƯA LÀM (bỏ lỡ)${unverifiedClosedCount > 0 ? ` | ${unverifiedClosedCount} bài ĐÃ ĐÓNG chưa kiểm tra sâu` : ''}.\n`;
  if (!useSelectorFormat && openUntouchedTitles.length > 0) {
    block += `  👉 Các bài quiz/assign ĐANG MỞ & CHƯA CÓ LẦN NỘP NÀO: ${openUntouchedTitles.slice(0, 15).map(t => `"${t}"`).join(', ')}${openUntouchedTitles.length > 15 ? ` (+${openUntouchedTitles.length - 15} bài nữa)` : ''}\n`;
  }
  if (!useSelectorFormat && inProgressTitles.length > 0) {
    block += `  ⚠ Các bài ĐANG LÀM DỞ (IN PROGRESS - CHƯA NỘP): ${inProgressTitles.slice(0, 10).map(t => `"${t}"`).join(', ')}\n`;
  }

  return { activities: enriched, summaryBlock: block };
}

/** Shared DOM course list scraper used by both browser.observe and browser.extractStructuredData. */
async function extractPageCourses(page: Page, limit?: number): Promise<{ name: string; url: string; code?: string }[]> {
  const rawCourses = await page.evaluate(() => {
    const found: { name: string; url: string }[] = [];
    const seenUrls = new Set<string>();
    const candidates: HTMLAnchorElement[] = [];
    document.querySelectorAll('.dashboard-card, .coursebox, .coursename, [data-region="course-content"]').forEach(card => {
      card.querySelectorAll<HTMLAnchorElement>('a[href*="/course/view.php"], a[href*="/courses/"]').forEach(a => candidates.push(a));
    });
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/course/view.php"], a[href*="/courses/"]').forEach(a => candidates.push(a));

    for (const a of candidates) {
      const href = a.href || '';
      if (!/\/course\/view\.php\?id=\d+|\/courses\/\d+/i.test(href) || href.includes('#')) continue;
      if (seenUrls.has(href)) continue;
      const clone = a.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.sr-only, .accesshide').forEach(n => n.remove());
      const name = (clone.textContent || a.title || '').replace(/\s+/g, ' ').trim();
      if (/^(?:star|unstar)\s+this\s+course$/i.test(name)) continue;
      if (name.length > 3) {
        seenUrls.add(href);
        found.push({ name, url: href });
      }
    }
    return found;
  }).catch(() => []);

  const enriched = rawCourses.map(c => {
    const cleanName = c.name
      .replace(/^(?:Course is starred|Starred course|Course name|Khóa học được gắn sao|Tên khóa học)\s*:?\s*/i, '')
      .trim();
    return {
      name: cleanName,
      url: c.url,
      code: extractCourseCode(cleanName)
    };
  });

  return typeof limit === 'number' ? enriched.slice(0, limit) : enriched;
}

/** Executes a tool call within the agent context */
export async function executeAgentTool(call: ToolCall, ctx: AgentContext): Promise<ToolResult> {
  const { tool, args } = call;

  try {
    switch (tool) {
      case 'browser.open': {
        const url = args.url as string | undefined;
        const page = await ensureBrowserPage(ctx, url);
        return finalizePageNavigation(page, ctx, 'Đã mở trình duyệt tại', 'Untitled');
      }

      case 'browser.navigate': {
        const url = String(args.url || '').trim();
        if (!url) {
          return { success: false, error: 'Thiếu tham số url', observationText: 'Lỗi: browser.navigate yêu cầu tham số url hợp lệ.' };
        }

        if (!isUrlAllowed(url, ctx.config.allowedHosts)) {
          return {
            success: false,
            error: `URL không thuộc danh sách cho phép (${ctx.config.allowedHosts.join(', ')}): ${url}`,
            observationText: `[BẢO MẬT] Từ chối điều hướng: URL "${url}" nằm ngoài phạm vi tên miền được phê duyệt.`
          };
        }

        const page = await ensureBrowserPage(ctx);
        const timeoutMs = Number(args.timeoutMs) || 25000;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        return finalizePageNavigation(page, ctx, 'Đã điều hướng tới', '');
      }

      case 'browser.observe': {
        const page = await ensureBrowserPage(ctx);
        const currentUrl = page.url();
        ctx.activeUrl = currentUrl;
        const title = await page.title().catch(() => '');
        const platform = await detectPlatform(page, ctx.config.allowedHosts);

        const isAuthRequired = currentUrl.includes('/login/') ||
          currentUrl.includes('/cas/login') ||
          currentUrl.includes('id.hust.edu.vn') ||
          currentUrl.includes('login.microsoftonline.com') ||
          (await page.locator('input[type="password"]:visible, input[name="loginfmt"]:visible, #i0116:visible').count()) > 0 ||
          (await page.locator('body.notloggedin').count()) > 0;

        if (isAuthRequired) {
          ctx.isLoggedIn = false;
        } else {
          const verified = await verifyIsLoggedIn(page);
          if (verified) ctx.isLoggedIn = true;
        }

        // Headings (exclude hidden headings inside modals, collapsed drawers, or display:none Moodle banners)
        const headings = await page.evaluate(() => {
          return [...document.querySelectorAll('h1, h2, h3')]
            .filter(h => {
              const el = h as HTMLElement;
              if (el.closest('[hidden], [aria-hidden="true"], .modal:not(.show), .d-none, template')) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 || rect.height > 0;
            })
            .map(h => (h.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(t => t.length > 0)
            .slice(0, 15);
        }).catch(() => []);

        // Interactive buttons / major links
        const interactive = await page.evaluate(() => {
          const els = [...document.querySelectorAll('a[href], button, input[type="button"], input[type="submit"]')];
          return els.slice(0, 30).map(el => {
            const tag = el.tagName.toLowerCase();
            let text = (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            if (!text) {
              const img = el.querySelector('img');
              if (img && (img.src.includes('hust') || el.className.includes('identityprovider') || el.getAttribute('href')?.includes('oauth2'))) {
                text = 'Login with HUST Account (Đăng nhập với tài khoản HUST)';
              }
            }
            const href = el.getAttribute('href') || undefined;
            return { tag, text, href };
          }).filter(e => e.text.length > 0);
        }).catch(() => []);

        // Courses on Moodle dashboard / courses overview
        const courses = await extractPageCourses(page, 20);

        // Deadlines scan
        const deadlines = await scanDeadlines(page).catch(() => []);

        // Course activities scan if on course view
        let activities: ActivityItem[] = [];
        let activitiesSummaryBlock = '';
        if (currentUrl.includes('/course/view.php') || currentUrl.includes('/courses/')) {
          const rawActs = await inspectCourseActivities(page);
          const formattedActs = enrichAndFormatActivities(rawActs, ctx, 40, true);
          activities = formattedActs.activities;
          activitiesSummaryBlock = formattedActs.summaryBlock;
          if (activities.length > 0) {
            ctx.collectedFindings['activities'] = activities;
          }
        }

        // Quiz/assignment status inspection if on quiz or assign page
        const quizStatus = await inspectQuizOrAssignmentStatus(page);

        const obs: PageObservation = {
          url: currentUrl,
          title,
          platform,
          authRequired: isAuthRequired,
          headings,
          interactiveElements: interactive,
          courses: courses.length > 0 ? courses : undefined,
          deadlines: deadlines.length > 0 ? deadlines.map(d => ({ title: d.label, dueAt: d.dueAt, url: d.source })) : undefined,
          activities: activities.length > 0 ? activities : undefined,
          quizStatus: quizStatus || undefined,
          textSnippet: (await page.locator('main, #region-main, body').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1000)
        };

        // Cache in collected findings
        if (courses.length > 0) ctx.collectedFindings['courses'] = courses;
        if (deadlines.length > 0) ctx.collectedFindings['deadlines'] = deadlines;

        let summaryText = `Trang: "${title}" (${currentUrl}) [Nền tảng: ${platform}]\n`;
        if (isAuthRequired) {
          summaryText += `⚠ YÊU CẦU ĐĂNG NHẬP (Phát hiện trang đăng nhập SSO/Moodle)\n`;
          const ssoCandidate = interactive.find(e =>
            /hust|identity|oauth|sso|login with/i.test(e.text) || (e.href && /oauth2|oidc|sso|login\.php\?id=/i.test(e.href))
          );
          if (ssoCandidate) {
            summaryText += `★ NÚT ĐĂNG NHẬP SSO TRƯỜNG: "${ssoCandidate.text}" (Selector: a.login-identityprovider-btn) -> BẮT BUỘC nhấp nút này để vào cổng SSO trường/Microsoft, KHÔNG điền mật khẩu vào form cục bộ bên dưới!\n`;
          }
        }
        if (headings.length > 0) summaryText += `Mục chính: ${headings.slice(0, 5).join(' | ')}\n`;
        if (courses.length > 0) summaryText += `Tìm thấy ${courses.length} khóa học: ${courses.map(c => c.name).slice(0, 4).join(', ')}${courses.length > 4 ? '...' : ''}\n`;
        if (deadlines.length > 0) summaryText += `Tìm thấy ${deadlines.length} hạn nộp/deadline đang hiển thị.\n`;

        if (activitiesSummaryBlock) {
          summaryText += activitiesSummaryBlock;
        }

        if (quizStatus) {
          summaryText += formatQuizStatusObservation(ctx, currentUrl, title, quizStatus, true) + '\n';
        }

        return {
          success: true,
          data: obs,
          observationText: summaryText.trim(),
          urlAfter: currentUrl
        };
      }

      case 'browser.click': {
        const page = await ensureBrowserPage(ctx);
        const { selector, text, timeoutMs = 5000 } = args;

        // Safety gate: block mutating action clicks in READ_ONLY mode
        const targetText = String(text || '').toLowerCase();
        if (/nộp bài|submit|bắt đầu|start attempt|xác nhận nộp|finish attempt/i.test(targetText)) {
          if (ctx.config.requireStateChangeApproval !== false && ctx.config.userIntent !== 'SOLVE_QUIZ') {
            return {
              success: false,
              error: `Thao tác thay đổi trạng thái (${targetText}) yêu cầu người vận hành xác nhận rõ ràng.`,
              observationText: `[BẢO MẬT] Đã chặn nhấp nút thay đổi trạng thái: "${text || selector}". Tác vụ chỉ đọc không tự động nộp bài.`
            };
          }
        }

        const clickWithOptionalPopup = async (clickFn: () => Promise<void>) => {
          const popupPromise = ctx.context
            ? ctx.context.waitForEvent('page', { timeout: 1200 }).catch(() => null)
            : Promise.resolve(null);
          await clickFn();
          const popup = await popupPromise;
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            const popupUrl = popup.url();
            if (popupUrl && popupUrl !== 'about:blank' && isUrlAllowed(popupUrl, ctx.config.allowedHosts)) {
              ctx.page = popup;
              ctx.activeUrl = popupUrl;
              return popup;
            }
          }
          return page;
        };

        let activePage = page;
        if (selector) {
          let loc = page.locator(selector).first();
          if ((await loc.count().catch(() => 0)) === 0) {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              const fLoc = frame.locator(selector).first();
              if ((await fLoc.count().catch(() => 0)) > 0) {
                loc = fLoc;
                break;
              }
            }
          }
          activePage = await clickWithOptionalPopup(() => loc.click({ timeout: timeoutMs }));
        } else if (text) {
          const isSsoTarget = /hust|identity|oauth|sso|login with|login|sign\s*in|đăng\s*nhập/i.test(text);
          const ssoBtn = page.locator('a.login-identityprovider-btn:visible, a[href*="oauth2/login.php"]:visible, a:has-text("Login with HUST"):visible').first();

          if (isSsoTarget && (await ssoBtn.count().catch(() => 0)) > 0 && (await ssoBtn.isVisible().catch(() => false))) {
            activePage = await clickWithOptionalPopup(() => ssoBtn.click({ timeout: timeoutMs }));
          } else {
            const loc = page.getByText(text, { exact: false }).first();
            if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
              activePage = await clickWithOptionalPopup(() => loc.click({ timeout: timeoutMs }));
            } else {
              const courseCode = extractCourseCode(text) || '';
              const courseLink = courseCode ? page.locator(`a[href*="/course/"]:has-text("${courseCode}"), a[href*="/courses/"]:has-text("${courseCode}")`).first() : null;
              const fallback = page.locator('a.login-identityprovider-btn, a[href*="oauth2/login.php"], a[href*="auth/oidc"], a[href*="login.microsoftonline.com"]').first();

              if (/hust|identity|oauth|sso|login|sign/i.test(text) && (await fallback.count()) > 0) {
                activePage = await clickWithOptionalPopup(() => fallback.click({ timeout: timeoutMs }));
              } else if (courseLink && (await courseLink.count()) > 0) {
                activePage = await clickWithOptionalPopup(() => courseLink.click({ timeout: timeoutMs }));
              } else {
                const namedLoc = page.locator(`a:has-text("${text}"), button:has-text("${text}"), [role="button"]:has-text("${text}")`).first();
                if ((await namedLoc.count()) > 0 && (await namedLoc.isVisible().catch(() => false))) {
                  activePage = await clickWithOptionalPopup(() => namedLoc.click({ timeout: timeoutMs }));
                } else {
                  // Accent-insensitive clickable element match across main frame and iframes
                  const targetNorm = stripVietnameseAccents(String(text));
                  let clickedFuzzy = false;
                  for (const frame of page.frames()) {
                    const matchedIdx = await frame.evaluate((needle) => {
                      const candidates = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, [role="button"], input[type="submit"], input[type="button"], summary, label'));
                      let bestIdx = -1;
                      let bestLen = Infinity;
                      for (let i = 0; i < candidates.length; i++) {
                        const el = candidates[i];
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 && rect.height === 0) continue;
                        const raw = (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || '')
                          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
                        if (raw && raw.includes(needle) && raw.length < bestLen) {
                          bestIdx = i;
                          bestLen = raw.length;
                        }
                      }
                      return bestIdx;
                    }, targetNorm).catch(() => -1);

                    if (matchedIdx >= 0) {
                      const fLoc = frame.locator('a[href], button, [role="button"], input[type="submit"], input[type="button"], summary, label').nth(matchedIdx);
                      activePage = await clickWithOptionalPopup(() => fLoc.click({ timeout: timeoutMs }));
                      clickedFuzzy = true;
                      break;
                    }
                  }
                  if (!clickedFuzzy) {
                    activePage = await clickWithOptionalPopup(() => loc.click({ timeout: timeoutMs }));
                  }
                }
              }
            }
          }
        } else {
          return { success: false, error: 'Yêu cầu ít nhất selector hoặc text để nhấp', observationText: 'Lỗi: browser.click cần selector hoặc text.' };
        }

        await activePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await activePage.waitForTimeout(200).catch(() => {});
        const newUrl = activePage.url();
        ctx.activeUrl = newUrl;
        const newTitle = await activePage.title().catch(() => '');

        let clickObs = `Đã nhấp thành công vào "${text || selector}". Trang hiện tại: "${newTitle}" (${newUrl})`;
        const clickQuizStatus = await inspectQuizOrAssignmentStatus(activePage);
        if (clickQuizStatus) {
          clickObs += formatQuizStatusObservation(ctx, newUrl, newTitle, clickQuizStatus, false);
        }

        return {
          success: true,
          data: { url: newUrl, title: newTitle, quizStatus: clickQuizStatus || undefined },
          observationText: clickObs,
          urlAfter: newUrl
        };
      }

      case 'browser.fill': {
        const page = await ensureBrowserPage(ctx);
        const selector = String(args.selector || '').trim();
        const value = String(args.value ?? '');
        const submitAfter = Boolean(args.submitAfter);

        if (!selector) {
          return {
            success: false,
            error: 'Thiếu selector',
            observationText: 'Lỗi: browser.fill yêu cầu CSS selector của ô nhập liệu.'
          };
        }

        let targetEl = page.locator(selector).first();
        if ((await targetEl.count()) === 0) {
          const fallback = page.locator(`[name="${selector}"], [id="${selector}"], [placeholder*="${selector}"], [aria-label*="${selector}" i]`).first();
          if ((await fallback.count()) > 0) {
            targetEl = fallback;
          } else {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              const fLoc = frame.locator(`${selector}, [name="${selector}"], [id="${selector}"]`).first();
              if ((await fLoc.count().catch(() => 0)) > 0) {
                targetEl = fLoc;
                break;
              }
            }
          }
        }

        if ((await targetEl.count().catch(() => 0)) === 0) {
          return {
            success: false,
            error: `Không tìm thấy phần tử "${selector}"`,
            observationText: `Lỗi: Không tìm thấy ô nhập liệu với selector "${selector}".`
          };
        }

        const elMeta = await targetEl.evaluate((node: Element) => {
          const tag = node.tagName.toLowerCase();
          const type = (node.getAttribute('type') || '').toLowerCase();
          const opts = tag === 'select'
            ? Array.from((node as HTMLSelectElement).options).map(o => ({ value: o.value, label: o.textContent || '' }))
            : undefined;
          return { tag, type, opts };
        }).catch(() => ({ tag: 'input', type: 'text', opts: undefined }));

        if (elMeta.tag === 'select') {
          const valNorm = stripVietnameseAccents(value);
          const matchedOpt = elMeta.opts?.find(
            o => o.value === value || stripVietnameseAccents(o.label) === valNorm || stripVietnameseAccents(o.label).includes(valNorm)
          );
          if (matchedOpt) {
            await targetEl.selectOption(matchedOpt.value);
          } else {
            await targetEl.selectOption({ label: value }).catch(async () => targetEl.selectOption(value));
          }
        } else if (elMeta.tag === 'input' && (elMeta.type === 'checkbox' || elMeta.type === 'radio')) {
          const shouldUncheck = /^(false|no|0|off|uncheck)$/i.test(value.trim());
          if (shouldUncheck && elMeta.type === 'checkbox') {
            await targetEl.uncheck();
          } else {
            await targetEl.check();
          }
        } else if (elMeta.tag === 'input' && elMeta.type === 'file') {
          const safeFilePath = await validatePracticeAttachment(value);
          await targetEl.setInputFiles(safeFilePath);
          const count = await targetEl.evaluate(el => (el as HTMLInputElement).files?.length || 0);
          if (count !== 1) {
            throw new Error(`Không xác nhận được file "${safeFilePath}" trong ô upload.`);
          }
        } else if (elMeta.tag === 'iframe') {
          const iframeId = await targetEl.getAttribute('id').catch(() => null);
          const handle = await targetEl.elementHandle();
          const cFrame = await handle?.contentFrame().catch(() => null);
          if (!cFrame) {
            throw new Error(`Không truy cập được nội dung iframe "${selector}"`);
          }
          const body = cFrame.locator('body#tinymce, body[contenteditable="true"], body').first();
          await body.click().catch(() => {});
          await body.fill(value).catch(async () => {
            await body.evaluate((b, val) => { b.textContent = val; }, value);
          });
          await targetEl.evaluate((el, { txtVal, ifrId }) => {
            const pairedId = ifrId && ifrId.endsWith('_ifr') ? ifrId.slice(0, -4) : '';
            const wrap = el.closest('.tox-tinymce, .editor_tinymce, .feditor, [data-fieldtype="editor"]');
            const hiddenTa = (pairedId ? document.getElementById(pairedId) : null) || wrap?.querySelector('textarea');
            if (hiddenTa instanceof HTMLTextAreaElement) {
              hiddenTa.value = txtVal;
              hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
              hiddenTa.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, { txtVal: value, ifrId: iframeId });
        } else {
          await targetEl.fill(value);
          if (submitAfter) {
            await targetEl.press('Enter').catch(() => {});
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          }
        }

        await page.waitForTimeout(300);
        const isPassword = (/password|passwd|pwd/i.test(selector) || elMeta.type === 'password') && elMeta.type !== 'file';
        const displayVal = isPassword ? '[REDACTED_PASSWORD]' : value;

        return {
          success: true,
          data: { selector, isPassword },
          observationText: `Đã điền thành công "${displayVal}" vào "${selector}".`,
          urlAfter: page.url()
        };
      }

      case 'browser.type': {
        const page = await ensureBrowserPage(ctx);
        const selector = String(args.selector || '').trim();
        const textToType = String(args.text ?? args.value ?? '');
        const delayMs = Number(args.delayMs) || 50;

        if (!selector) {
          return {
            success: false,
            error: 'Thiếu selector',
            observationText: 'Lỗi: browser.type yêu cầu selector của ô nhập liệu.'
          };
        }

        const el = page.locator(selector).first();
        if ((await el.count()) === 0) {
          return {
            success: false,
            error: `Không tìm thấy phần tử "${selector}"`,
            observationText: `Lỗi: Không tìm thấy phần tử "${selector}" để gõ phím.`
          };
        }

        await el.focus();
        await el.pressSequentially(textToType, { delay: delayMs });
        const isPassword = /password|passwd|pwd/i.test(selector);
        const displayVal = isPassword ? '[REDACTED_PASSWORD]' : textToType;

        return {
          success: true,
          data: { selector, isPassword },
          observationText: `Đã gõ văn bản "${displayVal}" vào "${selector}".`,
          urlAfter: page.url()
        };
      }

      case 'browser.scroll': {
        const page = await ensureBrowserPage(ctx);
        const direction = String(args.direction || 'down').toLowerCase();
        const amount = Number(args.amount) || 500;

        await page.evaluate(({ dir, amt }) => {
          if (dir === 'down') window.scrollBy(0, amt);
          else if (dir === 'up') window.scrollBy(0, -amt);
          else if (dir === 'top') window.scrollTo(0, 0);
          else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        }, { dir: direction, amt: amount });

        return {
          success: true,
          observationText: `Đã cuộn trang theo chiều: ${direction}`
        };
      }

      case 'browser.readText': {
        const page = await ensureBrowserPage(ctx);
        const selector = args.selector as string | undefined;
        const maxLength = Number(args.maxLength) || 4000;

        let content = '';
        if (selector) {
          content = await page.locator(selector).first().innerText().catch(() => '');
        } else {
          content = await page.locator('main, #region-main, body').first().innerText().catch(() => '');
        }

        const sanitized = content.replace(/\s+/g, ' ').trim().slice(0, maxLength);
        return {
          success: true,
          data: { length: sanitized.length, text: sanitized },
          observationText: `Đã đọc ${sanitized.length} ký tự:\n${sanitized.slice(0, 500)}${sanitized.length > 500 ? '...' : ''}`
        };
      }

      case 'browser.readLinks': {
        const page = await ensureBrowserPage(ctx);
        const { selector, filterText, maxLinks = 50 } = args;

        const links = await page.evaluate(({ sel, filt, max }) => {
          const root = sel ? document.querySelector(sel) || document : document;
          const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
          const out: { text: string; href: string }[] = [];
          for (const a of anchors) {
            let t = (a.textContent || a.title || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (!t) {
              const img = a.querySelector('img');
              if (img && (img.src.includes('hust') || a.className.includes('identityprovider') || a.href.includes('oauth2'))) {
                t = 'Login with HUST Account (Đăng nhập với tài khoản HUST)';
              }
            }
            if (filt && !t.toLowerCase().includes(filt.toLowerCase()) && !a.href.toLowerCase().includes(filt.toLowerCase())) {
              continue;
            }
            if (t.length > 0 && !out.some(o => o.href === a.href)) {
              out.push({ text: t.slice(0, 100), href: a.href });
              if (out.length >= max) break;
            }
          }
          return out;
        }, { sel: selector, filt: filterText, max: maxLinks });

        return {
          success: true,
          data: { count: links.length, links },
          observationText: `Tìm thấy ${links.length} liên kết phù hợp:\n` + links.slice(0, 10).map(l => `- [${l.text}](${l.href})`).join('\n')
        };
      }

      case 'browser.findElement': {
        const page = await ensureBrowserPage(ctx);
        const { selector, text } = args;

        let found = false;
        let count = 0;
        if (selector) {
          count = await page.locator(selector).count();
          found = count > 0;
        } else if (text) {
          count = await page.getByText(text, { exact: false }).count();
          found = count > 0;
        }

        return {
          success: true,
          data: { found, count },
          observationText: found ? `Tìm thấy ${count} phần tử phù hợp với "${selector || text}".` : `Không tìm thấy phần tử nào với "${selector || text}".`
        };
      }

      case 'browser.waitFor': {
        const page = await ensureBrowserPage(ctx);
        const { selector, state = 'visible', timeMs } = args;

        if (typeof timeMs === 'number' && timeMs > 0) {
          await page.waitForTimeout(Math.min(10000, timeMs));
          return { success: true, observationText: `Đã chờ ${timeMs}ms.` };
        }

        if (selector) {
          await page.locator(selector).first().waitFor({ state: state as any, timeout: 10000 });
          return { success: true, observationText: `Phần tử "${selector}" đã đạt trạng thái "${state}".` };
        }

        return { success: false, error: 'Cần chỉ định selector hoặc timeMs', observationText: 'Lỗi: browser.waitFor yêu cầu selector hoặc timeMs.' };
      }

      case 'browser.extractStructuredData': {
        const page = await ensureBrowserPage(ctx);
        const type = String(args.type || 'all').toLowerCase();
        const currentUrl = page.url();

        const results: Record<string, any> = {};

        if (type === 'courses' || type === 'all') {
          const courses = await extractPageCourses(page);
          results['courses'] = courses;
          ctx.collectedFindings['courses'] = courses;
        }

        if (type === 'deadlines' || type === 'all') {
          const deadlines = await scanDeadlines(page);
          results['deadlines'] = deadlines;
          ctx.collectedFindings['deadlines'] = deadlines;
        }

        let activitiesSummaryBlock = '';
        const isCoursePage =
          currentUrl.includes('/course/view.php') ||
          currentUrl.includes('/courses/') ||
          /\/(?:sohoa\/phong-hoc|edu\/course|programming-contest|courseware|khoa-hoc|lop-hoc)\b/i.test(currentUrl);
        if (type === 'activities' || type === 'all' || (type === 'deadlines' && isCoursePage)) {
          const rawActivities = await inspectCourseActivities(page);
          const filterText = typeof args.filterText === 'string' ? args.filterText : undefined;
          const needsAutoDeepVerify =
            Boolean(ctx.context) &&
            isCoursePage &&
            rawActivities.some(
              a => (a.kind === 'quiz' || a.kind === 'assignment') && !a.completionConfirmed && !getCheckedActivity(ctx, a.url)?.completionConfirmed
            );
          if (args.deepVerify === true || needsAutoDeepVerify) {
            await deepVerifyCourseActivities(page, ctx, rawActivities, filterText, args.deepVerify === true ? 45 : 16);
          }
          const formatted = enrichAndFormatActivities(rawActivities, ctx, 40, false);
          results['activities'] = formatted.activities;
          ctx.collectedFindings['activities'] = formatted.activities;
          activitiesSummaryBlock = formatted.summaryBlock;
        }

        const courseCount = (results['courses'] || []).length;
        const deadlineCount = (results['deadlines'] || []).length;
        const activityCount = (results['activities'] || []).length;

        // General-purpose structural extraction (resources, tables, forms, headings) for non-Moodle or resource pages
        let genericInfo: {
          headings: string[];
          resources: { title: string; url: string }[];
          tables: string[][][];
          forms: { selector: string; tag: string; type?: string; label?: string }[];
        } | null = null;
        if (type === 'all' || (courseCount === 0 && deadlineCount === 0 && activityCount === 0)) {
          genericInfo = await page.evaluate(() => {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .map(h => (h.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 12);
            const resources: { title: string; url: string }[] = [];
            Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).forEach(a => {
              const href = a.href || '';
              if (/\/mod\/(?:resource|folder|page|url)\/|\.(?:pdf|docx?|pptx?|xlsx?|zip|rar)(?:[?#]|$)|drive\.google\.com/i.test(href)) {
                const title = (a.textContent || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
                if (title && !resources.some(r => r.url === href)) {
                  resources.push({ title, url: href });
                }
              }
            });
            const tables: string[][][] = [];
            Array.from(document.querySelectorAll('table')).slice(0, 3).forEach(tbl => {
              const rows: string[][] = [];
              Array.from(tbl.querySelectorAll('tr')).slice(0, 12).forEach(tr => {
                const cells = Array.from(tr.querySelectorAll('th, td')).map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80));
                if (cells.some(Boolean)) rows.push(cells);
              });
              if (rows.length > 0) tables.push(rows);
            });
            const forms: { selector: string; tag: string; type?: string; label?: string }[] = [];
            Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea')).slice(0, 15).forEach(el => {
              const id = el.getAttribute('id');
              const name = el.getAttribute('name');
              const sel = id ? `#${id}` : (name ? `[name="${name}"]` : el.tagName.toLowerCase());
              const label = id
                ? (document.querySelector(`label[for="${id}"]`)?.textContent || '').replace(/\s+/g, ' ').trim()
                : (el.getAttribute('aria-label') || el.getAttribute('placeholder') || name || '');
              forms.push({
                selector: sel,
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute('type') || undefined,
                label: label ? label.slice(0, 80) : undefined
              });
            });
            return { headings, resources: resources.slice(0, 20), tables, forms };
          }).catch(() => null);
          if (genericInfo) {
            if (genericInfo.resources.length > 0) {
              results['resources'] = genericInfo.resources;
              ctx.collectedFindings['resources'] = genericInfo.resources;
            }
            if (genericInfo.tables.length > 0) results['tables'] = genericInfo.tables;
            if (genericInfo.forms.length > 0) results['forms'] = genericInfo.forms;
          }
        }

        let msg = `Đã trích xuất cấu trúc dữ liệu từ ${currentUrl}:\n`;
        if (courseCount > 0) {
          const matchedCourse = findBestMatchingCourse(results['courses'], ctx.config.targetCourse);

          if (matchedCourse) {
            msg += `★ [MÔN HỌC MỤC TIÊU PHÙ HỢP]: "${matchedCourse.name}" -> URL: ${matchedCourse.url}\n`;
          }
          msg += `- Danh sách khóa học (${courseCount}): ` + results['courses'].slice(0, 15).map((c: any) => `"${c.name}" (${c.url})`).join(', ') + '\n';
        }
        if (deadlineCount > 0) {
          msg += formatDeadlinesObservation(results['deadlines']);
        } else if (type === 'deadlines' || type === 'all') {
          const nowLocal = new Intl.DateTimeFormat('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            dateStyle: 'full',
            timeStyle: 'short'
          }).format(new Date());
          msg += `- 🕒 Thời gian thực hiện tại (GMT+7): ${nowLocal} — Không thấy hạn nộp nào có ngày/giờ cụ thể trên trang này.\n`;
        }
        if (activitiesSummaryBlock) {
          msg += activitiesSummaryBlock;
        }
        if (genericInfo) {
          if (genericInfo.resources.length > 0) {
            msg += `- Tài liệu / liên kết học tập (${genericInfo.resources.length}): ` + genericInfo.resources.slice(0, 6).map(r => `"${r.title}" (${r.url})`).join(', ') + '\n';
          }
          if (courseCount === 0 && activityCount === 0) {
            if (genericInfo.headings.length > 0) msg += `- Tiêu đề trên trang: ${genericInfo.headings.slice(0, 6).join(' | ')}\n`;
            if (genericInfo.tables.length > 0) {
              msg += `- Dữ liệu bảng (${genericInfo.tables.length} bảng): ${genericInfo.tables[0].slice(0, 4).map(r => r.join(' | ')).join(' ; ')}\n`;
            }
            if (genericInfo.forms.length > 0) {
              msg += `- Trường biểu mẫu (${genericInfo.forms.length}): ${genericInfo.forms.slice(0, 6).map(f => `${f.label || f.selector} (${f.selector})`).join(', ')}\n`;
            }
          }
        }

        return {
          success: true,
          data: results,
          observationText: msg.trim(),
          urlAfter: currentUrl
        };
      }

      case 'browser.captureScreenshot': {
        const page = await ensureBrowserPage(ctx);
        const name = String(args.name || `agent-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = resolve('artifacts', 'agent-screenshots');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const filePath = join(dir, `${name}.png`);
        await page.screenshot({ path: filePath, fullPage: args.fullPage === true });

        return {
          success: true,
          data: { path: filePath },
          observationText: `Đã chụp ảnh màn hình lưu tại: ${filePath}`
        };
      }

      case 'browser.download': {
        const page = await ensureBrowserPage(ctx);
        const rawUrl = String(args.url || '').trim();
        if (!rawUrl) {
          return {
            success: false,
            error: 'Thiếu tham số url để tải xuống.',
            observationText: '[LỖI TẢI FILE] Thiếu tham số url để tải xuống.'
          };
        }
        let resolvedUrl = rawUrl;
        try {
          resolvedUrl = new URL(rawUrl, page.url() || ctx.activeUrl).href;
        } catch {
          return {
            success: false,
            error: `URL không hợp lệ: ${rawUrl}`,
            observationText: `[LỖI TẢI FILE] URL không hợp lệ: ${rawUrl}`
          };
        }
        if (!isUrlAllowed(resolvedUrl, ctx.config.allowedHosts)) {
          return {
            success: false,
            error: `URL "${resolvedUrl}" không nằm trong phạm vi host được phép truy cập.`,
            observationText: `[BỊ CHẶN TẢI FILE] URL "${resolvedUrl}" nằm ngoài danh sách host cho phép.`
          };
        }

        const resp = await page.context().request.get(resolvedUrl, { timeout: 25000 }).catch(() => null);
        if (!resp || !resp.ok()) {
          const msg = `Không tải được tài liệu từ ${resolvedUrl}${resp ? ` (HTTP ${resp.status()})` : ''}.`;
          return {
            success: false,
            error: msg,
            observationText: `[LỖI TẢI FILE] ${msg}`
          };
        }

        const headers = resp.headers();
        const cType = String(headers['content-type'] || '').toLowerCase();
        const disp = String(headers['content-disposition'] || '');
        const dispMatch = disp.match(/filename\*?=(?:UTF-8''|")?([^";\r\n"]+)/i);
        const urlName = (() => {
          try {
            return decodeURIComponent(basename(new URL(resolvedUrl).pathname));
          } catch {
            return '';
          }
        })();
        let rawName = String(args.filename || dispMatch?.[1] || urlName || `download-${Date.now()}`).trim();
        rawName = rawName.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || `download-${Date.now()}`;
        if (!extname(rawName)) {
          if (cType.includes('pdf')) rawName += '.pdf';
          else if (cType.includes('wordprocessingml')) rawName += '.docx';
          else if (cType.includes('text/plain')) rawName += '.txt';
          else if (cType.includes('markdown')) rawName += '.md';
          else if (cType.includes('csv')) rawName += '.csv';
        }

        const buf = await resp.body();
        if (!buf || buf.length > 25 * 1024 * 1024) {
          return {
            success: false,
            error: 'File tải về rỗng hoặc vượt quá giới hạn 25MB.',
            observationText: '[LỖI TẢI FILE] File tải về rỗng hoặc vượt quá giới hạn 25MB.'
          };
        }

        const dir = resolve('artifacts', 'downloads');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const filePath = join(dir, rawName);
        await writeFile(filePath, buf);

        let extractedText: string | undefined;
        const ext = extname(filePath).toLowerCase();
        if (args.extractText !== false && ['.pdf', '.docx', '.txt', '.md', '.csv'].includes(ext)) {
          extractedText = (await extractLocalDocumentText(filePath, 4000)) || undefined;
        }
        if (!Array.isArray(ctx.collectedFindings['downloadedFiles'])) {
          ctx.collectedFindings['downloadedFiles'] = [];
        }
        (ctx.collectedFindings['downloadedFiles'] as any[]).push({
          url: resolvedUrl,
          path: filePath,
          sizeBytes: buf.length,
          ...(extractedText ? { preview: extractedText.slice(0, 800) } : {})
        });

        return {
          success: true,
          data: {
            url: resolvedUrl,
            path: filePath,
            sizeBytes: buf.length,
            ...(extractedText ? { extractedText } : {})
          },
          observationText: extractedText
            ? `[ĐÃ TẢI & ĐỌC TÀI LIỆU] Lưu tại ${filePath} (${buf.length} bytes). Trích đoạn:\n${extractedText.slice(0, 1500)}`
            : `[ĐÃ TẢI TÀI LIỆU] Đã lưu ${rawName} (${buf.length} bytes) tại ${filePath}.`
        };
      }

      case 'agent.summarize': {
        const instruction = String(args.instruction || 'Tổng hợp dữ liệu').trim();
        const dataKey = args.dataKey as string | undefined;

        const dataToSummarize = dataKey ? ctx.collectedFindings[dataKey] : ctx.collectedFindings;
        const nowLocal = new Intl.DateTimeFormat('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          dateStyle: 'full',
          timeStyle: 'short'
        }).format(new Date());
        const systemPrompt = `Bạn là trợ lý học tập AI AutoTask. Nhiệm vụ của bạn là tổng hợp các dữ liệu tìm thấy từ hệ thống LMS thành bảng tổng kết rõ ràng, chi tiết, chuyên nghiệp bằng tiếng Việt Markdown. Trích dẫn rõ URL nguồn nếu có. Luôn đối chiếu mọi hạn nộp với thời gian thực hiện tại.`;
        const userPrompt = `Thời gian thực hiện tại (GMT+7): ${nowLocal} (${new Date().toISOString()})\nYêu cầu: ${instruction}\n\nDữ liệu quan sát được:\n${JSON.stringify(dataToSummarize, null, 2)}`;

        const sumStarted = Date.now();
        const rrSeq = Number(ctx.collectedFindings['solverRoundRobinSeq'] || 0);
        ctx.collectedFindings['solverRoundRobinSeq'] = rrSeq + 1;
        const aiRes = await ModelRouter.execute({
          system: systemPrompt,
          text: userPrompt,
          maxTokens: 4096,
          temperature: 0.2
        }, {
          profileOverride: ctx.config.profileOverride,
          modelOverride: ctx.config.modelOverride,
          taskRole: 'summarizer',
          taskTier: 'light',
          roundRobinIndex: rrSeq,
          previousKeySlot: getLastActiveKeySlot(ctx),
          maxAttemptsPerModel: 1,
          onModelSwitch: (from, to, reason) => {
            ctx.runLogger?.recordModelEvent({ phase: 'summarize', event: 'switch', from, to, reason });
          },
          onKeyRotate: async (ev) => {
            await handleAgentKeyRotation(ctx, ev);
          },
          onRateLimitWait: (info) => {
            ctx.runLogger?.recordModelEvent({ phase: 'summarize', event: 'rpm_wait', reason: info.reason });
          }
        });
        recordLastActiveKeySlot(ctx, aiRes);
        ctx.runLogger?.recordModelEvent({
          phase: 'summarize',
          event: 'response',
          model: aiRes.modelUsed,
          profileId: aiRes.finalProfile,
          latencyMs: Date.now() - sumStarted
        });

        return {
          success: true,
          data: { summary: aiRes.output },
          observationText: `[TỔNG HỢP AI]\n${aiRes.output}`
        };
      }

      case 'agent.reportResult': {
        let effectiveStatus = (args.status as any) || 'DONE';
        let summary = String(args.summary || '').trim();
        const savedLogPath = ctx.runLogger?.shouldPersist(ctx.activeUrl) ? ctx.runLogger.mdPath : undefined;

        // Evidence-based completion verification & truthful reporting for SOLVE_QUIZ runs
        if (ctx.config.userIntent === 'SOLVE_QUIZ') {
          const turnStartIdx = ctx.currentTurnStartIndex ?? 0;
          const allSolvedQuizzes = (ctx.collectedFindings['solvedQuizzes'] as any[]) || [];
          const turnSolvedQuizzes = allSolvedQuizzes.filter(
            q => typeof q.solvedAtStep !== 'number' || q.solvedAtStep >= turnStartIdx
          );
          const turnCheckedCourse = Boolean(ctx.collectedFindings['turnCheckedCourse']) || ctx.goalHistory.length === 0;
          const statusMap = (ctx.collectedFindings['activityStatusMap'] as Record<string, CheckedActivityRecord>) || {};
          const checkedEntries = Object.values(statusMap);
          const preCompleted = checkedEntries.filter(e => e.state === 'COMPLETED');
          const expiredOrClosed = checkedEntries.filter(e => e.state === 'CLOSED');
          const solvedTitlesNorm = allSolvedQuizzes.map(q => String(q?.title || '').toLowerCase());
          const unmatchedOpen = ((ctx.collectedFindings['unmatchedOpenQuizzes'] as string[]) || []).filter(item => {
            const cleaned = item.replace(/^"+|"+$/g, '').trim().toLowerCase();
            if (!cleaned) return false;
            return !solvedTitlesNorm.some(st => st.includes(cleaned));
          });

          const defaultTargetGrade =
            typeof ctx.collectedFindings['targetMinGrade'] === 'number'
              ? (ctx.collectedFindings['targetMinGrade'] as number)
              : ctx.config.activityFilter?.maxGradeToReattempt;
          const unsubmittedFailures = turnSolvedQuizzes.filter(
            qz =>
              !qz.submitted &&
              (Boolean(ctx.collectedFindings['lastSubmitFailed']) ||
                (Array.isArray(qz.warnings) && qz.warnings.some((w: string) => /In progress|Chưa hoàn tất nộp bài|tạm dừng trước khi nộp/i.test(w))))
          );
          const belowTargetQuizzes = turnSolvedQuizzes.filter(qz => {
            const minForQuiz = typeof qz.targetMinGrade === 'number' ? qz.targetMinGrade : defaultTargetGrade;
            if (typeof minForQuiz !== 'number') return false;
            const rawObs = String(qz.scoreObserved || '');
            if (!/(?:grade|điểm|out\s*of|\/)/i.test(rawObs) || /CHƯA NỘP/i.test(rawObs)) return false;
            const m = rawObs.match(/([0-9]+(?:[.,][0-9]+)?)/);
            if (!m) return false;
            const val = parseFloat(m[1].replace(',', '.'));
            return Number.isFinite(val) && val < minForQuiz;
          });
          const hasAnyTargetGrade =
            typeof defaultTargetGrade === 'number' ||
            turnSolvedQuizzes.some(qz => typeof qz.targetMinGrade === 'number');
          const missingNumericScore = hasAnyTargetGrade && turnSolvedQuizzes.length > 0 &&
            turnSolvedQuizzes.every(qz => {
              const rawObs = String(qz.scoreObserved || '');
              return !/(?:grade|điểm|out\s*of|[0-9]+(?:\.[0-9]+)?\s*\/)/i.test(rawObs);
            });

          if (effectiveStatus === 'DONE' && (unsubmittedFailures.length > 0 || ctx.collectedFindings['lastSubmitFailed'] === true || belowTargetQuizzes.length > 0)) {
            effectiveStatus = 'NEEDS_REVIEW';
          }
          if (missingNumericScore && /(?:đạt|score|điểm)[^\n]*?(?:>=|>|ít\s*nhất)\s*\d+/i.test(summary)) {
            summary = summary.replace(
              /(?:Điểm số đạt được:\s*)?[^\n]*?(?:Đạt|đạt)\s*(?:>=|>|ít\s*nhất)\s*\d+(?:[.,]\d+)?\s*(?:điểm)?[^\n]*/g,
              'Điểm số: Đã nộp bài nhưng LMS chưa hiển thị con số điểm cụ thể trên trang kết quả (không suy đoán điểm).'
            );
          }

          if (turnSolvedQuizzes.length === 0 && turnCheckedCourse && (preCompleted.length > 0 || expiredOrClosed.length > 0 || unmatchedOpen.length > 0)) {
            let auditBlock = `\n\n─── ĐỐI CHIẾU THỰC TẾ HỆ THỐNG (VERIFIED QUIZ STATUS) ───\n`;
            auditBlock += `• Số bài mới được Agent giải & nộp trong phiên này: 0 bài\n`;
            if (unmatchedOpen.length > 0) {
              auditBlock += `• Bài CHƯA LÀM / CÒN MỞ khác chưa đụng tới (do bộ lọc mục tiêu) (${unmatchedOpen.length}): ${unmatchedOpen.join(', ')}\n`;
            }
            if (preCompleted.length > 0) {
              auditBlock += `• Bài ĐÃ LÀM XONG từ trước (${preCompleted.length}): ${preCompleted.map(e => `"${e.title || e.url}"${e.grade ? ` (Điểm: ${e.grade})` : ''}`).join(', ')}\n`;
            }
            if (expiredOrClosed.length > 0) {
              auditBlock += `• Bài ĐÃ HẾT HẠN NỘP / ĐÃ ĐÓNG không thể làm (${expiredOrClosed.length}): ${expiredOrClosed.map(e => `"${e.title || e.url}"`).join(', ')}\n`;
            }
            if (!summary.includes('ĐỐI CHIẾU THỰC TẾ HỆ THỐNG')) {
              summary = `${summary}${auditBlock}`;
            }
          } else if (turnSolvedQuizzes.length > 0 && !summary.includes('ĐỐI CHIẾU THỰC TẾ HỆ THỐNG')) {
            let auditBlock = `\n\n─── ĐỐI CHIẾU THỰC TẾ HỆ THỐNG (VERIFIED QUIZ STATUS) ───\n`;
            auditBlock += `• Số bài đã làm/làm lại trong lượt này: ${turnSolvedQuizzes.length} bài\n`;
            if (unsubmittedFailures.length > 0) {
              auditBlock += `• ⚠ CẢNH BÁO CHƯA NỘP HOÀN TẤT (In progress): ${unsubmittedFailures.map(q => `"${q.title}"`).join(', ')}\n`;
            }
            if (belowTargetQuizzes.length > 0) {
              const displayMin = defaultTargetGrade ?? belowTargetQuizzes[0]?.targetMinGrade ?? '?';
              auditBlock += `• ⚠ CHƯA ĐẠT NGƯỠNG ĐIỂM (>= ${displayMin}): ${belowTargetQuizzes.map(q => `"${q.title}" (${q.scoreObserved})`).join(', ')}\n`;
            }
            for (const qz of turnSolvedQuizzes) {
              const aiInfo = typeof qz.aiSolvedCount === 'number'
                ? `AI chuẩn ${qz.aiSolvedCount}/${qz.questionsFound}, dự phòng ${qz.fallbackCount ?? 0}`
                : `${qz.questionsFilled}/${qz.questionsFound} câu`;
              const modelNote = qz.modelUsed ? ` | Model: ${qz.modelUsed}` : '';
              const wordTag = qz.usedWordApp ? ` (Microsoft Word${typeof qz.wordCount === 'number' ? `, ${qz.wordCount} từ` : ''})` : '';
              const fileNote = qz.uploadedFile ? ` | File: ${qz.uploadedFile}${wordTag}` : '';
              const reattemptNote = qz.isReattempt ? ' [Re-attempt]' : '';
              auditBlock += `• "${qz.title}"${reattemptNote}: ${aiInfo} | Nộp: ${qz.submitted ? 'Đã nộp' : 'Chưa nộp'} | Kết quả: ${qz.scoreObserved || '-'}${fileNote}${modelNote}\n`;
              if (Array.isArray(qz.warnings) && qz.warnings.length > 0) {
                auditBlock += `  ⚠ Cảnh báo: ${qz.warnings.slice(0, 4).join('; ')}\n`;
              }
            }
            if (unmatchedOpen.length > 0) {
              auditBlock += `• Bài CHƯA LÀM / CÒN MỞ khác (ngoài mục tiêu đã chọn) (${unmatchedOpen.length}): ${unmatchedOpen.join(', ')}\n`;
            }
            if (turnCheckedCourse && preCompleted.length > 0 && preCompleted.length <= 6) {
              auditBlock += `• Đã bỏ qua (làm từ trước): ${preCompleted.map(e => `"${e.title || e.url}"`).join(', ')}\n`;
            }
            if (turnCheckedCourse && expiredOrClosed.length > 0 && expiredOrClosed.length <= 6) {
              auditBlock += `• Đã bỏ qua (hết hạn/đóng): ${expiredOrClosed.map(e => `"${e.title || e.url}"`).join(', ')}\n`;
            }
            summary = `${summary}${auditBlock}`;
          }
        }

        if (savedLogPath && !summary.includes(savedLogPath)) {
          summary = `${summary}\n\n📄 Log chi tiết phiên chạy (lập luận AI + từng câu hỏi): ${savedLogPath}`;
        }

        return {
          success: true,
          data: { status: effectiveStatus, summary },
          observationText: `[BÁO CÁO KẾT QUẢ - ${effectiveStatus}]\n${summary}`
        };
      }

      case 'account.saveCredentials': {
        const { accountId, username, password, loginUrl, isDefault = true } = args;
        if (!accountId || !username || !password) {
          return {
            success: false,
            error: 'Thiếu thông tin tài khoản (accountId, username, password)',
            observationText: 'Lỗi: Cần cung cấp đầy đủ accountId, username và password.'
          };
        }

        await saveAccount(
          String(accountId).trim(),
          { loginUrl: loginUrl ? String(loginUrl).trim() : 'https://lms.hust.edu.vn', isDefault: Boolean(isDefault) },
          String(username).trim(),
          String(password)
        );

        ctx.activeAccountId = String(accountId).trim();

        return {
          success: true,
          data: { accountId, loginUrl },
          observationText: `[ĐÃ LƯU TÀI KHOẢN] Đã lưu thông tin tài khoản "${accountId}" vào Windows Credential Manager mã hóa an toàn. Mật khẩu không bao giờ được ghi ra plaintext file.`
        };
      }

      case 'account.login': {
        const page = await ensureBrowserPage(ctx);
        const accounts = await listAccounts();
        const accountId = String(args.accountId || ctx.activeAccountId || ctx.config.accountId || (await getDefaultAccountId()) || '').trim();

        let loginUrl = ctx.config.targetWebUrl || '';
        const trusted: string[] = [...ctx.config.allowedHosts, 'id.hust.edu.vn', 'lms.hust.edu.vn', 'localhost', '127.0.0.1'];
        let creds: { username: string; password: string } | undefined = undefined;

        if (accountId === 'in_memory' || (ctx.config.inMemoryCredentials && (!accountId || !accounts[accountId]))) {
          creds = ctx.config.inMemoryCredentials;
          if (!loginUrl) loginUrl = 'https://lms.hust.edu.vn';
        } else if (accounts[accountId]) {
          const acc = accounts[accountId];
          if (!loginUrl) loginUrl = acc.loginUrl;
          trusted.push(acc.loginHost, ...(acc.trustedLoginHosts || []));
        } else if (ctx.config.inMemoryCredentials) {
          creds = ctx.config.inMemoryCredentials;
          if (!loginUrl) loginUrl = 'https://lms.hust.edu.vn';
        } else {
          const available = Object.keys(accounts);
          return {
            success: false,
            error: `Tài khoản "${accountId}" không tồn tại.`,
            observationText: `Lỗi: Không tìm thấy tài khoản "${accountId}". Các tài khoản đã lưu: ${available.join(', ') || 'Chưa có'}. Hãy dùng menu khởi động hoặc lệnh "account add" để thêm tài khoản.`
          };
        }

        // Add loginUrl host to allowed hosts and trusted hosts
        if (loginUrl) {
          const h = registerAllowedUrlHost(ctx.config.allowedHosts, loginUrl);
          if (h && !trusted.includes(h)) trusted.push(h);
        }

        // Crucial fix: If browser is at about:blank or not currently on a trusted host, navigate to loginUrl first!
        const currentUrl = page.url();
        let currentHost = '';
        try {
          currentHost = new URL(currentUrl).hostname.toLowerCase();
        } catch {}

        if (!currentHost || currentUrl === 'about:blank' || !trusted.some(h => currentHost === h || currentHost.endsWith('.' + h))) {
          if (loginUrl) {
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            ctx.activeUrl = page.url();
          }
        }

        const loginRes = await attemptAutoLogin(page, accountId || 'in_memory', trusted, creds);
        const isVerified = loginRes.success && (await verifyIsLoggedIn(page));

        if (isVerified) {
          ctx.isLoggedIn = true;
          ctx.activeAccountId = accountId || 'in_memory';
          ctx.activeUrl = page.url();
          const title = await page.title().catch(() => '');
          return {
            success: true,
            data: { accountId: ctx.activeAccountId, url: ctx.activeUrl, title },
            observationText: `[ĐÃ TỰ ĐỘNG ĐĂNG NHẬP] Đã đăng nhập và xác thực phiên thành công với tài khoản "${ctx.activeAccountId}". Trang hiện tại: "${title}" (${ctx.activeUrl}).`
          };
        }

        ctx.isLoggedIn = false;
        if (loginRes.status === 'MFA_REQUIRED') {
          return {
            success: false,
            data: { mfaRequired: true },
            error: 'MFA_REQUIRED',
            observationText: `[XÁC THỰC MFA] Hệ thống yêu cầu mã xác thực 2 bước (MFA/OTP). Vui lòng xác thực trên thiết bị của bạn.`
          };
        }

        return {
          success: false,
          error: loginRes.message || 'Chưa hoàn tất phiên xác thực trên LMS',
          observationText: `[ĐĂNG NHẬP CHƯA HOÀN TẤT] ${loginRes.message || 'Trình duyệt chưa hoàn tất đăng nhập vào hệ thống.'} URL hiện tại: ${page.url()}`
        };
      }

      case 'quiz.solve': {
        const page = await ensureBrowserPage(ctx);
        const autoSubmit = args.autoSubmit !== false;
        const maxPages = Number(args.maxPages) || 15;
        const notes = args.notes as string | undefined;
        const allowReattempt = typeof args.allowReattempt === 'boolean'
          ? args.allowReattempt
          : Boolean(ctx.config.allowReattempt);

        const rawArgTarget = typeof args.targetActivity === 'string' ? args.targetActivity.trim() : undefined;
        const argClearsTarget = rawArgTarget && /^(?:all|\*|tất cả|tat ca)$/i.test(rawArgTarget);
        const hasExplicitScopeArgs = Boolean(
          args.solveAll === true ||
          args.afterActivity !== undefined ||
          args.activityRange ||
          argClearsTarget
        );

        const targetActivity = argClearsTarget
          ? undefined
          : (rawArgTarget !== undefined
              ? rawArgTarget
              : (hasExplicitScopeArgs ? undefined : ctx.config.targetActivity));

        const solveAll = typeof args.solveAll === 'boolean'
          ? args.solveAll
          : (hasExplicitScopeArgs ? Boolean(args.solveAll || args.afterActivity || args.activityRange) : ctx.config.solveAll);

        if (typeof args.maxGradeToReattempt === 'number' && Number.isFinite(args.maxGradeToReattempt)) {
          ctx.collectedFindings['targetMinGrade'] = args.maxGradeToReattempt;
        }

        return await executeQuizSolve(page, ctx, {
          autoSubmit,
          maxPages,
          notes,
          allowReattempt,
          targetActivity,
          solveAll,
          maxQuizzes: typeof args.maxQuizzes === 'number' ? args.maxQuizzes : undefined,
          afterActivity: args.afterActivity,
          activityRange: typeof args.activityRange === 'string' ? args.activityRange : undefined,
          excludeActivities: Array.isArray(args.excludeActivities) ? args.excludeActivities.map(String) : undefined,
          maxGradeToReattempt: typeof args.maxGradeToReattempt === 'number' ? args.maxGradeToReattempt : undefined,
          filePath: typeof args.filePath === 'string' && args.filePath.trim() ? args.filePath.trim() : ctx.config.attachmentPath,
          documentFormat: (typeof args.documentFormat === 'string' ? args.documentFormat : ctx.config.documentFormat) as (FileKind | 'png') | undefined,
          essayText: typeof args.essayText === 'string' ? args.essayText : undefined,
          solveAssignments: typeof args.solveAssignments === 'boolean' ? args.solveAssignments : ctx.config.solveAssignments,
          useWordApp: typeof args.useWordApp === 'boolean' ? args.useWordApp : ctx.config.useWordApp,
          wordSavePath: typeof args.wordSavePath === 'string' && args.wordSavePath.trim() ? args.wordSavePath.trim() : ctx.config.wordSavePath,
          wordTemplatePath: typeof args.wordTemplatePath === 'string' && args.wordTemplatePath.trim() ? args.wordTemplatePath.trim() : ctx.config.wordTemplatePath,
          studentHeader: typeof args.studentHeader === 'string' && args.studentHeader.trim() ? args.studentHeader.trim() : ctx.config.studentHeader,
          handwritingMode: typeof args.handwritingMode === 'boolean' ? args.handwritingMode : ctx.config.handwritingMode,
          handwritingSamplePath: typeof args.handwritingSamplePath === 'string' && args.handwritingSamplePath.trim() ? args.handwritingSamplePath.trim() : ctx.config.handwritingSamplePath,
          parallel: typeof args.parallel === 'boolean' ? args.parallel : ctx.config.parallel,
          concurrency: typeof args.concurrency === 'number' ? args.concurrency : ctx.config.concurrency,
          targetCourses: Array.isArray(args.targetCourses) ? args.targetCourses.map(String) : ctx.config.targetCourses,
          activityFilter: hasExplicitScopeArgs ? undefined : ctx.config.activityFilter
        });
      }

      case 'browser.back': {
        const page = await ensureBrowserPage(ctx);
        const timeoutMs = Number(args.timeoutMs) || 15000;
        await page.goBack({ timeout: timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {});
        const newUrl = page.url();
        ctx.activeUrl = newUrl;
        const newTitle = await page.title().catch(() => '');

        return {
          success: true,
          data: { url: newUrl, title: newTitle },
          observationText: `Đã quay lại trang trước (Back): "${newTitle}" (${newUrl})`,
          urlAfter: newUrl
        };
      }

      default:
        return {
          success: false,
          error: `Công cụ không xác định: ${tool}`,
          observationText: `Lỗi: Không tìm thấy công cụ "${tool}". Hãy dùng các công cụ hợp lệ trong danh mục.`
        };
    }
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      observationText: `Lỗi khi thực thi công cụ ${tool}: ${err.message}`
    };
  }
}
