/** Tokyo Night / Cyberpunk terminal renderer: 24-bit TrueColor HUD, gradients & animations (zero external dependencies). */
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { COLORS, theme, type ThemeName } from './themes.js';

export type Tone = keyof typeof COLORS['tokyo-night'];
export const palette = COLORS['tokyo-night'];

export function colorEnabled(): boolean {
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  return Boolean(process.stdout.isTTY || (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'));
}

export function isAnimationsEnabled(): boolean {
  return Boolean(theme().animations !== false && process.stdout.isTTY && process.stdin.isTTY && colorEnabled());
}

export function paint(s: unknown, tone: Tone, bold = false): string {
  const text = String(s);
  if (!colorEnabled()) return text;
  const currentTheme = theme().theme;
  const c = COLORS[currentTheme][tone].replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
  return `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function paintBg(s: unknown, bgHex: string, fgHex = '#f2eaff', bold = false): string {
  const text = String(s);
  if (!colorEnabled()) return text;
  const [br, bg, bb] = parseHexRgb(bgHex);
  const [fr, fg, fb] = parseHexRgb(fgHex);
  return `\x1b[${bold ? '1;' : ''}48;2;${br};${bg};${bb}m\x1b[38;2;${fr};${fg};${fb}m${text}\x1b[0m`;
}

export const width = () => Math.max(44, Math.min(112, (process.stdout.columns || 92) - 2));
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

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return [187, 154, 247];
  const n = Number.parseInt(clean, 16);
  if (!Number.isFinite(n)) return [187, 154, 247];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function gradientStopsForTheme(variant: 'primary' | 'success' | 'warn' | 'danger' = 'primary'): string[] {
  const isCyber = theme().theme === 'cyberpunk';
  if (variant === 'success') return isCyber ? ['#00f5ff', '#73daca', '#fcee0a'] : ['#73daca', '#7dcfff', '#7aa2f7'];
  if (variant === 'warn') return isCyber ? ['#fcee0a', '#ff9e64', '#ff2bd6'] : ['#e0af68', '#ff9e64', '#bb9af7'];
  if (variant === 'danger') return ['#f7768e', '#ff2a5f', '#ff9e64'];
  return isCyber ? ['#00f5ff', '#a855f7', '#ff2bd6', '#fcee0a'] : ['#7dcfff', '#bb9af7', '#7aa2f7', '#73daca'];
}

/** 24-bit TrueColor multi-stop horizontal gradient with optional wave phase offset; degrades cleanly to plain text */
export function gradientText(text: unknown, hexStops?: string[], bold = false, phaseShift = 0): string {
  const raw = String(text ?? '');
  if (!raw || !colorEnabled()) return raw;

  const stops = (
    hexStops && hexStops.length >= 2
      ? hexStops
      : gradientStopsForTheme('primary')
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
    const baseT = nonSpaceIndices.length === 1 ? 0 : visibleIdx / total;
    visibleIdx++;
    // Apply seamless cyclic phase shift when animating shimmer waves
    const shifted = phaseShift !== 0 ? ((baseT + phaseShift) % 1 + 1) % 1 : baseT;
    const t = phaseShift !== 0 ? (shifted <= 0.5 ? shifted * 2 : (1 - shifted) * 2) : shifted;
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

export function rule(label = ''): string {
  const available = width();
  const left = label ? `── ${label} ` : '';
  const leftLen = stringWidth(left);
  const line = left + fill('─', Math.max(0, available - leftLen));
  return colorEnabled() ? gradientText(line, [COLORS[theme().theme].border, COLORS[theme().theme].purple, COLORS[theme().theme].border]) : line;
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

/** Renders crisp color palette swatches for Theme Studio & theme switching feedback */
export function renderThemeSwatches(themeName: ThemeName = theme().theme): string {
  const c = COLORS[themeName];
  if (!colorEnabled()) {
    return `[${c.midnight}|${c.purple}|${c.cyan}|${c.green}]`;
  }
  const tones = [c.midnight, c.panel, c.purple, c.violet, c.cyan, c.green, c.yellow, c.red];
  return tones
    .map(hex => {
      const [r, g, b] = parseHexRgb(hex);
      return `\x1b[38;2;${r};${g};${b}m██\x1b[0m`;
    })
    .join(' ');
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

/** Framed HUD panel box with optional right-aligned status tag and gradient border chrome */
export function renderPanelBox(
  title: string,
  lines: string[],
  tone: Tone = 'purple',
  rightTag?: string
): void {
  const w = width();
  const innerW = Math.max(24, w - 4);
  const titleRendered = ` ${paint('◈ ' + title, 'cyan', true)} `;
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
  for (const rawLine of lines) {
    const line = stringWidth(rawLine) > innerW ? clip(rawLine, innerW) : rawLine;
    const pad = Math.max(0, innerW - stringWidth(line));
    console.log(paint('│ ', tone) + line + fill(' ', pad) + paint(' │', tone));
  }
  console.log(paint('╰' + fill('─', w - 2) + '╯', tone));
}

/** Reusable sleek double-line HUD banner box with gradient frame & badge */
export function renderNeonBannerBox(
  badgeLabel: string,
  titleText: string,
  rows: string[],
  borderStops?: string[],
  titleTone: Tone = 'cyan'
): void {
  const w = Math.max(76, Math.min(104, width()));
  const innerW = w - 4;
  const isCyber = theme().theme === 'cyberpunk';
  const stops = borderStops || gradientStopsForTheme('primary');
  const railTone: Tone = isCyber ? 'cyan' : 'purple';
  const badgeStr = badge(badgeLabel, isCyber && badgeLabel.includes('CYBER') ? 'cyber' : 'purple');

  console.log('');
  console.log(gradientText('┏' + '━'.repeat(w - 2) + '┓', stops));
  const titleLine = `${badgeStr} ${paint(titleText, titleTone, true)}`;
  const titlePad = Math.max(0, innerW - stringWidth(titleLine));
  console.log(paint('┃ ', railTone, true) + titleLine + fill(' ', titlePad) + paint(' ┃', railTone, true));
  console.log(paint('┣' + '─'.repeat(w - 2) + '┫', 'violet'));
  for (const r of rows) {
    const pad = Math.max(0, innerW - stringWidth(r));
    console.log(paint('┃ ', railTone) + r + fill(' ', pad) + paint(' ┃', railTone));
  }
  console.log(gradientText('┗' + '━'.repeat(w - 2) + '┛', stops) + '\n');
}

export function header(sectionTitle = 'CONTROL CENTER'): void {
  console.log('');
  const w = width();
  const isCyber = theme().theme === 'cyberpunk';
  const borderTone: Tone = isCyber ? 'cyan' : 'violet';
  const badgeText = isCyber ? 'CYBERPUNK // GRID' : 'TOKYO NIGHT // OS';
  const logoPlain = '✦  A U T O T A S K   A I  ✦';
  const logoRendered = gradientText(logoPlain, undefined, true);
  const rightBadge = badge(badgeText, isCyber ? 'cyber' : 'purple');
  const nowClock = new Date().toLocaleTimeString('vi-VN', { hour12: false });

  console.log(gradientText('╭' + fill('━', w - 2) + '╮'));

  const row1Space = Math.max(1, w - 4 - stringWidth(logoPlain) - stringWidth(rightBadge));
  console.log(
    paint('┃ ', borderTone) +
    logoRendered +
    fill(' ', row1Space) +
    rightBadge +
    paint(' ┃', borderTone)
  );

  const subPlain = `${theme().theme.toUpperCase().replace('-', ' ')}  //  ${sectionTitle}`;
  const clockTag = `⏱ ${nowClock}`;
  const row2Space = Math.max(1, w - 4 - stringWidth(subPlain) - stringWidth(clockTag));
  console.log(
    paint('┃ ', borderTone) +
    paint(subPlain, 'cyan', true) +
    fill(' ', row2Space) +
    paint(clockTag, 'muted') +
    paint(' ┃', borderTone)
  );

  console.log(gradientText('╰' + fill('━', w - 2) + '╯'));
  console.log(
    paint(
      isCyber
        ? '    ◈  autonomous cyber workstation  ─  NEON CITY // KEY-POOL ENGINE'
        : '    ⋆｡˚  local-first autonomous agent  ─  夜空 // KEY-POOL ENGINE',
      'muted'
    ) + '   ' + renderThemeSwatches()
  );
}

/** Render navigation breadcrumbs e.g. COMMAND DECK › MODEL CENTER › MY MODELS */
export function renderBreadcrumb(crumbs: string[]): void {
  const formatted = crumbs
    .map((c, i) => (i === crumbs.length - 1 ? paint(c, 'cyan', true) : paint(c, 'muted')))
    .join(paint(' › ', 'purple'));
  console.log(paint('  ◈ ', 'purple') + formatted);
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
  console.log('\n' + paint('◆ ', 'purple', true) + paint(label.toUpperCase(), 'cyan', true));
  console.log(rule());
}

export function hint(text: string): void {
  console.log(paint('  ◦  ' + text, 'muted'));
}

export function info(text: string): void {
  console.log(paint('  ◇ ', 'cyan') + paint(text, 'fg'));
}

export function success(text: string): void {
  console.log(paint('  ✓ ', 'green', true) + paint(text, 'fg'));
}

export function warn(text: string): void {
  console.log(paint('  ⚠ ', 'orange', true) + paint(text, 'fg'));
}

export function fail(text: string): void {
  console.log(paint('  ✕ ', 'red', true) + paint(text, 'fg'));
}

export function toast(type: 'info' | 'success' | 'warn' | 'error', message: string): void {
  const icons = { info: '◇', success: '✓', warn: '⚠', error: '✕' };
  const tones: Record<string, Tone> = { info: 'cyan', success: 'green', warn: 'orange', error: 'red' };
  const tone = tones[type] || 'fg';
  const boxW = Math.min(width() - 2, Math.max(48, stringWidth(message) + 8));
  const prefix = `╭─ [ ${icons[type]} ${type.toUpperCase()} ] `;
  const topPad = fill('─', Math.max(0, boxW - stringWidth(prefix) - 1));
  const clipped = clip(message, Math.max(16, boxW - 4));
  console.log(paint('  ' + prefix + topPad + '╮', tone));
  console.log(paint('  │ ', tone) + paint(clipped, 'fg', true) + fill(' ', Math.max(0, boxW - 4 - stringWidth(clipped))) + paint(' │', tone));
  console.log(paint('  ╰' + fill('─', boxW - 2) + '╯', tone));
}

export function renderErrorCard(title: string, message: string, suggestion?: string): void {
  const w = width();
  const cleanTitle = clip(title, Math.max(18, w - 16));
  console.log('\n' + paint('╭─ ✕ ERROR: ' + cleanTitle + fill('─', Math.max(0, w - 13 - stringWidth(cleanTitle))) + '╮', 'red'));
  console.log(paint('│ ', 'red') + paint(clip(message, w - 4), 'fg'));
  if (suggestion) {
    console.log(paint('│ ', 'red') + paint('👉 Khắc phục: ' + clip(suggestion, w - 16), 'yellow'));
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
  const doneBar = done > 0
    ? (done < barLen ? gradientText('━'.repeat(done - 1) + '╸', undefined, true) : gradientText('━'.repeat(done), gradientStopsForTheme('success'), true))
    : '';
  const remBar = paint('─'.repeat(Math.max(0, barLen - done)), 'border');
  console.log(
    paint('  ↳ ', 'purple') +
      paint(clip(label, 22).padEnd(23), 'fg') +
      ' ' +
      doneBar +
      remBar +
      paint(` ${pctStr}`, percent >= 1 ? 'green' : 'cyan', true) +
      paint(extra, 'muted')
  );
}

export function entry(key: string, value: string, tone: Tone = 'fg'): void {
  const keyCol = 26;
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
  const tone: Tone = /COMPLETED|SUBMITTED|READY|PASS|SUCCESS|VERIFIED|SẴN SÀNG|AVAILABLE|PROTECTED/.test(t)
    ? 'green'
    : /ERROR|FAILED|CANCEL|HẾT RPD|CHƯA CÓ|MISSING|QUÁ HẠN/.test(t)
    ? 'red'
    : /REVIEW|PARTIAL|WARNING|UNCONFIRMED|WARN|CHẠM|LIMITED|COOL|UNTESTED|KHẨN CẤP/.test(t)
    ? 'orange'
    : /RUNNING|DEFAULT|PRIMARY|★|●/.test(t)
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

function autoColorTableCell(text: string): string {
  if (!colorEnabled() || /\x1b\[/.test(text)) return text;
  const upper = text.toUpperCase();
  if (/✔|VERIFIED|AVAILABLE|SẴN SÀNG|PROTECTED|COMPLETED|DONE|READY|★ ĐANG DÙNG|★ MẶC ĐỊNH|● DEFAULT/.test(upper)) {
    return paint(text, 'green', true);
  }
  if (/✖|FAILED|ERROR|HẾT RPD|MISSING|CHƯA CÓ|QUÁ HẠN/.test(upper)) {
    return paint(text, 'red', true);
  }
  if (/⏳|CHẠM|LIMITED|COOL|UNTESTED|PARTIAL|KHẨN CẤP|WARN/.test(upper)) {
    return paint(text, 'orange', true);
  }
  if (/^\[\d+\]$/.test(text.trim())) {
    return paint(text, 'purple', true);
  }
  return text;
}

/** Render a structured TrueColor table with rounded borders & smart cell highlighting */
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
    return Math.max(5, max + 2);
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

  const top = '  ╭' + colWidths.map(w => fill('─', w)).join('┬') + '╮';
  const mid = '  ├' + colWidths.map(w => fill('─', w)).join('┼') + '┤';
  const bot = '  ╰' + colWidths.map(w => fill('─', w)).join('┴') + '╯';

  console.log(paint(top, 'border'));
  let headerLine = paint('  │', 'border');
  headers.forEach((h, i) => {
    const w = colWidths[i];
    const pad = Math.max(0, w - stringWidth(h) - 1);
    const cellText = ' ' + h + fill(' ', pad);
    headerLine += (colorEnabled() ? paintBg(cellText, COLORS[theme().theme].panel, COLORS[theme().theme].cyan, true) : cellText) + paint('│', 'border');
  });
  console.log(headerLine);
  console.log(paint(mid, 'border'));

  if (!rows.length) {
    const totalW = colWidths.reduce((a, b) => a + b, 0) + colWidths.length - 1;
    const emptyText = 'Không có dữ liệu';
    const pad = Math.max(0, totalW - stringWidth(emptyText) - 2);
    console.log(paint('  │ ', 'border') + paint(emptyText, 'muted') + fill(' ', pad) + paint(' │', 'border'));
  } else {
    rows.forEach((r) => {
      let rLine = paint('  │', 'border');
      r.forEach((cell, i) => {
        const val = String(cell !== undefined ? cell : '');
        const w = colWidths[i];
        const align = alignments[i] || 'left';
        const str = clip(val, w - 2);
        const padTotal = Math.max(0, w - stringWidth(str) - 1);
        const styledStr = autoColorTableCell(str);
        let formatted = '';
        if (align === 'right') {
          formatted = fill(' ', padTotal) + styledStr + ' ';
        } else if (align === 'center') {
          const lPad = Math.floor(padTotal / 2);
          const rPad = padTotal - lPad;
          formatted = fill(' ', lPad) + styledStr + fill(' ', rPad) + ' ';
        } else {
          formatted = ' ' + styledStr + fill(' ', padTotal);
        }
        rLine += formatted + paint('│', 'border');
      });
      console.log(rLine);
    });
  }
  console.log(paint(bot, 'border'));
}

export interface KeyRotationDisplayInfo {
  from?: string;
  to: string;
  reason?: string;
  slotIndex?: number;
  totalSlots?: number;
  mode?: 'round-robin' | 'telemetry' | 'failover' | 'probe';
}

/** Visual ring dots showing which API key slot in the pool is currently active (e.g. [○ ● ○]). */
export function renderKeySlotDots(slotIndex = 1, totalSlots = 1): string {
  if (!Number.isFinite(totalSlots) || totalSlots <= 1) return '';
  const safeTotal = Math.max(2, Math.floor(totalSlots));
  const safeActive = Math.min(safeTotal, Math.max(1, Math.floor(slotIndex)));
  if (safeTotal > 8) {
    return paint(`[slot ${safeActive}/${safeTotal}]`, 'cyan', true);
  }
  const dots: string[] = [];
  for (let i = 1; i <= safeTotal; i++) {
    dots.push(i === safeActive ? paint('●', 'green', true) : paint('○', 'muted'));
  }
  return paint('[', 'border') + dots.join(' ') + paint(']', 'border');
}

/** Formats a single-line key-rotation status entry (NO_COLOR safe). */
export function formatKeyRotationLine(infoData: KeyRotationDisplayInfo): string {
  const mode = infoData.mode || 'round-robin';
  const tagText = mode === 'failover' ? 'KEY FAILOVER' : 'KEY ROTATE';
  const tagTone: Tone | 'cyber' = mode === 'failover' ? 'yellow' : (theme().theme === 'cyberpunk' ? 'cyber' : 'cyan');
  const fromPart = infoData.from ? `${paint(infoData.from, 'muted')} ${gradientText('━━▶', undefined, true)} ` : '';
  const toPart = paint(infoData.to, 'green', true);
  const dots = renderKeySlotDots(infoData.slotIndex, infoData.totalSlots);
  const cleanReason = infoData.reason ? clip(infoData.reason.replace(/\s+/g, ' ').trim(), 56) : '';
  const reasonPart = cleanReason ? `  ${paint(`(${cleanReason})`, mode === 'failover' ? 'yellow' : 'muted')}` : '';
  return `  ${paint('↻', 'cyan', true)} ${badge(tagText, tagTone)} ${paint('🔑', 'yellow')} ${fromPart}${toPart}${dots ? '  ' + dots : ''}${reasonPart}`;
}

/** Plays a snappy orbital + tumbler carousel spin animation when rotating between API keys (TTY + animations ON; 0ms fallback otherwise). */
export async function animateKeyRotation(infoData: KeyRotationDisplayInfo): Promise<void> {
  const finalLine = formatKeyRotationLine(infoData);
  if (!isAnimationsEnabled()) {
    console.log(finalLine);
    return;
  }

  const isCyber = theme().theme === 'cyberpunk';
  const spinGlyphs = ['◐', '◓', '◑', '◒', '⟳', '↻'];
  const reelBars = ['░▒░░░░', '▒▓▒░░░', '▓█▓▒░░', '░▓█▓▒░', '░░▓█▓▒', '█████✦'];
  const stops = gradientStopsForTheme(infoData.mode === 'failover' ? 'warn' : 'primary');
  const totalSlots = Math.max(1, infoData.totalSlots || 1);
  const targetSlot = Math.min(totalSlots, Math.max(1, infoData.slotIndex || 1));
  const fromLabel = infoData.from ? `${infoData.from} ` : '';

  process.stdout.write('\x1b[?25l');
  try {
    for (let f = 0; f < spinGlyphs.length; f++) {
      const orb = paint(spinGlyphs[f], isCyber ? 'cyan' : 'purple', true);
      const reel = gradientText(reelBars[f], stops, true, f * 0.2);
      const spinSlot = totalSlots > 1 ? ((f < spinGlyphs.length - 1) ? ((f % totalSlots) + 1) : targetSlot) : 1;
      const dots = renderKeySlotDots(spinSlot, totalSlots);
      const targetPreview = f >= spinGlyphs.length - 2 ? paint(infoData.to, 'green', true) : paint(infoData.to, 'cyan');
      const line = `  ${orb} ${badge('ROTATING KEY', isCyber ? 'cyber' : 'purple')} ${paint('🔑', 'yellow')} ${paint(fromLabel, 'muted')}${reel} ${targetPreview}${dots ? '  ' + dots : ''}`;
      process.stdout.write(`\r\x1b[2K${line}`);
      await new Promise(r => setTimeout(r, 32));
    }
    process.stdout.write(`\r\x1b[2K${finalLine}\n`);
  } finally {
    process.stdout.write('\x1b[?25h');
  }
}

/** Animated terminal spinner with TrueColor pulsing icon and live elapsed seconds */
export async function withSpinner<T>(label: string, action: () => Promise<T>): Promise<T> {
  const isCyber = theme().theme === 'cyberpunk';
  const frames = isCyber
    ? ['◐', '◓', '◑', '◒', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  if (!isAnimationsEnabled()) {
    info(label + '...');
    return await action();
  }
  const startedAt = Date.now();
  const spinnerTones: Tone[] = isCyber ? ['cyan', 'purple', 'yellow', 'violet'] : ['purple', 'cyan', 'blue', 'aqua'];
  process.stdout.write('\x1b[?25l');
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const tone = spinnerTones[Math.floor(i / 2) % spinnerTones.length];
    const frame = paint(frames[i++ % frames.length], tone, true);
    const pulse = paint('•', spinnerTones[(Math.floor(i / 2) + 1) % spinnerTones.length]);
    process.stdout.write(`\r  ${frame} ${pulse} ${paint(label, 'fg')} ${paint(`(${elapsed}s)`, 'muted')}  `);
  }, 75);
  try {
    const res = await action();
    clearInterval(timer);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\r  ${paint('✓', 'green', true)}   ${paint(label, 'fg')} ${paint(`(${totalSec}s)`, 'muted')}   \n`);
    return res;
  } catch (e) {
    clearInterval(timer);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\r  ${paint('✖', 'red', true)}   ${paint(label, 'fg')} ${paint(`(${totalSec}s)`, 'muted')}   \n`);
    throw e;
  } finally {
    process.stdout.write('\x1b[?25h');
  }
}

/** Brief stylish scanline + gradient wave-sweep boot animation (strictly TTY + interactive + animations ON) */
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
  const isCyber = theme().theme === 'cyberpunk';
  const stops = gradientStopsForTheme('primary');
  console.clear();
  console.log('');
  process.stdout.write('\x1b[?25l');
  try {
    // 1. Scanline line-by-line reveal
    for (const line of banner) {
      console.log('  ' + gradientText(line, stops, true));
      await new Promise(r => setTimeout(r, 28));
    }
    // 2. Smooth 5-frame gradient wave shimmer across the logo
    for (let f = 1; f <= 5; f++) {
      process.stdout.write(`\x1b[${banner.length}A`);
      for (let li = 0; li < banner.length; li++) {
        const phase = f * 0.18 + li * 0.06;
        process.stdout.write('\x1b[2K  ' + gradientText(banner[li], stops, true, phase) + '\n');
      }
      await new Promise(r => setTimeout(r, 34));
    }

    // 3. Multi-stage animated boot telemetry meters
    const stages = [
      ['[BOOT] Neural Router', 25, 45],
      ['[SYNC] Multi-Key Pool', 45, 72],
      ['[SCAN] Quota Matrix', 72, 92],
      ['[LINK] Playwright Grid', 92, 100]
    ] as const;
    const spin = ['◐', '◓', '◑', '◒'];
    let spIdx = 0;
    for (const [stageLabel, fromPct, toPct] of stages) {
      for (const pct of [fromPct, Math.round((fromPct + toPct) / 2), toPct]) {
        const bar = renderMeterBar(pct, 100, 20);
        const glyph = paint(spin[spIdx++ % spin.length], isCyber ? 'cyan' : 'purple', true);
        process.stdout.write(`\r  ${glyph} ${paint(stageLabel.padEnd(23), 'fg', true)} ${bar}  `);
        await new Promise(r => setTimeout(r, 22));
      }
    }
    process.stdout.write('\n');
    console.log(
      gradientText(
        isCyber
          ? '  ─── [ CYBERNETIC WORKSTATION // MULTI-KEY GRID ONLINE ] ───'
          : '  ─── [ AUTONOMOUS WORKSTATION // MULTI-KEY ENGINE ONLINE ] ───',
        stops,
        true
      )
    );
    await new Promise(r => setTimeout(r, 70));
  } finally {
    process.stdout.write('\x1b[?25h');
  }
}

/** Brief scanline reveal for HUD cards (instant in non-TTY or when animations disabled) */
export async function animateRevealLines(lines: string[], delayMs = 14): Promise<void> {
  if (!isAnimationsEnabled() || delayMs <= 0) {
    for (const l of lines) console.log(l);
    return;
  }
  for (const l of lines) {
    console.log(l);
    await new Promise(r => setTimeout(r, delayMs));
  }
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
      'purple',
      true
    )
  );
}

export function preview(): void {
  header('UI & THEME SHOWCASE');
  renderBreadcrumb(['COMMAND DECK', 'APPEARANCE STUDIO', 'LIVE PREVIEW']);
  renderPanelBox(
    'KEY-POOL & QUOTA HUD',
    [
      `Mức tải RPD  : ${renderMeterBar(18, 100, 16)}  ${badge('3 KEYS ACTIVE', 'green')}`,
      `Latency EMA  : ${renderSparkline([240, 190, 210, 165, 180, 155, 170])}  ${paint('172ms avg', 'cyan', true)}`
    ],
    'purple',
    theme().theme.toUpperCase()
  );
  section('System overview');
  entry('WORKSPACE', 'LOCAL · WINDOWS FIRST', 'aqua');
  entry('THEME PALETTE', `${theme().theme.toUpperCase()}  ${renderThemeSwatches()}`, 'purple');
  entry('ACTIVE TASKS', '2 queued  /  1 running', 'cyan');
  section('Navigation');
  choice('1', 'Autonomous Agent', 'Natural language LMS automation');
  choice('2', 'Model Center', 'Multi-key pool & per-model quota monitor');
  choice('3', 'Appearance Studio', 'TrueColor skins, shaders & animations');
  choice('0', 'Exit');
  section('Live activity');
  step('Synchronizing quota telemetry', 8, 10);
  console.log(formatKeyRotationLine({
    from: 'prf_1/gemini-3-flash-preview',
    to: 'prf_1#k2/gemini-3-flash-preview',
    slotIndex: 2,
    totalSlots: 3,
    mode: 'round-robin',
    reason: 'Xoay vòng cân bằng tải'
  }));
  renderTable(
    ['Slot', 'Model', 'RPM (60s)', 'RPD (Ngày)', 'Trạng thái'],
    [
      ['prf_1', 'gemini-3-flash-preview', '1/5 (còn 4)', '3/20 (còn 17)', '✔ SẴN SÀNG'],
      ['prf_1__k2', 'gemini-3.5-flash-lite', '2/15 (còn 13)', '18/500 (còn 482)', '✔ SẴN SÀNG']
    ]
  );
  toast('success', 'Terminal TrueColor skin & telemetry effects initialized!');
  hint('Preview uses display placeholders only; no jobs or profiles are created.');
  close();
}
