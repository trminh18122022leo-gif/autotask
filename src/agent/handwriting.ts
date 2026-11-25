/** Handwritten assignment synthesizer bridge for AutoTask AI. */
import { spawn } from 'node:child_process';
import { extname, resolve } from 'node:path';

export interface HandwritingGenerateInput {
  title: string;
  content: string;
  format?: 'pdf' | 'png' | 'docx';
  outputFormat?: 'pdf' | 'png' | 'docx';
  outputPath?: string;
  samplePath?: string;
  studentHeader?: string;
  paperStyle?: 'lined' | 'grid' | 'blank';
}

export interface HandwritingGenerateResult {
  ok: true;
  success: true;
  path: string;
  bytes: number;
  format: 'pdf' | 'png' | 'docx';
  pages: number;
  inkRgb: [number, number, number];
  usedCustomSample: boolean;
  sampleAnalyzed: boolean;
}

const BLOCKED_SEGMENTS = new Set(['.private', '.ssh', '.git']);

export function validateSafeLocalPath(raw?: string, allowedExts?: Set<string>): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (/^[a-zA-Z]+:\/\//.test(trimmed)) {
    throw new Error('URL path is not permitted for local handwriting file');
  }
  const abs = resolve(trimmed);
  if (allowedExts && !allowedExts.has(extname(abs).toLowerCase())) {
    throw new Error(`Định dạng file không hợp lệ: ${extname(abs)}`);
  }
  const segs = abs.split(/[\\/]/).map(s => s.toLowerCase());
  if (segs.some(s => BLOCKED_SEGMENTS.has(s))) {
    throw new Error('Sensitive path segment (.private/.ssh/.git) is not permitted');
  }
  return abs;
}

export const HandwritingGenerator = {
  async generate(input: HandwritingGenerateInput): Promise<HandwritingGenerateResult> {
    if (!input.content?.trim() || input.content.length > 80000) {
      throw new Error('Nội dung viết tay phải từ 1 đến 80.000 ký tự.');
    }
    const format = input.outputFormat || input.format || 'pdf';
    const fullContent = input.studentHeader?.trim()
      ? `${input.studentHeader.trim()}\n\n${input.content}`
      : input.content;
    const safeSample = validateSafeLocalPath(input.samplePath, new Set(['.png', '.jpg', '.jpeg', '.ttf', '.otf']));
    const safeOut = validateSafeLocalPath(input.outputPath, new Set([`.${format}`]));

    return new Promise((accept, reject) => {
      const child = spawn(
        process.env.AUTOTASK_PYTHON || 'python',
        [resolve('desktop/handwriting_worker.py')],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('Handwriting worker timed out'));
      }, 60000);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', s => { out += String(s).slice(0, 20000); });
      child.stderr.on('data', s => { err += String(s).slice(0, 4000); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          const lines = out.trim().split(/\r?\n/).filter(Boolean);
          const obj = JSON.parse(lines[lines.length - 1] || '');
          if (code !== 0 || !obj.ok) {
            throw new Error(obj.error || err || 'Handwriting worker failed');
          }
          accept({
            ok: true,
            success: true,
            path: String(obj.path),
            bytes: Number(obj.bytes),
            format: obj.format,
            pages: Number(obj.pages || 1),
            inkRgb: obj.inkRgb || [24, 52, 138],
            usedCustomSample: Boolean(obj.usedCustomSample),
            sampleAnalyzed: Boolean(obj.usedCustomSample)
          });
        } catch (e: any) {
          reject(new Error(e?.message || err || 'Invalid handwriting worker output'));
        }
      });

      child.stdin.end(JSON.stringify({
        title: input.title,
        content: fullContent,
        outputFormat: format,
        outputPath: safeOut,
        samplePath: safeSample,
        paperStyle: input.paperStyle || 'lined'
      }));
    });
  }
};
