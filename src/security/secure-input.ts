/** Secure secret input for terminal workstations.
 * Suppresses plaintext echo, supports masking, handles Backspace/Ctrl+C gracefully,
 * and restores terminal state. Strictly validates non-TTY environments.
 */
import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface SecretInputOptions {
  maskChar?: string; // Default: '*' or '' for complete silence
  allowEmpty?: boolean;
  timeoutMs?: number;
  input?: Readable;
  output?: Writable;
  allowNonTty?: boolean;
}

/** Prompts for a secret in terminal with no plaintext echo */
export async function promptSecret(
  promptText: string,
  options: SecretInputOptions = {}
): Promise<string> {
  const mask = options.maskChar !== undefined ? options.maskChar : '*';
  const allowEmpty = options.allowEmpty ?? false;
  const inStream = options.input || process.stdin;
  const outStream = options.output || process.stdout;
  const timeoutMs = options.timeoutMs ?? 30000;

  const isTTY = Boolean((inStream as any).isTTY && (inStream as any).setRawMode);

  // Non-TTY handling: Strictly validate input stream without hanging
  if (!isTTY) {
    if (!options.input && !process.env.AUTOTASK_ALLOW_NON_TTY_INPUT && !options.allowNonTty) {
      throw new Error(
        'Môi trường Terminal không hỗ trợ TTY tương tác để nhập secret an toàn. Hãy chạy trong Windows Terminal hoặc sử dụng OS Credential Vault (npm run models).'
      );
    }
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        inStream.removeListener('data', onData);
        inStream.removeListener('end', onEnd);
        inStream.removeListener('error', onError);
      };

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        // If newline received in stream, process immediately
        if (buffer.includes('\n') || buffer.includes('\r')) {
          cleanup();
          const clean = buffer.replace(/[\r\n]/g, '').trim();
          if (!clean && !allowEmpty) {
            reject(new Error('Non-TTY secret input is empty. Secure credential required.'));
          } else {
            resolve(clean);
          }
        }
      };

      const onEnd = () => {
        cleanup();
        const secret = buffer.replace(/[\r\n]/g, '').trim();
        if (!secret && !allowEmpty) {
          reject(new Error('Non-TTY secret input is empty. Secure credential required.'));
        } else {
          resolve(secret);
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Non-TTY secret input timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      inStream.on('data', onData);
      inStream.on('end', onEnd);
      inStream.on('error', onError);
      if (typeof (inStream as any).resume === 'function') {
        (inStream as any).resume();
      }
    });
  }

  // TTY handling: Raw mode with keystroke interception
  return new Promise<string>((resolve, reject) => {
    let input = '';
    const wasRaw = (inStream as any).isRaw || false;

    outStream.write(promptText);

    const cleanup = () => {
      try {
        inStream.removeListener('keypress', onKeyPress);
        if ((inStream as any).setRawMode) {
          (inStream as any).setRawMode(wasRaw);
        }
        outStream.write('\x1b[?25h'); // Ensure cursor is visible
      } catch {}
    };

    const onKeyPress = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      // Ctrl+C handling: Restore terminal and abort safely
      if (key && key.ctrl && key.name === 'c') {
        cleanup();
        outStream.write('\n');
        process.kill(process.pid, 'SIGINT');
        reject(new Error('User interrupted input with Ctrl+C'));
        return;
      }

      // Enter / Return handling
      if (key && (key.name === 'return' || key.name === 'enter')) {
        cleanup();
        outStream.write('\n');
        if (!input && !allowEmpty) {
          reject(new Error('Secret cannot be empty'));
        } else {
          resolve(input);
        }
        return;
      }

      // Backspace handling
      if (key && (key.name === 'backspace' || key.sequence === '\b' || key.sequence === '\x7f')) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          if (mask) {
            outStream.write('\b \b');
          }
        }
        return;
      }

      // Ignore special navigation keys (arrows, tab, esc)
      if (key && (key.name === 'tab' || key.name === 'escape' || key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right')) {
        return;
      }

      // Normal characters & pasted strings
      if (str) {
        input += str;
        if (mask) {
          outStream.write(mask.repeat(str.length));
        }
      }
    };

    emitKeypressEvents(inStream as any);
    (inStream as any).setRawMode(true);
    if (typeof (inStream as any).resume === 'function') {
      (inStream as any).resume();
    }
    inStream.on('keypress', onKeyPress);
  });
}
