/** AutoTask Microsoft Word Desktop Automation Bridge
 * Operates the user's real Microsoft Word (`WINWORD.EXE`) to compose structured documents,
 * save them directly as `.docx`, release locks cleanly, and fall back safely when requested.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { createDocument } from '../documents.js';

export interface WordComposeInput {
  title: string;
  content: string;
  outputPath?: string;
  templatePath?: string;
  studentHeader?: string;
  visible?: boolean;
  typeDelayMs?: number;
  keepOpen?: boolean;
  allowFallbackDocx?: boolean;
  strictWordOnly?: boolean;
}

export interface WordComposeResult {
  ok: true;
  usedWordApp: boolean;
  engine: 'microsoft-word-live' | 'python-docx-fallback';
  path: string;
  bytes: number;
  wordCount?: number;
  paragraphCount?: number;
  windowTitle?: string;
  wasAlreadyRunning?: boolean;
  fallbackReason?: string;
}

export interface WordEnvironmentStatus {
  ok: boolean;
  platform: string;
  wordExecutable: string | null;
  wordComRegistered: boolean;
  win32comAvailable: boolean;
  pywinautoAvailable: boolean;
  pythonDocxAvailable: boolean;
}

const BLOCKED_SEGMENTS = new Set(['.private', '.ssh', '.git']);

export function validateWordOutputPath(rawPath?: string): string | undefined {
  if (!rawPath || !rawPath.trim()) return undefined;
  const trimmed = rawPath.trim();
  if (/^[a-zA-Z]+:\/\//.test(trimmed)) {
    throw new Error('URL output path is not allowed for Microsoft Word save');
  }
  const resolved = resolve(trimmed);
  if (extname(resolved).toLowerCase() !== '.docx') {
    throw new Error('Microsoft Word save path must use .docx extension');
  }
  const segs = resolved.split(/[\\/]/).map(s => s.toLowerCase());
  if (segs.some(s => BLOCKED_SEGMENTS.has(s))) {
    throw new Error('Sensitive path segment (.private/.ssh/.git) is not permitted for Word output');
  }
  return resolved;
}

async function runWordWorkerProcess(payload: object, args: string[] = []): Promise<any> {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.env.AUTOTASK_PYTHON || 'python',
      [resolve('desktop/word_worker.py'), ...args],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('Microsoft Word worker timed out'));
    }, 65000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += String(chunk).slice(0, 32000); });
    child.stderr.on('data', chunk => { err += String(chunk).slice(0, 6000); });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        const lastLine = lines[lines.length - 1] || '';
        const parsed = JSON.parse(lastLine);
        if (code !== 0 && !args.includes('--check')) {
          reject(new Error(parsed.error || err || `Word worker exited with code ${code}`));
          return;
        }
        accept(parsed);
      } catch {
        reject(new Error(err || out || `Invalid output from Microsoft Word worker (exit ${code})`));
      }
    });

    if (args.includes('--check')) {
      child.stdin.end();
    } else {
      child.stdin.end(JSON.stringify(payload));
    }
  });
}

export const WordAutomation = {
  async checkAvailability(): Promise<WordEnvironmentStatus> {
    try {
      const res = await runWordWorkerProcess({}, ['--check']);
      return res as WordEnvironmentStatus;
    } catch {
      return {
        ok: false,
        platform: process.platform,
        wordExecutable: null,
        wordComRegistered: false,
        win32comAvailable: false,
        pywinautoAvailable: false,
        pythonDocxAvailable: false
      };
    }
  },

  async compose(input: WordComposeInput): Promise<WordComposeResult> {
    if (!input.content?.trim() || input.content.length > 150000) {
      throw new Error('Nội dung soạn thảo Word không được để trống và tối đa 150.000 ký tự.');
    }

    const safeOutPath = validateWordOutputPath(input.outputPath);
    const safeTemplatePath = validateWordOutputPath(input.templatePath);
    const allowFallback = input.strictWordOnly ? false : (input.allowFallbackDocx !== false);

    try {
      const res = await runWordWorkerProcess({
        title: input.title,
        content: input.content,
        outputPath: safeOutPath,
        templatePath: safeTemplatePath,
        studentHeader: input.studentHeader,
        visible: input.visible !== false,
        typeDelayMs: input.typeDelayMs ?? 4,
        keepOpen: Boolean(input.keepOpen)
      });

      if (!res?.ok || !res.path) {
        throw new Error(res?.error || 'Microsoft Word did not return a saved file path');
      }

      return {
        ok: true,
        usedWordApp: true,
        engine: 'microsoft-word-live',
        path: String(res.path),
        bytes: Number(res.bytes || 0),
        wordCount: typeof res.wordCount === 'number' ? res.wordCount : undefined,
        paragraphCount: typeof res.paragraphCount === 'number' ? res.paragraphCount : undefined,
        windowTitle: typeof res.windowTitle === 'string' ? res.windowTitle : undefined,
        wasAlreadyRunning: Boolean(res.wasAlreadyRunning)
      };
    } catch (wordErr: any) {
      if (!allowFallback) {
        throw wordErr;
      }

      const fallbackReason = String(wordErr?.message || wordErr);
      const docOut = await createDocument({
        title: input.title,
        content: input.content,
        format: 'docx',
        baseName: 'autotask-word-fallback'
      });

      let finalPath = docOut.path;
      if (safeOutPath && resolve(docOut.path) !== safeOutPath) {
        await mkdir(dirname(safeOutPath), { recursive: true });
        await copyFile(docOut.path, safeOutPath);
        await unlink(docOut.path).catch(() => {});
        finalPath = safeOutPath;
      }

      return {
        ok: true,
        usedWordApp: false,
        engine: 'python-docx-fallback',
        path: finalPath,
        bytes: docOut.bytes,
        fallbackReason
      };
    }
  }
};
