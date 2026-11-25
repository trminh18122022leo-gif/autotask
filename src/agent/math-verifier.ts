/** Safe Python-backed mathematical & numerical verification helper for AutoTask AI. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const HARD_MATH_PROMPT_RE =
  /\\frac|\\int|\\sum|\\sqrt|\\lim|\\partial|\\nabla|\\infty|\\\(|\\\[|\$\$|\bP\s*\(|\bE\s*\(|\bVar\s*\(|\bCov\s*\(|xác\s*suất|phương\s*sai|độ\s*lệch\s*chuẩn|kỳ\s*vọng|ngẫu\s*nhiên|phân\s*phối|đạo\s*hàm|tích\s*phân|nguyên\s*hàm|vi\s*phân|ma\s*trận|định\s*thức|giới\s*hạn|nghiệm|tổ\s*hợp|chỉnh\s*hợp|hoán\s*vị|chuỗi\s*số|hội\s*tụ|tính\s+giá\s*trị|tối\s*ưu|tựa\s*lồi|tựa\s*lõm|hàm\s*lồi|hàm\s*lõm|tập\s*lồi|tập\s*mức|quy\s*hoạch\s*tuyến\s*tính|đối\s*ngẫu|độ\s*lệch\s*bù|balo|nới\s*lỏng|vận\s*tải|đơn\s*hình|nhân\s*tử|cực\s*trị|cực\s*đại|cực\s*tiểu|trị\s*riêng|vect[oơ]\s*riêng|hạng\s*ma\s*trận|không\s*gian\s*(?:con|vect[oơ])|ánh\s*xạ\s*tuyến\s*tính|bất\s*đẳng\s*thức|chứng\s*minh|phản\s*ví\s*dụ|điều\s*kiện\s*cần|derivative|integral|probability|variance|expectation|eigenvalue|determinant|matrix|taylor|maclaurin|binomial|poisson|normal\s+distribution|bayes|convex|quasiconvex|quasiconcave|duality|linear\s+programming|knapsack|simplex|kkt|kuhn[\s-]*tucker|lagrangian|lagrange|hessian|gradient|weierstrass|counterexample|\bprove\b|[≤≥⊂⊆∈∀∃∑∫∏ℝ²³⁴]|(?:\bx|y)_?[1-9]\b|\bf\s*\(\s*x/i;

/** Detects university-level mathematics, optimization, probability, calculus, algebra, or proof prompts. */
export function isHardMathPrompt(text: string): boolean {
  return Boolean(text && HARD_MATH_PROMPT_RE.test(text));
}

export interface MathCheckInput {
  id: string;
  code: string;
}

export interface MathVerifyItemResult {
  id: string;
  ok: boolean;
  display?: string;
  numeric?: number;
  fraction?: string;
  stdout?: string;
  error?: string;
}

/**
 * Runs AST-sandboxed Python expressions (`desktop/math_verify_worker.py`) to compute
 * exact fractions, calculus, probability, or floating-point results locally.
 */
export async function verifyMathExpressionsWithPython(
  items: MathCheckInput[],
  timeoutMs = 15000
): Promise<Map<string, MathVerifyItemResult>> {
  const out = new Map<string, MathVerifyItemResult>();
  const validItems = items
    .map(it => ({ id: String(it.id || '').trim(), code: String(it.code || '').trim() }))
    .filter(it => it.id && it.code);

  if (validItems.length === 0) return out;

  const scriptPath = resolve(process.cwd(), 'desktop', 'math_verify_worker.py');
  if (!existsSync(scriptPath)) return out;

  const pythonCmd = process.env.AUTOTASK_PYTHON || 'python';
  const payload = JSON.stringify({ items: validItems });

  const rawStdout = await new Promise<string>((resolvePromise) => {
    let stdout = '';
    let settled = false;
    const finish = (txt: string) => {
      if (!settled) {
        settled = true;
        resolvePromise(txt);
      }
    };

    try {
      const child = spawn(pythonCmd, [scriptPath], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish('');
      }, Math.max(1000, Math.min(timeoutMs, 25000)));

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', chunk => {
        if (stdout.length < 100_000) stdout += String(chunk);
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(stdout);
      });

      child.stdin?.write(payload, 'utf8');
      child.stdin?.end();
    } catch {
      finish('');
    }
  });

  if (!rawStdout.trim()) return out;

  try {
    const parsed = JSON.parse(rawStdout) as { ok?: boolean; results?: MathVerifyItemResult[] };
    if (parsed?.ok && Array.isArray(parsed.results)) {
      for (const res of parsed.results) {
        if (res && typeof res.id === 'string') {
          out.set(res.id, res);
        }
      }
    }
  } catch {
    // Graceful fallback if worker output is malformed
  }

  return out;
}

/**
 * Parses a numeric value from a candidate text / fraction (e.g. "3/4", "0,75", "x = 2.5%")
 * and checks whether it closely matches Python's verified numeric output.
 */
export function doesCandidateMatchVerifiedNumber(
  candidateText: string | undefined,
  verifiedNumeric: number | undefined,
  toleranceRatio = 0.01
): boolean | undefined {
  if (!candidateText || verifiedNumeric === undefined || !Number.isFinite(verifiedNumeric)) {
    return undefined;
  }
  const clean = candidateText.replace(/\u2212/g, '-').trim();
  const fracMatch = clean.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  const nums: number[] = [];

  if (fracMatch) {
    const denom = Number(fracMatch[2]);
    if (denom > 0) nums.push(Number(fracMatch[1]) / denom);
  }
  const normalizedNumText = clean.replace(/(\d),(\d)/g, '$1.$2');
  for (const m of normalizedNumText.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const val = Number(m[0]);
    if (Number.isFinite(val)) nums.push(val);
  }
  if (nums.length === 0) return undefined;

  const isPercent = clean.includes('%');
  const absTol = Math.max(1e-4, Math.abs(verifiedNumeric) * toleranceRatio);
  return nums.some(n => {
    const cmp = isPercent ? n / 100 : n;
    return Math.abs(cmp - verifiedNumeric) <= absTol || Math.abs(n - verifiedNumeric) <= absTol;
  });
}
