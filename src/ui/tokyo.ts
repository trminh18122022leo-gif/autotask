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

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return [187, 154, 247];
  const n = Number.parseInt(clean, 16);
  if (!Number.isFinite(n)) return [187, 154, 247];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 24-bit TrueColor multi-stop horizontal gradient; degrades cleanly to plain text when color is disabled */
export function gradientText(text: unknown, hexStops?: string[], bold = false): string {
  const raw = String(text ?? '');
  if (!raw || !colorEnabled()) return raw;

  const stops = (
    hexStops && hexStops.length >= 2
      ? hexStops
      : theme().theme === 'cyberpunk'
        ? ['#00f5ff', '#a855f7', '#fcee0a']
        : ['#7dcfff', '#bb9af7', '#7aa2f7']
  ).map(parseHexRgb);

  const chars = [...raw];
  const nonSpaceIndices: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ' && chars[i] !== '\n' && chars[i] !== '\r') {
      nonSpaceIndices.push(i);
    }
  }
  if (nonSpaceIndices.length === 0) return raw;

  const prefix = bold ? '\x1b[1m' : '';
  const total = Math.max(1, nonSpaceIndices.length - 1);
  let visibleIdx = 0;
  let out = '';

  for (const ch of chars) {
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      out += ch;
      continue;
    }
    const t = nonSpaceIndices.length === 1 ? 0 : visibleIdx / total;
    visibleIdx++;
    const scaled = t * (stops.length - 1);
    const seg = Math.min(stops.length - 2, Math.floor(scaled));
    const localT = scaled - seg;
    const [r1, g1, b1] = stops[seg];
    const [r2, g2, b2] = stops[seg + 1];
    const r = Math.round(r1 + (r2 - r1) * localT);
    const g = Math.round(g1 + (g2 - g1) * localT);
    const b = Math.round(b1 + (b2 - b1) * localT);
    out += `${prefix}\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
  }
  return out;
}

/** Highlighted badge tag for terminal HUD metrics and status flags */
export function badge(label: string, tone: Tone | 'cyber' = 'purple'): string {
  if (!colorEnabled()) return `[${label}]`;
  const chipColors: Record<string, [number, number, number, number, number, number]> = {
    purple: [45, 34, 72, 187, 154, 247],
    violet: [41, 31, 66, 157, 124, 216],
    cyan: [22, 46, 62, 125, 207, 255],
    green: [24, 52, 40, 158, 206, 106],
    yellow: [58, 46, 26, 224, 175, 104],
    red: [62, 26, 36, 247, 118, 142],
    blue: [26, 40, 68, 122, 162, 247],
    muted: [36, 40, 59, 169, 177, 214],
    fg: [41, 46, 66, 192, 202, 245],
    cyber: [14, 48, 56, 0, 245, 255]
  };
  const [br, bg, bb, fr, fg, fb] = chipColors[tone] || chipColors.purple;
  return `\x1b[1m\x1b[48;2;${br};${bg};${bb}m\x1b[38;2;${fr};${fg};${fb}m ${label} \x1b[0m`;
}

/** Visual load / quota utilization meter bar with dynamic threshold colors */
export function renderMeterBar(used: number, max: number, length = 14): string {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const ratio = Math.max(0, Math.min(1, safeUsed / safeMax));
  const filledCount = Math.round(ratio * length);
  const emptyCount = Math.max(0, length - filledCount);
  const barTone: Tone = ratio >= 0.85 ? 'red' : ratio >= 0.55 ? 'yellow' : 'green';
  const pct = `${Math.round(ratio * 100)}%`;
  const filled = filledCount > 0 ? paint('█'.repeat(filledCount), barTone) : '';
  const empty = emptyCount > 0 ? paint('░'.repeat(emptyCount), 'muted') : '';
  return `${filled}${empty} ${paint(pct, barTone, true)}`;
}

/** Unicode telemetry sparkline for latency / RPM series */
export function renderSparkline(values: number[]): string {
  if (!values || values.length === 0) return paint('───', 'muted');
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const clean = values.map(v => (Number.isFinite(v) && v >= 0 ? v : 0));
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const chars = clean.map(v => {
    if (max === min) return max === 0 ? blocks[0] : blocks[3];
    const norm = (v - min) / (max - min);
    const idx = Math.min(blocks.length - 1, Math.max(0, Math.round(norm * (blocks.length - 1))));
    return blocks[idx];
  }).join('');
  return colorEnabled() ? gradientText(chars) : chars;
}

/** Framed HUD panel box with optional right-aligned status tag */
export function renderPanelBox(
  title: string,
  lines: string[],
  tone: Tone = 'purple',
  rightTag?: string
): void {
  const w = width();
  const innerW = Math.max(24, w - 4);
  const titleRendered = ` ${paint(title, 'cyan', true)} `;
  const rightRendered = rightTag ? ` ${paint(rightTag, tone, true)} ` : '';
  const usedCols = 2 + stringWidth(titleRendered) + stringWidth(rightRendered) + 1;
  const midDashes = Math.max(1, w - usedCols);
  console.log(
    paint('╭─', tone) +
    titleRendered +
    paint(fill('─', midDashes), tone) +
    rightRendered +
    paint('╮', tone)
  );
  for (const line of lines) {
    const pad = Math.max(0, innerW - stringWidth(line));
    console.log(paint('│ ', tone) + line + fill(' ', pad) + paint(' │', tone));
  }
  console.log(paint('╰' + fill('─', w - 2) + '╯', tone));
}

export function header(section = 'CONTROL CENTER'): void {
  console.log('');
  const w = width();
  const isCyber = theme().theme === 'cyberpunk';
  const borderTone: Tone = isCyber ? 'cyan' : 'violet';
  const badgeText = isCyber ? 'CYBERPUNK // GRID' : 'TOKYO NIGHT // OS';
  const logoPlain = '✦  A U T O T A S K   A I  ✦';
  const logoRendered = gradientText(logoPlain, undefined, true);
  const rightBadge = badge(badgeText, isCyber ? 'cyber' : 'purple');

  console.log(gradientText('╭' + fill('━', w - 2) + '╮'));

  const row1Space = Math.max(1, w - 4 - stringWidth(logoPlain) - stringWidth(rightBadge));
  console.log(
    paint('┃ ', borderTone) +
    logoRendered +
    fill(' ', row1Space) +
    rightBadge +
    paint(' ┃', borderTone)
  );

  const subPlain = `${theme().theme.toUpperCase().replace('-', ' ')}  //  ${section}`;
  const row2Pad = Math.max(0, w - 4 - stringWidth(subPlain));
  console.log(
    paint('┃ ', borderTone) +
    paint(subPlain, 'cyan', true) +
    fill(' ', row2Pad) +
    paint(' ┃', borderTone)
  );

  console.log(gradientText('╰' + fill('━', w - 2) + '╯'));
  console.log(
    paint(
      isCyber
        ? '    ◈  autonomous cyber workstation  ─  NEON CITY // KEY-POOL ACTIVE'
        : '    ⋆｡˚  local-first autonomous agent  ─  夜空 // KEY-POOL ACTIVE',
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
  const naturalWidths = headers.map((h, i) => {
    let max = stringWidth(h);
    for (const r of rows) {
      const val = String(r[i] !== undefined ? r[i] : '');
      const len = stringWidth(val);
      if (len > max) max = len;
    }
    return Math.max(6, max + 2);
  });
  const colWidths = naturalWidths.map(nw => Math.min(36, nw));
  const tableChromeW = 4 + colWidths.length;
  const currentSumW = colWidths.reduce((a, b) => a + b, 0);
  if (width() - tableChromeW > currentSumW) {
    let expandIdx = -1;
    let maxNeed = 0;
    for (let i = 0; i < headers.length; i++) {
      const need = naturalWidths[i] - colWidths[i];
      if (need > maxNeed || (need > 0 && i === headers.length - 1)) {
        maxNeed = need;
        expandIdx = i;
      }
    }
    if (expandIdx >= 0) {
      const fixedOtherColsWidth = currentSumW - colWidths[expandIdx] + tableChromeW;
      const maxAllowed = Math.max(36, Math.min(58, width() - fixedOtherColsWidth));
      colWidths[expandIdx] = Math.min(maxAllowed, naturalWidths[expandIdx]);
    }
  }

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

/** Animated terminal spinner with live elapsed seconds for async tasks */
export async function withSpinner<T>(label: string, action: () => Promise<T>): Promise<T> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  if (!process.stdout.isTTY || !theme().animations) {
    info(label + '...');
    return await action();
  }
  const startedAt = Date.now();
  const spinnerTone: Tone = theme().theme === 'cyberpunk' ? 'cyan' : 'purple';
  process.stdout.write('\x1b[?25l'); // hide cursor
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const frame = paint(frames[i++ % frames.length], spinnerTone, true);
    process.stdout.write(`\r  ${frame} ${paint(label, 'fg')} ${paint(`(${elapsed}s)`, 'muted')}  `);
  }, 80);
  try {
    const res = await action();
    clearInterval(timer);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\r  ${paint('✓', 'green', true)} ${paint(label, 'fg')} ${paint(`(${totalSec}s)`, 'muted')}   \n`);
    return res;
  } catch (e) {
    clearInterval(timer);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\r  ${paint('✖', 'red', true)} ${paint(label, 'fg')} ${paint(`(${totalSec}s)`, 'muted')}   \n`);
    throw e;
  } finally {
    process.stdout.write('\x1b[?25h'); // restore cursor
  }
}

/** Brief stylish scanline-gradient boot animation (strictly TTY + interactive only) */
export async function introAnimation(forceSkip = false): Promise<void> {
  if (forceSkip || !theme().animations || !process.stdout.isTTY || !process.stdin.isTTY) return;
  const banner = [
    ' █████╗ ██╗   ██╗████████╗ ██████╗ ████████╗ █████╗ ███████╗██╗  ██╗',
    '██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝',
    '███████║██║   ██║   ██║   ██║   ██║   ██║   ███████║███████╗█████╔╝ ',
    '██╔══██║██║   ██║   ██║   ██║   ██║   ██║   ██╔══██║╚════██║██╔═██╗ ',
    '██║  ██║╚██████╔╝   ██║   ╚██████╔╝   ██║   ██║  ██║███████║██║  ██╗',
    '╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝'
  ];
  console.clear();
  console.log('');
  for (const line of banner) {
    console.log('  ' + gradientText(line, undefined, true));
    await new Promise(r => setTimeout(r, 38));
  }
  const stages = [
    ['[BOOT] Neural Router', 35],
    ['[SYNC] Multi-Key Pool', 70],
    ['[LINK] Playwright Grid', 100]
  ] as const;
  for (const [stageLabel, pct] of stages) {
    const bar = renderMeterBar(pct, 100, 18);
    process.stdout.write(`\r  ${paint('◈', 'cyan', true)} ${paint(stageLabel.padEnd(23), 'fg')} ${bar}  `);
    await new Promise(r => setTimeout(r, 65));
  }
  process.stdout.write('\n');
  console.log(gradientText('  ─── [ AUTONOMOUS WORKSTATION // ONLINE ] ───', undefined, true));
  await new Promise(r => setTimeout(r, 90));
}

/** Sets up clean exit listeners to restore terminal state and cursor */
let cleanupRegistered = false;
const exitCleanupHooks: Array<() => Promise<void> | void> = [];

export function registerExitCleanup(fn: () => Promise<void> | void): void {
  if (!exitCleanupHooks.includes(fn)) {
    exitCleanupHooks.push(fn);
  }
}

export function setupTerminalCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  let cleaningUp = false;
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
  const runHooksAndExit = async (msg?: string) => {
    if (cleaningUp) process.exit(0);
    cleaningUp = true;
    restore();
    if (msg) console.log('\n' + paint(msg, 'orange'));
    try {
      await Promise.race([
        Promise.allSettled(exitCleanupHooks.map(fn => Promise.resolve().then(() => fn()))),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    } catch {}
    restore();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void runHooksAndExit('  [Ctrl+C] AutoTask AI interrupted.');
  });
  process.on('SIGTERM', () => {
    void runHooksAndExit();
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
