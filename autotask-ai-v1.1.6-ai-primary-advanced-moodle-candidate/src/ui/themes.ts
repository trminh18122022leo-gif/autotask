import {mkdir,readFile,writeFile} from 'node:fs/promises';

export type ThemeName = 'tokyo-night' | 'cyberpunk';
export type CursorShape = 'bar' | 'vintage' | 'underscore' | 'filledBox' | 'emptyBox';

export interface ThemeSettings {
  theme: ThemeName;
  font: string;
  fontSize: number;
  opacity: number;
  animations?: boolean;
  cursorShape?: CursorShape;
}

export const DEFAULT_THEME: ThemeSettings = {
  theme: 'tokyo-night',
  font: 'Cascadia Code',
  fontSize: 12,
  opacity: 96,
  animations: true,
  cursorShape: 'bar'
};

export const COLORS = {
  'tokyo-night': {
    midnight: '#1a1b26',
    panel: '#24283b',
    border: '#414868',
    fg: '#c0caf5',
    muted: '#9aa5ce',
    purple: '#bb9af7',
    violet: '#9d7cd8',
    cyan: '#7dcfff',
    aqua: '#73daca',
    blue: '#7aa2f7',
    orange: '#ff9e64',
    red: '#f7768e',
    green: '#73daca',
    yellow: '#e0af68'
  },
  cyberpunk: {
    midnight: '#0b0614',
    panel: '#150d27',
    border: '#452b69',
    fg: '#f2eaff',
    muted: '#a89bc2',
    purple: '#ff2bd6', // Neon Pink
    violet: '#a855f7', // Purple
    cyan: '#00f5ff',   // Neon Cyan
    aqua: '#00f5ff',
    blue: '#a855f7',
    orange: '#fcee0a', // Yellow / Accent
    red: '#ff2a5f',
    green: '#73daca',
    yellow: '#fcee0a'  // Yellow
  }
} as const;

export const VALID_CURSORS: CursorShape[] = ['bar', 'vintage', 'underscore', 'filledBox', 'emptyBox'];

export function validThemeSettings(o: any): o is ThemeSettings {
  return (
    !!o &&
    ['tokyo-night', 'cyberpunk'].includes(o.theme) &&
    typeof o.font === 'string' &&
    o.font.length > 0 &&
    o.font.length < 90 &&
    Number.isInteger(o.fontSize) &&
    o.fontSize >= 8 &&
    o.fontSize <= 24 &&
    Number.isInteger(o.opacity) &&
    o.opacity >= 40 &&
    o.opacity <= 100 &&
    (o.animations === undefined || typeof o.animations === 'boolean') &&
    (o.cursorShape === undefined || VALID_CURSORS.includes(o.cursorShape))
  );
}

let active: ThemeSettings = { ...DEFAULT_THEME };

export function theme(): ThemeSettings {
  return { ...active };
}

export function setTheme(next: ThemeSettings): void {
  if (!validThemeSettings(next)) throw new Error('Theme settings invalid');
  active = {
    ...DEFAULT_THEME,
    ...next,
    animations: next.animations !== false,
    cursorShape: next.cursorShape || 'bar'
  };
}

export async function readTheme(): Promise<ThemeSettings> {
  try {
    const v = JSON.parse(await readFile('.private/theme.json', 'utf8'));
    return validThemeSettings(v)
      ? {
          ...DEFAULT_THEME,
          ...v,
          animations: v.animations !== false,
          cursorShape: v.cursorShape || 'bar'
        }
      : { ...DEFAULT_THEME };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export async function loadTheme(): Promise<ThemeSettings> {
  const v = await readTheme();
  setTheme(v);
  return v;
}

export async function saveTheme(v: ThemeSettings): Promise<void> {
  setTheme(v);
  await mkdir('.private', { recursive: true });
  await writeFile('.private/theme.json', JSON.stringify(active, null, 2) + '\n', { mode: 0o600 });
}

export function windowsTerminalProfile(t: ThemeSettings) {
  const p = COLORS[t.theme];
  return {
    name: t.theme === 'tokyo-night' ? 'AutoTask Tokyo Night' : 'AutoTask Cyberpunk',
    background: p.midnight,
    foreground: p.fg,
    cursorColor: p.cyan,
    black: p.midnight,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    purple: p.purple,
    cyan: p.cyan,
    white: p.fg,
    brightBlack: p.border,
    brightRed: p.red,
    brightGreen: p.green,
    brightYellow: p.yellow,
    brightBlue: p.blue,
    brightPurple: p.violet,
    brightCyan: p.aqua,
    brightWhite: '#ffffff'
  };
}
