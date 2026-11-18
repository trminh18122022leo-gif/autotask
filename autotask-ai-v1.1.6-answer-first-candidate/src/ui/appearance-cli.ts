/** Appearance Studio: Theme selection, live preview, Windows Terminal font, cursor, animations and profile installer. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadTheme,
  saveTheme,
  windowsTerminalProfile,
  DEFAULT_THEME,
  VALID_CURSORS,
  type ThemeName,
  type CursorShape,
  type ThemeSettings
} from './themes.js';
import {
  header,
  entry,
  section,
  choice,
  success,
  info,
  warn,
  fail,
  close,
  renderBreadcrumb,
  toast,
  renderTable,
  preview
} from './tokyo.js';

async function ask(promptText: string, def = ''): Promise<string> {
  const cli = createInterface({ input: stdin, output: stdout });
  try {
    const hint = def ? ` [${def}]` : '';
    const ans = (await cli.question(`  ❯ ${promptText}${hint}  ›  `)).trim();
    return ans || def;
  } finally {
    cli.close();
  }
}

export async function runAppearanceStudio(): Promise<void> {
  while (true) {
    const current = await loadTheme();
    header('APPEARANCE STUDIO  /  TERMINAL STYLING');
    renderBreadcrumb(['COMMAND DECK', 'APPEARANCE STUDIO']);

    section('THIẾT LẬP HIỆN TẠI');
    entry('THEME BẢNG MÀU', current.theme.toUpperCase(), current.theme === 'cyberpunk' ? 'purple' : 'cyan');
    entry('FONT WINDOWS TERMINAL', `${current.font} (${current.fontSize}pt)`, 'aqua');
    entry('ĐỘ MỜ / ĐỘ TRONG SUỐT (OPACITY)', `${current.opacity}%`, 'purple');
    entry('KIỂU CON TRỎ (CURSOR SHAPE)', current.cursorShape || 'bar', 'green');
    entry('HIỆU ỨNG CHUYỂN ĐỘNG (ANIMATIONS)', current.animations !== false ? 'BẬT' : 'TẮT', current.animations !== false ? 'green' : 'muted');

    section('CÁC TÙY CHỌN CÀI ĐẶT');
    choice('1', 'Đổi Theme (Tokyo Night / Cyberpunk)');
    choice('2', 'Xem Preview Theme Trực Tiếp');
    choice('3', 'Đổi Font Chữ (Windows Terminal)');
    choice('4', 'Đổi Kích Thước Font (8–24pt)');
    choice('5', 'Điều Chỉnh Opacity (40–100%)');
    choice('6', 'Đổi Kiểu Con Trỏ (bar, vintage, underscore, filledBox, emptyBox)');
    choice('7', `Bật/Tắt Hiệu Ứng Chuyển Động (Hiện tại: ${current.animations !== false ? 'BẬT' : 'TẮT'})`);
    choice('8', 'Cài Đặt Vào Windows Terminal (Tạo Profile Riêng & Backup)');
    choice('9', 'Reset Về Mặc Định Ban Đầu');
    choice('H', 'Hướng Dẫn Cài Đặt Thủ Công');
    choice('0', 'Lưu & Thoát');

    const sel = (await ask('Chọn hành động (0–9, H)')).toUpperCase();
    if (sel === '0') {
      await saveTheme(current);
      toast('success', 'Đã lưu thiết lập ngoại hình!');
      break;
    }

    if (sel === '1') {
      section('CHỌN THEME');
      choice('1', 'Tokyo Night', 'Phong cách màn đêm Tokyo (#1a1b26, #bb9af7, #7dcfff, #73daca)');
      choice('2', 'Cyberpunk', 'Phong cách Neon Cyberpunk (#0b0614, #ff2bd6, #00f5ff, #fcee0a)');
      const tSel = await ask('Chọn 1 hoặc 2', current.theme === 'tokyo-night' ? '1' : '2');
      current.theme = tSel === '2' ? 'cyberpunk' : 'tokyo-night';
      await saveTheme(current);
      toast('success', `Đã chuyển sang theme ${current.theme.toUpperCase()}`);
    } else if (sel === '2') {
      preview();
      const wait = await ask('Nhấn Enter để quay lại Appearance Studio...');
    } else if (sel === '3') {
      section('CHỌN FONT CHỮ');
      info('Gợi ý: Cascadia Code, JetBrains Mono, Fira Code, Consolas, MesloLGS NF');
      const font = await ask('Nhập tên font đã cài trên máy', current.font);
      if (font) {
        current.font = font;
        await saveTheme(current);
        toast('success', `Đã đổi font thành "${current.font}"`);
      }
    } else if (sel === '4') {
      const sizeInput = await ask('Nhập kích thước font (8–24)', String(current.fontSize));
      const size = parseInt(sizeInput, 10);
      if (!isNaN(size) && size >= 8 && size <= 24) {
        current.fontSize = size;
        await saveTheme(current);
        toast('success', `Đã đổi kích thước font thành ${current.fontSize}pt`);
      } else {
        warn('Kích thước phải từ 8 đến 24');
      }
    } else if (sel === '5') {
      const opInput = await ask('Nhập opacity (40–100%)', String(current.opacity));
      const op = parseInt(opInput, 10);
      if (!isNaN(op) && op >= 40 && op <= 100) {
        current.opacity = op;
        await saveTheme(current);
        toast('success', `Đã đổi opacity thành ${current.opacity}%`);
      } else {
        warn('Opacity phải từ 40 đến 100%');
      }
    } else if (sel === '6') {
      section('CHỌN KIỂU CON TRỎ (CURSOR SHAPE)');
      VALID_CURSORS.forEach((c, idx) => {
        choice(String(idx + 1), c);
      });
      const cSel = await ask('Chọn kiểu con trỏ (1–5)', '1');
      const cIdx = parseInt(cSel, 10) - 1;
      if (!isNaN(cIdx) && cIdx >= 0 && cIdx < VALID_CURSORS.length) {
        current.cursorShape = VALID_CURSORS[cIdx];
        await saveTheme(current);
        toast('success', `Đã chọn kiểu cursor: ${current.cursorShape}`);
      }
    } else if (sel === '7') {
      current.animations = current.animations === false;
      await saveTheme(current);
      toast('success', `Hiệu ứng chuyển động đã được ${current.animations ? 'BẬT' : 'TẮT'}`);
    } else if (sel === '8') {
      await exportAndInstallTerminalProfile(current);
    } else if (sel === '9') {
      const confirm = await ask('Bạn có chắc muốn reset tất cả về mặc định? (y/n)', 'n');
      if (confirm.toLowerCase() === 'y') {
        await saveTheme({ ...DEFAULT_THEME });
        toast('success', 'Đã khôi phục thiết lập ngoại hình mặc định ban đầu!');
      }
    } else if (sel === 'H') {
      showManualInstructions(current);
      await ask('Nhấn Enter để quay lại...');
    }
  }
}

async function exportAndInstallTerminalProfile(t: ThemeSettings): Promise<void> {
  section('XUẤT CẤU HÌNH & CÀI ĐẶT WINDOWS TERMINAL');
  await mkdir('terminal', { recursive: true });

  const profile = windowsTerminalProfile(t);
  const schemeFile = join('terminal', 'windows-terminal-scheme.json');
  const settingsFile = join('terminal', 'windows-terminal-profile-settings.json');

  await writeFile(schemeFile, JSON.stringify(profile, null, 2) + '\n');
  await writeFile(
    settingsFile,
    JSON.stringify(
      {
        colorScheme: profile.name,
        font: { face: t.font, size: t.fontSize },
        opacity: t.opacity,
        useAcrylic: t.opacity < 100,
        cursorShape: t.cursorShape || 'bar'
      },
      null,
      2
    ) + '\n'
  );

  success(`Đã xuất snippet: ${schemeFile}`);
  success(`Đã xuất snippet: ${settingsFile}`);

  if (process.platform === 'win32') {
    info('Tự động tạo profile riêng "AutoTask AI" trong Windows Terminal (tự backup settings.json cũ).');
    const apply = await ask('Tiến hành cài đặt tự động vào Windows Terminal? (Y/n)', 'y');
    if (apply.toLowerCase() !== 'n') {
      const pwsh = spawnSync('where', ['pwsh'], { stdio: 'ignore', windowsHide: true }).status === 0 ? 'pwsh' : 'powershell.exe';
      const run = spawnSync(
        pwsh,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/apply-windows-terminal-theme.ps1', '-Apply'],
        { stdio: 'inherit', windowsHide: false }
      );
      if (run.error || run.status !== 0) {
        warn('Không thể cài đặt tự động (có thể do file settings.json chứa comment JSONC).');
        info('Hãy xem hướng dẫn thủ công bên dưới để copy snippet.');
        showManualInstructions(t);
      } else {
        toast('success', 'Đã cài đặt profile AutoTask AI vào Windows Terminal thành công!');
      }
    }
  } else {
    info('Cài đặt Windows Terminal chỉ khả dụng trên hệ điều hành Windows.');
  }
}

function showManualInstructions(t: ThemeSettings): void {
  section('HƯỚNG DẪN CÀI ĐẶT THỦ CÔNG WINDOWS TERMINAL');
  info('1. Mở Windows Terminal, nhấn Ctrl + , (Settings).');
  info('2. Nhấn "Open JSON file" ở góc dưới bên trái.');
  info('3. Trong mảng "schemes": [], sao chép nội dung từ file:');
  entry('FILE SCHEME', 'terminal/windows-terminal-scheme.json', 'aqua');
  info('4. Trong "profiles" -> "list": [], thêm profile AutoTask AI từ file:');
  entry('FILE PROFILE', 'terminal/windows-terminal-profile-settings.json', 'aqua');
  info('5. Lưu settings.json và chọn profile "AutoTask AI" trong danh sách tab.');
}

if (process.argv[1] && /(?:^|[\\/])appearance-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runAppearanceStudio();
}
