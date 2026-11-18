/** Tokyo Night / Cyberpunk terminal renderer: no external UI dependencies. */
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { COLORS, theme } from './themes.js';

export type Tone = keyof typeof COLORS['tokyo-night'];
export const palette = COLORS['tokyo-night'];

export function colorEnabled(): boolean {
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  return Boolean(process.stdout.isTTY || (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'));
}

export function paint(s: unknown, tone: Tone, bold = false): string {
  const text = String(s);
  if (!colorEnabled()) return text;
  const currentTheme = theme().theme;
  const c = COLORS[currentTheme][tone].replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
  return `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export const width = () => Math.max(40, Math.min(108, (process.stdout.columns || 88) - 2));
export const plain = (x: string) => stripVTControlCharacters(x);

/** Calculates visible character width handling Unicode and Vietnamese characters cleanly */
export function stringWidth(text: string): number {
  const clean = plain(text);
  let w = 0;
  for (const char of clean) {
    const code = char.codePointAt(0) || 0;
    // Zero-width combining marks
    if (code >= 0x0300 && code <= 0x036f) continue;
    // Fullwidth / Wide characters (CJK, emojis)
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export function clip(text: string, size: number): string {
  const chars = Array.from(plain(text));
  if (stringWidth(text) <= size) return text;
  let cur = '';
  for (const ch of chars) {
    if (stringWidth(cur + ch + '…') > size) break;
    cur += ch;
  }
  return cur + '…';
}

const fill = (s: string, n: number) => s.repeat(Math.max(0, n));

export function rule(label = ''): string {
  const available = width();
  const left = label ? `── ${label} ` : '';
  const leftLen = stringWidth(left);
  return paint(left + fill('─', Math.max(0, available - leftLen)), 'border');
}

export function header(section = 'CONTROL CENTER'): void {
  console.log('');
  const w = width();
  console.log(paint('╭' + fill('─', w - 2) + '╮', 'violet'));
  const lines: [string, Tone, boolean][] = [
    ['✦  A U T O T A S K   A I  ✦', 'purple', true],
    [`${theme().theme.toUpperCase().replace('-', ' ')}  /  ${section}`, 'cyan', false]
  ];
  for (const [content, tone, bold] of lines) {
    const pad = Math.max(0, w - 4 - stringWidth(content));
    console.log(paint('│ ', 'violet') + paint(content, tone, bold) + fill(' ', pad) + paint(' │', 'violet'));
  }
  console.log(paint('╰' + fill('─', w - 2) + '╯', 'violet'));
  console.log(
    paint(
      theme().theme === 'tokyo-night'
        ? '    ⋆｡˚  local-first computer-use agent  ─  夜空'
        : '    ◈  local-first computer-use agent  ─  NEON CITY',
      'muted'
    )
  );
}

/** Render navigation breadcrumbs e.g. COMMAND DECK › MODEL CENTER › MY MODELS */
export function renderBreadcrumb(crumbs: string[]): void {
  const formatted = crumbs.map((c, i) => (i === crumbs.length - 1 ? paint(c, 'cyan', true) : paint(c, 'muted'))).join(paint(' › ', 'purple'));
  console.log(paint('  📍 ', 'purple') + formatted);
}

/** Status bar showing system state */
export function renderStatusBar(left: string, right: string): void {
  const w = width() - 4;
  const leftLen = stringWidth(left);
  const rightLen = stringWidth(right);
  const space = Math.max(2, w - leftLen - rightLen);
  console.log(paint('  [' + left + fill(' ', space) + right + ']', 'muted'));
}

export function section(label: string): void {
  console.log('\n' + paint('◆ ', 'purple') + paint(label.toUpperCase(), 'cyan', true));
  console.log(rule());
}

export function hint(text: string): void {
  console.log(paint('  ◦  ' + text, 'muted'));
}

export function info(text: string): void {
  console.log(paint('  ◇ ', 'cyan') + paint(text, 'fg'));
}

export function success(text: string): void {
  console.log(paint('  ✓ ', 'green') + paint(text, 'fg'));
}

export function warn(text: string): void {
  console.log(paint('  ⚠ ', 'orange') + paint(text, 'fg'));
}

export function fail(text: string): void {
  console.log(paint('  ✕ ', 'red') + paint(text, 'fg'));
}

export function toast(type: 'info' | 'success' | 'warn' | 'error', message: string): void {
  const icons = { info: '◇', success: '✓', warn: '⚠', error: '✕' };
  const tones: Record<string, Tone> = { info: 'cyan', success: 'green', warn: 'orange', error: 'red' };
  const tone = tones[type] || 'fg';
  const prefix = `  ┌─ [ ${icons[type]} ${type.toUpperCase()} ] `;
  const boxW = Math.max(width() - 4, stringWidth(message) + 12);
  const topPad = fill('─', Math.max(0, boxW - stringWidth(prefix) - 1));
  console.log(paint(prefix + topPad + '┐', tone));
  console.log(paint('  │ ', tone) + paint(message, 'fg') + fill(' ', Math.max(0, boxW - stringWidth(message) - 5)) + paint(' │', tone));
  console.log(paint('  └' + fill('─', boxW - 2) + '┘', tone));
}

export function renderErrorCard(title: string, message: string, suggestion?: string): void {
  const w = width();
  console.log('\n' + paint('╭─ ✕ ERROR: ' + title + fill('─', Math.max(0, w - 13 - stringWidth(title))) + '╮', 'red'));
  console.log(paint('│ ', 'red') + paint(message, 'fg'));
  if (suggestion) {
    console.log(paint('│ ', 'red') + paint('👉 Khắc phục: ' + suggestion, 'yellow'));
  }
  console.log(paint('╰' + fill('─', w - 2) + '╯', 'red'));
}

export function step(label: string, current: number, total: number): void {
  renderProgressBar(label, current, total);
}

export function renderProgressBar(label: string, current: number, total: number, suffix = ''): void {
  const percent = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const barLen = Math.min(24, Math.max(12, Math.floor(width() / 4)));
  const done = Math.round(barLen * percent);
  const pctStr = `${Math.round(percent * 100)}%`.padStart(4);
  const extra = suffix ? `  ${suffix}` : '';
  console.log(
    paint('  ↳ ', 'purple') +
      paint(clip(label, 22).padEnd(23), 'fg') +
      ' ' +
      paint('━'.repeat(done), 'purple') +
      paint('─'.repeat(barLen - done), 'border') +
      paint(` ${pctStr}`, 'cyan') +
      paint(extra, 'muted')
  );
}

export function entry(key: string, value: string, tone: Tone = 'fg'): void {
  const keyCol = 24;
  const valCol = Math.max(18, width() - keyCol - 4);
  const cleanKey = clip(key, keyCol - 2);
  const pad = Math.max(1, keyCol - stringWidth(cleanKey));
  console.log(paint('  ' + cleanKey + fill(' ', pad), 'muted') + paint(clip(value, valCol), tone));
}

export function choice(key: string, label: string, description = ''): void {
  console.log(paint(`  [${key}] `, 'purple', true) + paint(label, 'fg', true) + (description ? paint('   ' + description, 'muted') : ''));
}

export function pill(status: string): string {
  const t = status.toUpperCase();
  const tone: Tone = /COMPLETED|SUBMITTED|READY|PASS|SUCCESS|VERIFIED/.test(t)
    ? 'green'
    : /ERROR|FAILED|CANCEL/.test(t)
    ? 'red'
    : /REVIEW|PARTIAL|WARNING|UNCONFIRMED|WARN/.test(t)
    ? 'orange'
    : t === 'RUNNING'
    ? 'cyan'
    : 'purple';
  return paint(`● ${status}`, tone, true);
}

export function row(cols: string[], sizes: number[]): void {
  let line = '  ';
  cols.forEach((c, i) => {
    const size = sizes[i] || 15;
    const str = clip(c, size);
    const pad = Math.max(0, size - stringWidth(str));
    line += str + fill(' ', pad) + ' ';
  });
  console.log(line);
}

/** Render a structured colored table with borders */
export function renderTable(
  headers: string[],
  rows: (string | number)[][],
  alignments: ('left' | 'right' | 'center')[] = []
): void {
  if (!headers.length) return;
  const colWidths = headers.map((h, i) => {
    let max = stringWidth(h);
    for (const r of rows) {
      const val = String(r[i] !== undefined ? r[i] : '');
      const len = stringWidth(val);
      if (len > max) max = len;
    }
    return Math.min(36, Math.max(6, max + 2));
  });

  const top = '  ┌' + colWidths.map(w => fill('─', w)).join('┬') + '┐';
  const mid = '  ├' + colWidths.map(w => fill('─', w)).join('┼') + '┤';
  const bot = '  └' + colWidths.map(w => fill('─', w)).join('┴') + '┘';

  console.log(paint(top, 'border'));
  // Headers
  let headerLine = '  │';
  headers.forEach((h, i) => {
    const w = colWidths[i];
    const pad = Math.max(0, w - stringWidth(h) - 1);
    headerLine += ' ' + paint(h, 'cyan', true) + fill(' ', pad) + paint('│', 'border');
  });
  console.log(headerLine);
  console.log(paint(mid, 'border'));

  // Rows
  if (!rows.length) {
    const totalW = colWidths.reduce((a, b) => a + b, 0) + colWidths.length - 1;
    const emptyText = 'Không có dữ liệu';
    const pad = Math.max(0, totalW - stringWidth(emptyText) - 2);
    console.log(paint('  │ ', 'border') + paint(emptyText, 'muted') + fill(' ', pad) + paint(' │', 'border'));
  } else {
    rows.forEach((r, rowIdx) => {
      let rLine = '  │';
      r.forEach((cell, i) => {
        const val = String(cell !== undefined ? cell : '');
        const w = colWidths[i];
        const align = alignments[i] || 'left';
        const str = clip(val, w - 2);
        const padTotal = Math.max(0, w - stringWidth(str) - 1);
        let formatted = '';
        if (align === 'right') {
          formatted = fill(' ', padTotal) + str + ' ';
        } else if (align === 'center') {
          const lPad = Math.floor(padTotal / 2);
          const rPad = padTotal - lPad;
          formatted = fill(' ', lPad) + str + fill(' ', rPad) + ' ';
        } else {
          formatted = ' ' + str + fill(' ', padTotal);
        }
        rLine += formatted + paint('│', 'border');
      });
      console.log(rLine);
    });
  }
  console.log(paint(bot, 'border'));
}

/** Animated terminal spinner for async tasks */
export async function withSpinner<T>(label: string, action: () => Promise<T>): Promise<T> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  if (!process.stdout.isTTY || !theme().animations) {
    info(label + '...');
    return await action();
  }
  process.stdout.write('\x1b[?25l'); // hide cursor
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${paint(frames[i++ % frames.length], 'purple')} ${paint(label, 'fg')}`);
  }, 80);
  try {
    const res = await action();
    clearInterval(timer);
    process.stdout.write(`\r  ${paint('✓', 'green')} ${paint(label, 'fg')}\n`);
    return res;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r  ${paint('✕', 'red')} ${paint(label, 'fg')}\n`);
    throw e;
  } finally {
    process.stdout.write('\x1b[?25h'); // restore cursor
  }
}

/** Brief stylish boot animation */
export async function introAnimation(forceSkip = false): Promise<void> {
  if (forceSkip || !theme().animations || !process.stdout.isTTY) return;
  const banner = [
    ' █▀█ █ █ ▀█▀ █▀█ ▀█▀ █▀█ █▀▀ █ █   █▀█ █',
    ' █▀█ █ █  █  █ █  █  █▀█ ▄▄█ █▀▄   █▀█ █',
    ' ▀ ▀ ▀▀▀  ▀  ▀▀▀  ▀  ▀ ▀ ▀▀▀ ▀ ▀   ▀ ▀ ▀'
  ];
  console.clear();
  console.log('');
  for (const line of banner) {
    console.log(paint('  ' + line, 'purple', true));
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(paint('   ─── [ TERMINAL WORKSTATION // ONLINE ] ───', 'cyan'));
  await new Promise(r => setTimeout(r, 200));
}

/** Sets up clean exit listeners to restore terminal state and cursor */
let cleanupRegistered = false;
export function setupTerminalCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const restore = () => {
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h'); // show cursor
      }
      if (process.stdin.setRawMode && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch {}
  };
  process.on('SIGINT', () => {
    restore();
    console.log('\n' + paint('  [Ctrl+C] AutoTask AI interrupted.', 'orange'));
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    restore();
    process.exit(0);
  });
  process.on('exit', () => restore());
}

export function close(text = 'READY FOR NEXT COMMAND'): void {
  console.log('\n' + rule());
  console.log(
    paint(
      '  ✧ ' + text + '   ·   ' + (theme().theme === 'tokyo-night' ? '夜空 / Tokyo Night' : 'Neon City / Cyberpunk'),
      'purple'
    )
  );
}

export function preview(): void {
  header();
  section('System overview');
  entry('WORKSPACE', 'LOCAL · WINDOWS FIRST', 'aqua');
  entry('MODEL PROFILE', 'Not configured', 'orange');
  entry('ACTIVE TASKS', '0 queued  /  0 running', 'cyan');
  section('Navigation');
  choice('1', 'Computer Use', 'Desktop orchestration');
  choice('2', 'Browser Tasks', 'Forms and allowed practice');
  choice('3', 'Model Vault', 'BYOK credentials');
  choice('4', 'Setup', 'Generate your configuration');
  choice('5', 'Task History', 'Local queue & reports');
  choice('0', 'Exit');
  section('Live activity');
  step('Ready to initialize', 0, 10);
  success('Terminal skin initialized');
  hint('The preview uses display placeholders only; no jobs or profiles are created.');
  close();
}
