/** Autonomous Agent Execution Loop: ReAct Planning, Tool Dispatch & Verification */
import type {
  ActivityFilterSpec,
  AgentConfig,
  AgentContext,
  AgentExecutionResult,
  AgentGoalStatus,
  AgentStep
} from './types.js';
import { executeAgentTool, ensureBrowserPage } from './tools.js';
import { planNextStep, type PlannerDecision } from './planner.js';
import { formatRateLimitWaitNotice } from '../model-center/model-router.js';
import {
  extractCourseCode,
  findMatchingPlaybooks,
  learnPlaybookFromRun,
  registerAllowedUrlHost
} from './playbooks.js';
import { paint, badge } from '../ui/tokyo.js';
import { redactSecrets } from '../security/redact.js';
import { getDefaultAccountId, listAccounts } from '../accounts.js';
import { AgentRunLogger } from './run-logger.js';
import { CATALOG_ALLOWED_HOSTS, resolveKnownPlatformFromPrompt } from './lms-catalog.js';

export const DEFAULT_ALLOWED_HOSTS = Array.from(new Set([
  'lms.hust.edu.vn',
  'id.hust.edu.vn',
  'sso.hust.edu.vn',
  'fami.hust.edu.vn',
  'sohoa.hust.edu.vn',
  'login.microsoftonline.com',
  'login.live.com',
  'accounts.google.com',
  'localhost',
  '127.0.0.1',
  ...CATALOG_ALLOWED_HOSTS
]));

function extractNumbersFromClause(clause: string): number[] {
  const nums: number[] = [];
  for (const m of clause.matchAll(/\b0*(\d{1,3})\b/g)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
  }
  return nums;
}

/** Parses single-target vs multi-target / relative scope constraints ("sau bài 09", "từ 10 đến 14", "trừ bài 11", "dưới 8 điểm") cleanly. */
function parseActivityScopeFromPrompt(prompt: string): {
  targetActivity?: string;
  solveAll?: boolean;
  activityFilter?: ActivityFilterSpec;
} {
  const filter: ActivityFilterSpec = {};
  let hasFilter = false;
  let solveAll: boolean | undefined;

  // 1. Optional grade condition for conditional re-attempt (e.g. "nếu dưới 8 điểm", "< 7.5")
  const gradeMatch = prompt.match(/(?:điểm|diem|score|kết\s*quả)?\s*(?:dưới|duoi|thấp\s*hơn|bé\s*hơn|nhỏ\s*hơn|chưa\s*(?:đạt|được)|<|<=)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  if (gradeMatch) {
    const g = parseFloat(gradeMatch[1].replace(',', '.'));
    if (Number.isFinite(g) && g > 0 && g <= 100) {
      filter.maxGradeToReattempt = g;
      hasFilter = true;
    }
  }

  // 2. Exclusions ("trừ bài 9", "ngoại trừ 10, 11", "bỏ qua bài 01") — avoid ASCII \b after accented UTF-8 like "ừ"
  const excludeMatch = prompt.match(/(?:^|[\s,;])(?:ngoại\s*trừ|ngoai\s*tru|trừ|tru|bỏ\s*qua|bo\s*qua)\s+(?:các\s+|những\s+)?(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)?\s*((?:0*\d{1,3})(?:\s*(?:,|và|với|&|\/)\s*(?:bài\s*|quiz\s*|số\s*)?0*\d{1,3})*)/i);
  if (excludeMatch) {
    const nums = extractNumbersFromClause(excludeMatch[1]);
    if (nums.length > 0) {
      filter.excludeNumbers = nums;
      hasFilter = true;
    }
  }

  // 3. Relative anchor "sau bài X" / "phía sau tuần 12 online 6 trắc nghiệm 9" -> do NOT lock targetActivity="9"
  const afterMatch = prompt.match(
    /(?:phía\s*sau|bên\s*dưới|tiếp\s*theo\s*sau|kể\s*từ\s*sau|\bsau\b|\bafter\b)\s+(?:(?:các\s+)?(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|tuần\s*\d+|online\s*\d+|mục|phần|số)\s+){0,6}?(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)?\s*0*(\d{1,3})\b/i
  );
  if (afterMatch) {
    const n = parseInt(afterMatch[1], 10);
    if (Number.isFinite(n)) {
      filter.afterNumber = n;
      hasFilter = true;
      solveAll = true;
    }
  }

  // 4. Explicit ranges: "từ bài 10 đến bài 14", "từ bài 10 trở đi", "bài 10-14"
  const rangeMatch =
    prompt.match(/(?:từ|tu)\s+(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)?\s*0*(\d{1,3})\s*(?:đến|tới|den|toi|->|-|~)\s*(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)?\s*0*(\d{1,3})\b/i) ||
    prompt.match(/\b(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)\s*0*(\d{1,3})\s*(?:-|–|~|->)\s*0*(\d{1,3})\b/i);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1], 10);
    const b = parseInt(rangeMatch[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a && !(a === 5 && b === 10 && /5\/10/.test(prompt))) {
      filter.fromNumber = a;
      filter.toNumber = b;
      hasFilter = true;
      solveAll = true;
    }
  } else {
    const fromOnwardMatch = prompt.match(/(?:từ|tu)\s+(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test|số)?\s*0*(\d{1,3})\s*(?:trở\s*đi|tro\s*di|trở\s*lên|tro\s*len|về\s*sau|ve\s*sau)/i);
    if (fromOnwardMatch) {
      const a = parseInt(fromOnwardMatch[1], 10);
      if (Number.isFinite(a)) {
        filter.fromNumber = a;
        hasFilter = true;
        solveAll = true;
      }
    }
  }

  // 5. Comma / "và" list of multiple activities: "bài 10, 11, 12" or "quiz 10 và 11"
  const scrubbedForList = excludeMatch ? prompt.replace(excludeMatch[0], ' ') : prompt;
  const listMatch = scrubbedForList.match(
    /\b(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test)\s*(?:số\s*)?((?:0*\d{1,3})(?:\s*(?:,|và|với|&)\s*(?:bài\s*|quiz\s*|trắc\s*nghiệm\s*|số\s*)?0*\d{1,3})+)/i
  );
  if (listMatch) {
    const nums = extractNumbersFromClause(listMatch[1]);
    const filtered = filter.excludeNumbers ? nums.filter(n => !filter.excludeNumbers!.includes(n)) : nums;
    if (filtered.length >= 2) {
      filter.includeNumbers = filtered;
      hasFilter = true;
      solveAll = true;
    }
  }

  // 6. General multi-quiz / batch request ("làm hết", "làm tất cả", "tất cả các bài chưa làm", "làm lại hết")
  const batchCue = /(?:(?:làm|lam|giải|giai|nộp|nop|hoàn\s*thành|hoan\s*thanh|xử\s*lý|xu\s*ly|re-?attempt|làm\s*lại|lam\s*lai)\s+(?:(?:lại|lai)\s+)?(?:(?:hết|het|nốt|not|tất\s*cả|tat\s*ca|toàn\s*bộ|toan\s*bo|nhiều|nhieu)\b|(?:các|cac|những|nhung|mọi|moi)\s+(?:bài|bai|quiz|test|trắc\s*nghiệm|trac\s*nghiem|còn\s*lại))|(?:tất\s*cả|toàn\s*bộ|hết)\s+(?:các\s+|những\s+)?(?:bài|quiz|trắc\s*nghiệm)\s*(?:chưa\s*làm|còn\s*mở|còn\s*lại|còn\s*hạn)?|solve\s*all)/i;
  if (batchCue.test(prompt)) {
    solveAll = true;
  }

  // 7. Single-target fallback ONLY when no multi-item range/after/list filter hijacks it
  let targetActivity: string | undefined;
  const hasMultiRange = Boolean(filter.afterNumber !== undefined || filter.fromNumber !== undefined || (filter.includeNumbers && filter.includeNumbers.length > 1));
  if (!hasMultiRange) {
    // Strip excluded clause so "làm hết trừ bài 09" doesn't lock targetActivity="09"
    const promptForSingle = excludeMatch ? prompt.replace(excludeMatch[0], ' ') : prompt;
    const quotedActivityMatch = promptForSingle.match(/(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test)\s*(?:số\s*)?["“]([^"”]{2,90})["”]/i)
      || promptForSingle.match(/["“](0*\d{1,3}\s*[\.\-:][^"”]{2,80})["”]/i)
      || promptForSingle.match(/\b(0*\d{1,3}\s*\.\s*(?:trắc\s*nghiệm|quiz|bài\s*tập)\s*[:：]\s*[^\n,;?]{2,80})/i);
    if (quotedActivityMatch) {
      targetActivity = quotedActivityMatch[1].replace(/[:：\s]+$/, '').trim();
    } else if (!solveAll) {
      const numberedActivityMatch = promptForSingle.match(/\b(?:bài(?:\s*(?:tập|thi|trắc\s*nghiệm))?|trắc\s*nghiệm|quiz|test)\s*(?:số\s*)?(0*\d{1,3}(?:\s*[\.\-:]\s*[^\s,;\.!?\n"']+(?:\s+[^\s,;\.!?\n"']+){0,5})?)/i);
      if (numberedActivityMatch) {
        const cleaned = numberedActivityMatch[1]
          .replace(/\s+(?:đi|nhé|nha|cho|tôi|mình|đạt|điểm|cao|với|này|đó|không|ko|được|vẫn|có|thể)$/i, '')
          .replace(/[:：\s]+$/, '')
          .trim();
        if (cleaned) targetActivity = cleaned;
      }
    }
  }

  return {
    ...(targetActivity ? { targetActivity } : {}),
    ...(solveAll ? { solveAll: true } : {}),
    ...(hasFilter ? { activityFilter: filter } : {})
  };
}

/** Robustly extracts user credentials, target LMS URL, course code/subject, and flexible intent from natural language prompt */
export function extractCredentialsAndUrlFromPrompt(prompt: string): {
  username?: string;
  password?: string;
  targetUrl?: string;
  targetCourse?: string;
  userIntent?: string;
  allowReattempt?: boolean;
  targetActivity?: string;
  solveAll?: boolean;
  activityFilter?: ActivityFilterSpec;
  attachmentPath?: string;
  documentFormat?: 'docx' | 'pdf' | 'txt' | 'md' | 'csv' | 'xlsx' | 'png';
  solveAssignments?: boolean;
  useWordApp?: boolean;
  wordSavePath?: string;
  wordTemplatePath?: string;
  studentHeader?: string;
  handwritingMode?: boolean;
  handwritingSamplePath?: string;
  parallel?: boolean;
  concurrency?: number;
  targetCourses?: string[];
} {
  let username: string | undefined = undefined;
  let password: string | undefined = undefined;
  let targetUrl: string | undefined = undefined;
  let targetCourse: string | undefined = undefined;
  let userIntent: string | undefined = undefined;
  let allowReattempt: boolean | undefined = undefined;

  // 1. Detect target URL or recognized LMS/MOOC platform
  const knownPlatform = resolveKnownPlatformFromPrompt(prompt);
  const rawUrlMatch = prompt.match(/(https?:\/\/[^\s,;]+)/i);
  if (rawUrlMatch) {
    targetUrl = rawUrlMatch[1];
  } else {
    const domainMatch = prompt.match(/(?:^|[\s,;])((?:[a-zA-Z0-9-]+\.)+(?:edu\.vn|edu|com|vn|org|net|io|ai|fr|de|ac\.uk|ac\.in|gov\.in|asia)(?:\/[^\s,;]*)?)/i);
    if (domainMatch) {
      targetUrl = 'https://' + domainMatch[1];
    } else if (knownPlatform) {
      targetUrl = knownPlatform.url;
    }
  }

  // 2. Detect password (preserving special characters like //, @, #, !) and handling abbreviations like mk
  const passMatch = prompt.match(/(?:mật\s*khẩu|mat\s*khau|password|passwd|pass|pwd|\bmk\b)(?:\s*(?:của tôi|đăng nhập|cho tài khoản|sinh viên))?(?:\s*(?:là|nhập|nhập là|điền|điền là|:|=))\s*([^\s,;]+)/i)
    || prompt.match(/(?:mật\s*khẩu|mat\s*khau|password|passwd|pass|pwd|\bmk\b)\s+([^\s,;]+)/i);
  if (passMatch) {
    const raw = passMatch[1].trim();
    if (!['là', 'của', 'được', 'này', 'cho', 'vào', 'thì', 'luôn', 'rồi'].includes(raw.toLowerCase())) {
      password = raw;
    }
  }

  // 3. Detect email or username (handling abbreviations like tk)
  const emailMatch = prompt.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/i);
  if (emailMatch) {
    username = emailMatch[1];
  } else {
    const userMatch = prompt.match(/(?:tài\s*khoản|tai\s*khoan|username|user|email|mail|\btk\b)(?:\s*(?:sinh viên|người dùng|của tôi|có mail|có email))?(?:\s*(?:là|nhập|:|=))\s*([^\s,;]+)/i)
      || prompt.match(/(?:tài\s*khoản|tai\s*khoan|username|user|\btk\b)\s+([^\s,;]+)/i);
    if (userMatch) {
      const raw = userMatch[1].trim();
      if (!['là', 'của', 'được', 'này', 'cho', 'có', 'vào', 'thì', 'luôn'].includes(raw.toLowerCase())) {
        username = raw;
      }
    }
  }

  // 4. Detect target course code or subject name (ignoring generic words like "tuần 12", "này", "và hạn nộp")
  const courseCode = extractCourseCode(prompt);

  const subjectMatch = prompt.match(/(?:môn(?:\s*học)?|học\s*phần|khóa\s*học)\s+([a-zA-Z0-9\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ_-]{3,40}?)(?=[,\.\?!]|\s+(?:của|xem|nếu|tìm|kiểm|tài|pass|mật|mail|tk|mk|làm|giải|nộp|chọn|vào|để|nhưng|mà|đang|chưa|đã|sau|từ|trừ|giúp|cho|với|thử|nào|gì|còn|hết|khác|có)|$)/i);
  let subjectName = subjectMatch ? subjectMatch[1].trim() : undefined;
  const noiseSubjectPrefixRegex = /^(?:của|này|đó|kia|khác|nào|gì|hiện\s*tại|mục\s*tiêu|hôm\s*nay|tuần\s*\d*|online\s*\d*|trắc\s*nghiệm|bài\s*tập|hạn\s*nộp|và\s*hạn\s*nộp|còn\s*hạn|đang\s*mở|chưa\s*làm|tất\s*cả|mọi\s*người|học)(?:\s|$)/i;
  if (
    subjectName &&
    (noiseSubjectPrefixRegex.test(subjectName) ||
      subjectName.length < 3)
  ) {
    subjectName = undefined;
  }

  if (courseCode && subjectName) {
    targetCourse = `${courseCode} - ${subjectName}`;
  } else if (courseCode) {
    targetCourse = courseCode;
  } else if (subjectName) {
    targetCourse = subjectName;
  }

  // 5. Detect re-attempt policy & activity scope
  const negatedReattempt = /(?:không|ko|k|đừng|dung|tránh)\s+(?:re-?attempt|làm\s*lại|lam\s*lai|thi\s*lại|thử\s*lại)/i.test(prompt);
  if (!negatedReattempt && /re-?attempt|làm\s*lại|lam\s*lai|thử\s*lại|thu\s*lai|thi\s*lại|thi\s*lai|cải\s*thiện\s*điểm|cai\s*thien\s*diem|nâng\s*điểm|nang\s*diem/i.test(prompt)) {
    allowReattempt = true;
  } else if (negatedReattempt) {
    allowReattempt = false;
  }

  const scopeParsed = parseActivityScopeFromPrompt(prompt);

  // 6. Flexible intent inference: distinguish explanation/inspection-only questions from active quiz solving
  const explicitNoSolve = /(?:không|ko|k|đừng|dung|chưa\s*cần)\s+(?:cần\s*)?(?:làm|giải|nộp|viết|bấm|thi)(?=\s|$|[,.!?])|(?:chỉ|chi)\s+(?:xem|kiểm\s*tra|check|đọc|tìm|hỏi|liệt\s*kê)(?=\s|$|[,.!?])/i.test(prompt);
  const explanationOrStatusQuestion =
    /(?:^\s*(?:tại\s*sao|tai\s*sao|vì\s*sao|vi\s*sao|làm\s*sao\s*để|bao\s*nhiêu|mấy\s*điểm|khi\s*nào|hỏi\s*thử|giải\s*thích)|(?:^|\s)(?:là\s*sao|tại\s*sao|vì\s*sao|vẫn\s*báo\s*là|mở\s*chưa|còn\s*mở\s*không|đã\s*làm\s*chưa|làm\s*được\s*chưa|bao\s*nhiêu\s*điểm)(?=\s|$|[,.!?]))/i.test(prompt);

  // Extract optional Word save target path, Word template path, handwriting sample path, vs attachment path & document format
  let wordSavePath: string | undefined;
  const savePathMatch = prompt.match(/(?:lưu\s*(?:vào|thành|tại|ra|file)|xuất\s*(?:ra|thành)|save\s*(?:to|as))\s*[:=]?\s*(?:["“]([a-zA-Z]:[\\/][^"”\n]+\.docx)["”]|([a-zA-Z]:[\\/][^\s,;]+\.docx))/i);
  if (savePathMatch) {
    wordSavePath = (savePathMatch[1] || savePathMatch[2]).trim();
  }
  let remainingPrompt = savePathMatch ? prompt.replace(savePathMatch[0], ' ') : prompt;

  let wordTemplatePath: string | undefined;
  const templateMatch = remainingPrompt.match(/(?:mẫu\s*word|file\s*mẫu|template)\s*[:=]?\s*["“']?((?:[a-zA-Z]:[\\/]|(?:\.\.?[\\/]))[^\s"”',;\n]+\.docx)["”']?/i);
  if (templateMatch) {
    wordTemplatePath = templateMatch[1].trim();
    remainingPrompt = remainingPrompt.replace(templateMatch[0], ' ');
  }

  const handwritingMode = /(?:chữ\s*viết\s*tay|viết\s*tay|handwrit(?:ten|ing))/i.test(prompt);
  let handwritingSamplePath: string | undefined;
  const sampleMatch = remainingPrompt.match(/(?:mẫu\s*chữ|chữ\s*mẫu|theo\s*chữ(?:\s*viết\s*tay)?|sample|font)[^"'`\n]{0,40}?["“']?((?:[a-zA-Z]:[\\/]|(?:\.\.?[\\/]))[^\s"”',;\n]+\.(?:png|jpg|jpeg|ttf|otf))["”']?/i);
  if (sampleMatch) {
    handwritingSamplePath = sampleMatch[1].trim();
    remainingPrompt = remainingPrompt.replace(sampleMatch[0], ' ');
  }

  let attachmentPath: string | undefined;
  const winPathMatch = remainingPrompt.match(/(?:["“]([a-zA-Z]:[\\/][^"”\n]+\.(?:txt|md|csv|docx|pdf|xlsx|pptx|png|jpg|jpeg|py|java|c|cpp|js|ts|ttf|otf))["”]|([a-zA-Z]:[\\/][^\s,;]+\.(?:txt|md|csv|docx|pdf|xlsx|pptx|png|jpg|jpeg|py|java|c|cpp|js|ts|ttf|otf)))/i);
  const relPathMatch = remainingPrompt.match(/(?:file|tệp|tep|đính\s*kèm|upload|nộp)\s+(?:là\s*|:|=)?\s*["“]?((?:\.\.?[\\/])?[^"\s,;<>:]+\.(?:txt|md|csv|docx|pdf|xlsx|pptx|png|jpg|jpeg))["”]?/i);
  const candPath = (winPathMatch?.[1] || winPathMatch?.[2] || (relPathMatch && !/^https?:/i.test(relPathMatch[1]) ? relPathMatch[1] : undefined))?.trim();
  if (candPath) {
    if (handwritingMode && !handwritingSamplePath && /\.(?:png|jpg|jpeg|ttf|otf)$/i.test(candPath)) {
      handwritingSamplePath = candPath;
    } else {
      attachmentPath = candPath;
    }
  }

  const headerMatch = prompt.match(/(?:header|thông\s*tin\s*sinh\s*viên|họ\s*tên\s*mssv)\s*[:=]\s*["“']([^"”'\n]{3,120})["”']/i);
  const studentHeader = headerMatch ? headerMatch[1].trim() : undefined;

  const upperCodes = Array.from(new Set(
    (prompt.replace(/https?:\/\/\S+/gi, ' ').match(/\b([A-Z]{2,4}\d{3,4}[A-Z0-9]*)\b/g) || []).map(c => c.toUpperCase())
  ));
  let detectedCodes = upperCodes;
  if (detectedCodes.length < 2) {
    const cuedCodes: string[] = [];
    const cuedRe = /(?:môn(?:\s*học)?|học\s*phần|khóa(?:\s*học)?|course|và|,)\s*([a-zA-Z]{2,4}\d{3,4}[a-zA-Z0-9]*)\b/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cuedRe.exec(prompt.replace(/https?:\/\/\S+/gi, ' '))) !== null) {
      cuedCodes.push(cm[1].toUpperCase());
    }
    detectedCodes = Array.from(new Set([...upperCodes, ...cuedCodes]));
  }
  const targetCourses = detectedCodes.length >= 2 ? detectedCodes : undefined;

  const concMatch = prompt.match(/(?:(\d+)\s*(?:luồng|tabs?|threads?)|concurrency\s*[:=]?\s*(\d+))/i);
  const parsedConc = concMatch ? Math.min(Math.max(Number(concMatch[1] || concMatch[2]) || 0, 1), 4) : undefined;
  const concurrency = parsedConc && parsedConc >= 2 ? parsedConc : undefined;
  const parallel = Boolean(
    /(?:đa\s*luồng|song\s*song|parallel|cùng\s*lúc\s*nhiều|nhiều\s*tab)/i.test(prompt) ||
    concurrency !== undefined ||
    (targetCourses && targetCourses.length >= 2)
  );

  const useWordAppCue =
    /\b(?:mở\s*word|trong\s*word|bằng\s*word|qua\s*word|trên\s*word|dùng\s*word|file\s*word|ms\s*word|microsoft\s*word|soạn\s*word|viết\s*word)\b/i.test(prompt) ||
    Boolean(wordSavePath) ||
    Boolean(wordTemplatePath);

  let documentFormat: 'docx' | 'pdf' | 'txt' | 'md' | 'csv' | 'xlsx' | 'png' | undefined;
  if (/(?:nộp|nop|tạo|tao|viết|viet|xuất|xuat|lưu|file|định\s*dạng|word|chữ\s*viết\s*tay)\b/i.test(prompt)) {
    if (handwritingMode && /\b(?:png|ảnh)\b/i.test(prompt)) documentFormat = 'png';
    else if (/\b(?:docx|word)\b/i.test(prompt) || useWordAppCue) documentFormat = 'docx';
    else if (/\bpdf\b/i.test(prompt)) documentFormat = 'pdf';
    else if (/\bxlsx|excel\b/i.test(prompt)) documentFormat = 'xlsx';
    else if (/\bcsv\b/i.test(prompt)) documentFormat = 'csv';
    else if (/\bmarkdown|\.md\b/i.test(prompt)) documentFormat = 'md';
    else if (/\btxt\b/i.test(prompt)) documentFormat = 'txt';
  }

  const assignmentActionCue =
    /(?:(?:hãy|vào|tự\s*động)?\s*(?:viết|soạn|nộp|upload|đính\s*kèm|gửi|làm)\s+(?:[^\s,.;!?]+\s+){0,3}?(?:bài(?:\s*(?:luận|tập\s*(?:tự\s*luận|nộp\s*file)|tự\s*luận|báo\s*cáo))?|file|tệp|báo\s*cáo|tài\s*liệu\s*nộp)|bài\s*(?:tập\s*)?(?:tự\s*luận|bài\s*luận|nộp\s*file|assignment)|online\s*text|submit\s*assignment)/i.test(prompt) &&
    !explicitNoSolve;
  const solveAssignments = assignmentActionCue || Boolean(attachmentPath) || useWordAppCue || handwritingMode;

  const directSolveImperative =
    /(?:làm|lam|giải(?!\s*(?:tích|thuật|thích|pháp|đáp))|giai(?!\s*(?:tich|thuat|thich|phap|dap))|nộp|nop|hoàn\s*thành|hoan\s*thanh|xử\s*lý|xu\s*ly|thi\s*lại|thử\s*lại|re-?attempt)\s+(?:[^\s,.;!?]+\s+){0,4}?(?:bài|bai|quiz|test|trắc\s*nghiệm|trac\s*nghiem|hết|het|tất\s*cả|tat\s*ca|nốt|not|lại|lai)(?=\s|$|[,.!?])|\b(?:làm\s*bài|lam\s*bai|làm\s*hết|lam\s*het|giải\s*hết|giai\s*het|giải\s*bài|giai\s*bai|nộp\s*bài|nop\s*bai|làm\s*lại|lam\s*lai|re-?attempt|thi\s*lại|thử\s*lại)\b/i;
  const hasExplicitSolveCommand = (directSolveImperative.test(prompt) || solveAssignments) && !explicitNoSolve;

  if (hasExplicitSolveCommand && (!explanationOrStatusQuestion || /\b(?:hãy|hãy\s*vào|tự\s*động|làm\s*lại|re-?attempt|nộp\s*bài|viết\s*bài|nộp\s*file)\b/i.test(prompt))) {
    userIntent = 'SOLVE_QUIZ';
  } else if (/deadline|hạn\s*nộp|han\s*nop|sắp\s*hết\s*hạn|sap\s*den\s*han|quá\s*hạn|qua\s*han|kiểm\s*tra|check|xem\s*(?:bài|điểm|trạng\s*thái|lại)|bao\s*nhiêu\s*điểm|mở\s*chưa|còn\s*hạn|chưa\s*làm/i.test(prompt)) {
    userIntent = 'CHECK_DEADLINES';
  } else if (/tài\s*liệu|tai\s*lieu|slide|bài\s*giảng|giáo\s*trình|tải\s*về|download/i.test(prompt)) {
    userIntent = 'DOWNLOAD_RESOURCES';
  } else if (/danh\s*sách\s*môn|các\s*môn|khóa\s*học|khoa\s*hoc/i.test(prompt)) {
    userIntent = 'LIST_COURSES';
  }

  return {
    username,
    password,
    targetUrl,
    targetCourse,
    userIntent,
    allowReattempt,
    ...(attachmentPath ? { attachmentPath } : {}),
    ...(documentFormat ? { documentFormat } : {}),
    ...(solveAssignments ? { solveAssignments: true } : {}),
    ...(useWordAppCue ? { useWordApp: true } : {}),
    ...(wordSavePath ? { wordSavePath } : {}),
    ...(wordTemplatePath ? { wordTemplatePath } : {}),
    ...(studentHeader ? { studentHeader } : {}),
    ...(handwritingMode ? { handwritingMode: true } : {}),
    ...(handwritingSamplePath ? { handwritingSamplePath } : {}),
    ...(parallel ? { parallel: true } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(targetCourses ? { targetCourses } : {}),
    ...scopeParsed
  };
}

/** Initializes a clean or persistent AgentContext */
export function createAgentContext(config?: Partial<AgentConfig>, existing?: Partial<AgentContext>): AgentContext {
  const allowedHosts = config?.allowedHosts && config.allowedHosts.length > 0
    ? [...config.allowedHosts]
    : [...DEFAULT_ALLOWED_HOSTS];

  if (config?.targetWebUrl) {
    registerAllowedUrlHost(allowedHosts, config.targetWebUrl);
  }

  return {
    browser: existing?.browser,
    context: existing?.context,
    page: existing?.page,
    activeUrl: existing?.activeUrl,
    isLoggedIn: existing?.isLoggedIn ?? false,
    activeAccountId: existing?.activeAccountId || config?.accountId,
    collectedFindings: existing?.collectedFindings || {},
    history: existing?.history || [],
    goalHistory: existing?.goalHistory || [],
    matchedPlaybooks: existing?.matchedPlaybooks,
    config: {
      allowedHosts,
      maxSteps: config?.maxSteps ?? 0, // 0 = Không giới hạn số bước thực thi (Unlimited steps)
      maxModelCalls: config?.maxModelCalls ?? 0, // 0 = Không giới hạn lượt gọi AI model
      timeoutMs: config?.timeoutMs ?? 1800000, // 30 phút mặc định (hỗ trợ tạm ngưng chờ RPM reset)
      headless: config?.headless ?? false, // Default visible browser for transparency
      autoRead: config?.autoRead ?? false, // Full A-Z autonomy by default unless caller explicitly locks read-only
      requireStateChangeApproval: config?.requireStateChangeApproval ?? false,
      profileOverride: config?.profileOverride,
      verbose: config?.verbose ?? true,
      targetWebUrl: config?.targetWebUrl,
      inMemoryCredentials: config?.inMemoryCredentials,
      accountId: config?.accountId,
      autoLogin: config?.autoLogin ?? true,
      targetCourse: config?.targetCourse,
      targetActivity: config?.targetActivity,
      solveAll: config?.solveAll,
      activityFilter: config?.activityFilter,
      attachmentPath: config?.attachmentPath,
      documentFormat: config?.documentFormat,
      solveAssignments: config?.solveAssignments,
      useWordApp: config?.useWordApp,
      wordSavePath: config?.wordSavePath,
      wordTemplatePath: config?.wordTemplatePath,
      studentHeader: config?.studentHeader,
      handwritingMode: config?.handwritingMode,
      handwritingSamplePath: config?.handwritingSamplePath,
      parallel: config?.parallel,
      concurrency: config?.concurrency,
      targetCourses: config?.targetCourses,
      userIntent: config?.userIntent,
      playbookStorePath: config?.playbookStorePath,
      disablePlaybooks: config?.disablePlaybooks,
      modelOverride: config?.modelOverride,
      logDir: config?.logDir,
      disableLogs: config?.disableLogs
    }
  };
}

/** Executes an autonomous agent loop for a user goal */
export async function runAgentLoop(
  goal: string,
  ctx: AgentContext,
  onStepUpdate?: (step: AgentStep) => void
): Promise<AgentExecutionResult> {
  const startTime = Date.now();
  const hasStepLimit = typeof ctx.config.maxSteps === 'number' && ctx.config.maxSteps > 0 && ctx.config.maxSteps !== Infinity;
  const maxSteps = hasStepLimit ? ctx.config.maxSteps! : Infinity;

  const hasModelLimit = typeof ctx.config.maxModelCalls === 'number' && ctx.config.maxModelCalls > 0 && ctx.config.maxModelCalls !== Infinity;
  const maxModelCalls = hasModelLimit ? ctx.config.maxModelCalls! : Infinity;

  const timeoutMs = ctx.config.timeoutMs || 1800000;
  let modelCallCount = 0;
  let finalStatus: AgentGoalStatus = 'RUNNING';
  let finalSummary = '';
  let finalData: any = undefined;

  // Anchor per-turn history slice so previous REPL turns never hijack the current turn's planner state
  const isFollowUpTurn = ctx.goalHistory.length > 0;
  ctx.currentTurnStartIndex = ctx.history.length;
  ctx.collectedFindings['turnSolvedCount'] = 0;
  ctx.collectedFindings['turnCheckedCourse'] = false;

  // Auto-detect credentials and target URL from natural language prompt if present
  const knownSecrets: string[] = [];
  if (ctx.config.inMemoryCredentials?.password) {
    knownSecrets.push(ctx.config.inMemoryCredentials.password);
  }

  const extracted = extractCredentialsAndUrlFromPrompt(goal);
  if (extracted.password && extracted.username) {
    ctx.config.inMemoryCredentials = { username: extracted.username, password: extracted.password };
    ctx.activeAccountId = 'in_memory';
    knownSecrets.push(extracted.password);
  } else if (extracted.password && !ctx.config.inMemoryCredentials?.password) {
    if (ctx.config.inMemoryCredentials) {
      ctx.config.inMemoryCredentials.password = extracted.password;
    }
    knownSecrets.push(extracted.password);
  }

  if (extracted.targetUrl) {
    if (!ctx.config.targetWebUrl || isFollowUpTurn) {
      ctx.config.targetWebUrl = extracted.targetUrl;
    }
    registerAllowedUrlHost(ctx.config.allowedHosts, extracted.targetUrl);
  }

  if (extracted.targetCourse) {
    if (!ctx.config.targetCourse || isFollowUpTurn) {
      ctx.config.targetCourse = extracted.targetCourse;
    }
  } else if (isFollowUpTurn && /(?:tất\s*cả\s*(?:các\s*)?môn|mọi\s*môn|toàn\s*bộ\s*môn|các\s*môn\s*khác|môn\s*khác|dashboard|trang\s*chủ)/i.test(goal)) {
    ctx.config.targetCourse = undefined;
  }

  if (isFollowUpTurn) {
    ctx.config.userIntent = extracted.userIntent;
    ctx.config.allowReattempt = Boolean(extracted.allowReattempt);
    ctx.config.targetActivity = extracted.targetActivity;
    ctx.config.solveAll = Boolean(extracted.solveAll);
    ctx.config.activityFilter = extracted.activityFilter;
    ctx.config.attachmentPath = extracted.attachmentPath;
    ctx.config.documentFormat = extracted.documentFormat;
    ctx.config.solveAssignments = Boolean(extracted.solveAssignments);
    ctx.config.useWordApp = extracted.useWordApp;
    ctx.config.wordSavePath = extracted.wordSavePath;
    ctx.config.wordTemplatePath = extracted.wordTemplatePath;
    ctx.config.studentHeader = extracted.studentHeader;
    ctx.config.handwritingMode = Boolean(extracted.handwritingMode);
    ctx.config.handwritingSamplePath = extracted.handwritingSamplePath;
    ctx.config.parallel = Boolean(extracted.parallel);
    ctx.config.concurrency = extracted.concurrency;
    ctx.config.targetCourses = extracted.targetCourses;
  } else {
    if (extracted.userIntent) {
      ctx.config.userIntent = extracted.userIntent;
    }
    if (extracted.allowReattempt !== undefined) {
      ctx.config.allowReattempt = extracted.allowReattempt;
    }
    if (extracted.targetActivity && !ctx.config.targetActivity) {
      ctx.config.targetActivity = extracted.targetActivity;
    }
    if (extracted.solveAll && ctx.config.solveAll === undefined) {
      ctx.config.solveAll = true;
    }
    if (extracted.activityFilter && !ctx.config.activityFilter) {
      ctx.config.activityFilter = extracted.activityFilter;
    }
    if (extracted.attachmentPath && !ctx.config.attachmentPath) {
      ctx.config.attachmentPath = extracted.attachmentPath;
    }
    if (extracted.documentFormat && !ctx.config.documentFormat) {
      ctx.config.documentFormat = extracted.documentFormat;
    }
    if (extracted.solveAssignments && ctx.config.solveAssignments === undefined) {
      ctx.config.solveAssignments = true;
    }
    if (extracted.useWordApp !== undefined && ctx.config.useWordApp === undefined) {
      ctx.config.useWordApp = extracted.useWordApp;
    }
    if (extracted.wordSavePath && !ctx.config.wordSavePath) {
      ctx.config.wordSavePath = extracted.wordSavePath;
    }
    if (extracted.wordTemplatePath && !ctx.config.wordTemplatePath) {
      ctx.config.wordTemplatePath = extracted.wordTemplatePath;
    }
    if (extracted.studentHeader && !ctx.config.studentHeader) {
      ctx.config.studentHeader = extracted.studentHeader;
    }
    if (extracted.handwritingMode && ctx.config.handwritingMode === undefined) {
      ctx.config.handwritingMode = true;
    }
    if (extracted.handwritingSamplePath && !ctx.config.handwritingSamplePath) {
      ctx.config.handwritingSamplePath = extracted.handwritingSamplePath;
    }
    if (extracted.parallel && ctx.config.parallel === undefined) {
      ctx.config.parallel = true;
    }
    if (extracted.concurrency && !ctx.config.concurrency) {
      ctx.config.concurrency = extracted.concurrency;
    }
    if (extracted.targetCourses && !ctx.config.targetCourses) {
      ctx.config.targetCourses = extracted.targetCourses;
    }
  }

  // Adaptive Playbook Memory: match remembered scenarios for casual or abbreviated prompts
  ctx.matchedPlaybooks = [];
  if (!ctx.config.disablePlaybooks) {
    try {
      const pbMatches = await findMatchingPlaybooks(goal, {
        targetWebUrl: ctx.config.targetWebUrl,
        targetCourse: ctx.config.targetCourse,
        userIntent: ctx.config.userIntent,
        storePath: ctx.config.playbookStorePath
      });
      if (pbMatches.length > 0) {
        ctx.matchedPlaybooks = pbMatches.map(m => m.playbook);
        const topPb = pbMatches[0].playbook;
        if (!ctx.config.targetWebUrl && topPb.targetWebUrl) {
          ctx.config.targetWebUrl = topPb.targetWebUrl;
          registerAllowedUrlHost(ctx.config.allowedHosts, topPb.targetWebUrl);
        }
        if (!ctx.config.targetCourse && (topPb.courseName || topPb.courseCode)) {
          ctx.config.targetCourse = topPb.courseName || topPb.courseCode;
        }
        if (!ctx.config.userIntent && topPb.intent !== 'GENERAL') {
          if (topPb.intent !== 'SOLVE_QUIZ' || /chạy\s*lại|chay\s*lai|như\s*cũ|nhu\s*cu|như\s*hôm\s*qua|như\s*trước|tiếp\s*tục|tiep\s*tuc/i.test(goal)) {
            ctx.config.userIntent = topPb.intent;
          }
        }
        if (ctx.config.verbose) {
          console.log(
            paint(`[Playbook Memory] `, 'purple', true) +
            paint(`🧠 Khớp kịch bản "${topPb.title}" (${topPb.successCount} lần thành công${topPb.courseUrl ? ` -> ${topPb.courseUrl}` : ''})`, 'fg')
          );
        }
      }
    } catch {
      // Non-fatal: proceed normally without playbook hints
    }
  }

  // Auto-bind default saved profile if user hasn't specified credentials or an active profile yet
  if (!ctx.isLoggedIn && !ctx.activeAccountId && !ctx.config.inMemoryCredentials) {
    try {
      const accounts = await listAccounts();
      const defaultId = await getDefaultAccountId();
      const fallbackId = (defaultId && accounts[defaultId]) ? defaultId : Object.keys(accounts)[0];
      if (fallbackId && accounts[fallbackId]) {
        ctx.activeAccountId = fallbackId;
        ctx.config.accountId = fallbackId;
        if (!ctx.config.targetWebUrl && accounts[fallbackId].loginUrl) {
          ctx.config.targetWebUrl = accounts[fallbackId].loginUrl;
        }
        registerAllowedUrlHost(ctx.config.allowedHosts, accounts[fallbackId].loginUrl || accounts[fallbackId].loginHost, [
          accounts[fallbackId].loginHost,
          ...(accounts[fallbackId].trustedLoginHosts || [])
        ]);
      }
    } catch {}
  }

  // Clear stale course findings flags on follow-up turns if course changed
  if (isFollowUpTurn) {
    delete ctx.collectedFindings['unmatchedOpenQuizzes'];
  }

  // Lift read-only and approval gates ONLY when intent is genuinely active execution (never hijack Q&A or read-only checks)
  if (ctx.config.userIntent === 'SOLVE_QUIZ') {
    ctx.config.requireStateChangeApproval = false;
    ctx.config.autoRead = false;
  }

  // Initialize structured redacted run logger for this execution
  const runLogger = new AgentRunLogger({ goal, ctx, knownSecrets });
  ctx.runLogger = runLogger;
  runLogger.syncContext(ctx);

  // Print start banner if verbose
  if (ctx.config.verbose) {
    console.log(paint(`\n[Agent Goal] `, 'cyan', true) + paint(redactSecrets(goal, knownSecrets), 'fg', true));
    if (ctx.config.targetCourse || ctx.config.userIntent || ctx.config.targetWebUrl) {
      const intentParts: string[] = [];
      if (ctx.config.targetWebUrl) intentParts.push(`Web: ${ctx.config.targetWebUrl}`);
      if (ctx.config.targetCourse) intentParts.push(`Môn: ${ctx.config.targetCourse}`);
      if (ctx.config.userIntent) intentParts.push(`Mục đích: ${ctx.config.userIntent}`);
      console.log(paint(`[Phân tích ý định] `, 'purple', true) + paint(intentParts.join(' | '), 'muted'));
    }
    const stepBannerText = hasStepLimit ? `Tối đa ${maxSteps} bước` : 'Không giới hạn số bước';
    console.log(paint(`[Status] Bắt đầu chu trình ReAct (${stepBannerText})...`, 'muted'));
  }

  // Pre-boot page if needed
  try {
    await ensureBrowserPage(ctx);
  } catch (e: any) {
    return {
      goal,
      status: 'FAILED',
      steps: [],
      summary: `Không thể khởi động Chromium: ${e.message}`,
      durationMs: Date.now() - startTime,
      modelCalls: 0
    };
  }

  for (let stepIndex = 1; !hasStepLimit || stepIndex <= maxSteps; stepIndex++) {
    // 1. Guard: Check overall timeout
    if (Date.now() - startTime > timeoutMs) {
      finalStatus = 'NEEDS_REVIEW';
      finalSummary = `Tác vụ đạt giới hạn thời gian thực thi (${timeoutMs / 1000}s). Các thông tin đã thu thập được bảo toàn.`;
      break;
    }

    // 2. Guard: Check model call limits
    if (hasModelLimit && modelCallCount >= maxModelCalls) {
      finalStatus = 'NEEDS_REVIEW';
      finalSummary = `Đã đạt giới hạn số lượt gọi AI model (${modelCallCount} calls). Dừng lại để bảo vệ chi phí/quota.`;
      break;
    }

    if (ctx.config.verbose) {
      const stepTag = hasStepLimit ? `Bước ${stepIndex}/${maxSteps}` : `Bước ${stepIndex}`;
      console.log('');
      console.log(
        paint('╭─ ', 'purple', true) +
        badge(stepTag, 'cyan') + ' ' +
        paint('Đang lập kế hoạch ReAct...', 'muted')
      );
    }

    // 3. Plan next step using ModelRouter
    let decision: PlannerDecision;
    const stepStart = Date.now();
    try {
      modelCallCount++;
      decision = await planNextStep(
        ctx,
        goal,
        stepIndex,
        (from, to, reason) => {
          if (ctx.config.verbose) {
            console.log(
              paint(`[AI Auto-Switch] `, 'yellow', true) +
              paint(`🔄 Tự động chuyển model từ "${from}" sang "${to}". Lý do: ${reason}`, 'yellow')
            );
          }
        },
        (info) => {
          if (ctx.config.verbose) {
            console.log(paint(formatRateLimitWaitNotice(info), 'yellow', true));
          }
        }
      );
      if (ctx.config.verbose && decision.modelUsed) {
        const latencyText = typeof decision.latencyMs === 'number' ? ` · ${decision.latencyMs}ms` : '';
        console.log(
          paint('├─ ', 'purple') +
          paint('🧠 AI Model  : ', 'purple', true) +
          paint(decision.modelUsed, 'cyan', true) +
          paint(` [${decision.profileUsed || 'primary'}${latencyText}]`, 'muted')
        );
      }
    } catch (planErr: any) {
      console.error(paint(`[Lỗi Planner] ${planErr.message}`, 'red'));
      runLogger.recordModelEvent({ phase: 'planner', event: 'error', detail: planErr.message });
      finalStatus = 'FAILED';
      finalSummary = `Lỗi lập kế hoạch AI: ${planErr.message}`;
      break;
    }

    // Display reasoning and action (sanitizing any password from terminal logs)
    if (ctx.config.verbose) {
      if (decision.thought) {
        console.log(paint('├─ ', 'purple') + paint('💭 Suy nghĩ  : ', 'blue', true) + paint(redactSecrets(decision.thought, knownSecrets), 'fg'));
      }
      if (decision.plan && decision.plan.length > 0) {
        const cleanPlan = decision.plan.slice(0, 3).map(p => redactSecrets(p, knownSecrets)).join(' ➔ ');
        console.log(paint('├─ ', 'purple') + paint('🗺  Kế hoạch  : ', 'violet') + cleanPlan);
      }

      const argsCopy = { ...decision.action.args };
      if (decision.action.tool === 'browser.fill') {
        const sel = String(argsCopy.selector || '').toLowerCase();
        if (sel.includes('pass') || sel.includes('pwd')) {
          argsCopy.value = '[REDACTED_PASSWORD]';
        }
      }
      console.log(
        paint('├─ ', 'purple') +
        paint('⚡ Hành động : ', 'green', true) +
        paint(decision.action.tool, 'yellow', true) +
        paint(` (${redactSecrets(JSON.stringify(argsCopy), knownSecrets)})`, 'muted')
      );
    }

    // 4. Execute the chosen tool
    const toolResult = await executeAgentTool(decision.action, ctx);
    const stepDuration = Date.now() - stepStart;

    const currentStep: AgentStep = {
      stepIndex,
      thought: decision.thought,
      plan: decision.plan,
      toolCall: decision.action,
      result: toolResult,
      timestamp: new Date().toISOString(),
      durationMs: stepDuration
    };

    ctx.history.push(currentStep);
    runLogger.syncContext(ctx);
    runLogger.recordStep(currentStep, { modelUsed: decision.modelUsed, profileUsed: decision.profileUsed });
    await runLogger.flush(ctx.activeUrl).catch(() => {});
    if (onStepUpdate) {
      try { onStepUpdate(currentStep); } catch {}
    }

    // Display observation
    if (ctx.config.verbose) {
      const statusIcon = toolResult.success ? '✔' : '✖';
      const statusColor = toolResult.success ? 'green' : 'red';
      console.log(
        paint('╰─ ', 'purple') +
        paint(`Quan sát ${statusIcon} : `, statusColor, true) +
        paint(toolResult.observationText.split('\n')[0], 'fg')
      );
    }

    // 5. Check if goal is complete (enforcing verified status from Evidence-Based Completion Gate)
    if (decision.action.tool === 'agent.reportResult') {
      finalStatus = (toolResult.data?.status as AgentGoalStatus) || (decision.action.args.status as AgentGoalStatus) || 'DONE';
      finalSummary = toolResult.data?.summary || decision.action.args.summary || toolResult.observationText;
      finalData = decision.action.args.data || ctx.collectedFindings;
      break;
    }

    // 6. Check for authentication halt (WAITING_FOR_AUTH)
    if (toolResult.data?.mfaRequired || toolResult.observationText.includes('XÁC THỰC MFA')) {
      finalStatus = 'WAITING_FOR_AUTH';
      finalSummary = `Trình duyệt đã dừng tại trang xác thực 2 bước (MFA/OTP) (${ctx.activeUrl}). Vui lòng xác thực trên điện thoại/trình duyệt rồi tiếp tục tác vụ.`;
      break;
    }

    if (toolResult.data?.authRequired || toolResult.observationText.includes('XÁC THỰC YÊU CẦU')) {
      // If credentials exist (in-memory or saved account), do NOT halt! Let Planner/autoLogin proceed.
      const hasCreds = Boolean(ctx.config.inMemoryCredentials?.password || ctx.activeAccountId);
      if (!hasCreds) {
        finalStatus = 'WAITING_FOR_AUTH';
        finalSummary = `Trình duyệt đã dừng tại trang xác thực (${ctx.activeUrl}). Chưa có thông tin tài khoản được cung cấp. Hãy đăng nhập trên trình duyệt hoặc thêm thông tin vào prompt.`;
        break;
      }
    }

    // 7. If step was the last allowed step, attempt auto-summary
    if (hasStepLimit && stepIndex >= maxSteps) {
      finalStatus = 'NEEDS_REVIEW';
      finalSummary = `Đã đạt giới hạn tối đa ${maxSteps} bước thực thi. Vui lòng kiểm tra lại trạng thái.`;
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  runLogger.syncContext(ctx);
  const runLogPath = await runLogger.finalize({
    status: finalStatus,
    summary: finalSummary,
    durationMs,
    modelCalls: modelCallCount,
    finalUrl: ctx.activeUrl
  }).catch(() => undefined);
  if (runLogPath && ctx.config.verbose) {
    console.log(paint(`[Run Log] `, 'purple', true) + paint(`📄 Log chi tiết đã lưu tại: ${runLogPath}`, 'muted'));
  }

  // Record into goal history
  ctx.goalHistory.push({
    goal,
    summary: finalSummary,
    timestamp: new Date().toISOString()
  });

  const executionResult: AgentExecutionResult = {
    goal,
    status: finalStatus,
    steps: ctx.history.slice(ctx.currentTurnStartIndex ?? 0),
    summary: finalSummary,
    data: finalData || ctx.collectedFindings,
    durationMs,
    modelCalls: modelCallCount,
    finalUrl: ctx.activeUrl,
    runLogPath
  };

  if (!ctx.config.disablePlaybooks && finalStatus === 'DONE') {
    const learned = await learnPlaybookFromRun(goal, ctx, executionResult, knownSecrets).catch(() => null);
    if (learned && ctx.config.verbose) {
      console.log(
        paint(`[Playbook Memory] `, 'purple', true) +
        paint(`💾 Đã ghi nhớ kịch bản "${learned.title}" (${learned.successCount} lần thành công)`, 'green')
      );
    }
  }

  return executionResult;
}
