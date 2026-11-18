/** Comprehensive System Doctor: Preflight diagnostics, OS Keyring, Chromium, and Config checks. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  header,
  section,
  entry,
  success,
  warn,
  fail,
  close,
  renderBreadcrumb,
  renderTable
} from './ui/tokyo.js';
import { loadTheme } from './ui/themes.js';
import { dashboardAlerts } from './ui/dashboard.js';
import { testKeyringAccess } from './model-center/keyring.js';
import { listAccounts } from './accounts.js';

export interface Check {
  name: string;
  level: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  recommendation?: string;
}

export async function collectChecks(): Promise<Check[]> {
  const list: Check[] = [];

  // 1. Node.js check
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  list.push({
    name: 'Node.js Runtime',
    level: nodeMajor >= 20 ? 'PASS' : 'FAIL',
    detail: `${process.version} (Yêu cầu >= v20)`,
    recommendation: nodeMajor < 20 ? 'Cập nhật Node.js lên phiên bản LTS 20+ từ https://nodejs.org/' : undefined
  });

  // 2. Python & packages
  const python = process.env.AUTOTASK_PYTHON || 'python';
  const py = spawnSync(
    python,
    ['-c', 'import sys;print(sys.version.split()[0]);import keyring,docx,openpyxl,reportlab;print("deps-ok")'],
    { encoding: 'utf8', timeout: 8000 }
  );
  const pyOk = py.status === 0;
  list.push({
    name: 'Python Workers & Libs',
    level: pyOk ? 'PASS' : 'WARN',
    detail: pyOk ? (py.stdout || '').trim().replace(/\n/g, ' / ') : 'Thiếu thư viện hoặc chưa cài Python 3.11+',
    recommendation: !pyOk ? 'Chạy lệnh: pip install -r desktop/requirements.txt' : undefined
  });

  // 3. OS Credential Vault (Keyring)
  const kr = testKeyringAccess();
  list.push({
    name: 'OS Credential Vault',
    level: kr.ok ? 'PASS' : 'WARN',
    detail: kr.ok ? `Hoạt động tốt (${kr.backend})` : kr.backend,
    recommendation: !kr.ok ? 'Cần quyền truy cập Windows Credential Manager' : undefined
  });

  // 4. Playwright Module
  let pwOk = false;
  try {
    await import('playwright');
    pwOk = true;
    list.push({
      name: 'Playwright Library',
      level: 'PASS',
      detail: 'Node module đã sẵn sàng'
    });
  } catch {
    list.push({
      name: 'Playwright Library',
      level: 'FAIL',
      detail: 'Chưa cài package playwright',
      recommendation: 'Chạy lệnh: npm install'
    });
  }

  // 5. Playwright Chromium Browser Binary
  if (pwOk) {
    try {
      const { chromium } = await import('playwright');
      const execPath = chromium.executablePath();
      const hasBinary = existsSync(execPath);
      list.push({
        name: 'Chromium Browser Binary',
        level: hasBinary ? 'PASS' : 'WARN',
        detail: hasBinary ? 'Trình duyệt Chromium đã cài đặt sẵn' : 'Chưa tải Chromium binary',
        recommendation: !hasBinary ? 'Chạy lệnh: npx playwright install chromium' : undefined
      });
    } catch {
      list.push({
        name: 'Chromium Browser Binary',
        level: 'WARN',
        detail: 'Cần kiểm tra binary Chromium',
        recommendation: 'Chạy lệnh: npx playwright install chromium'
      });
    }
  }

  // 6. Model Center / BYOK profiles
  let modelCount = 0;
  let hasDefault = false;
  let modelDetail = 'Chưa cấu hình model nào';
  try {
    const raw = JSON.parse(await readFile('.private/model-profiles.json', 'utf8'));
    modelCount = Object.keys(raw.profiles || {}).length;
    hasDefault = Boolean(raw.default && raw.profiles[raw.default]);
    modelDetail = hasDefault
      ? `${modelCount} profile (Mặc định: ${raw.default})`
      : modelCount ? `${modelCount} profile (Chưa chọn mặc định)` : 'Chưa cấu hình profile nào';
  } catch {
    if (existsSync('.private/model-profiles.json')) {
      modelDetail = 'File .private/model-profiles.json bị lỗi cú pháp JSON';
    }
  }

  list.push({
    name: 'Model Center (AI Profiles)',
    level: hasDefault ? 'PASS' : 'WARN',
    detail: modelDetail,
    recommendation: !hasDefault ? 'Chạy Model Center ([5] trên menu) để thêm model và API key' : undefined
  });

  // 7. Account Vault
  const accounts = await listAccounts();
  const accCount = Object.keys(accounts).length;
  list.push({
    name: 'Account Vault (LMS/Web)',
    level: accCount > 0 ? 'PASS' : 'WARN',
    detail: accCount > 0 ? `${accCount} tài khoản đã lưu trong OS Vault` : 'Chưa lưu tài khoản nào (sẽ dùng login thủ công)',
    recommendation: accCount === 0 ? 'Thêm tài khoản tại Account Vault ([6] trên menu) nếu muốn tự động hóa' : undefined
  });

  // 8. Browser Task Settings
  const hasBrowserTask = existsSync('.private/browser-task.json');
  let taskValid = false;
  let taskDetail = 'Chưa có cấu hình tác vụ';
  if (hasBrowserTask) {
    try {
      const raw = JSON.parse(await readFile('.private/browser-task.json', 'utf8'));
      if (Array.isArray(raw.allowedHosts) && raw.allowedHosts.length > 0) {
        taskValid = true;
        taskDetail = `Hợp lệ (${raw.allowedHosts.length} website được phép, ${raw.tasks?.length || 0} tác vụ)`;
      } else {
        taskDetail = 'File .private/browser-task.json thiếu allowedHosts hợp lệ';
      }
    } catch {
      taskDetail = 'File .private/browser-task.json bị lỗi cú pháp JSON';
    }
  }
  list.push({
    name: 'Browser Task Config',
    level: taskValid ? 'PASS' : 'WARN',
    detail: taskDetail,
    recommendation: !taskValid ? 'Chạy Setup Wizard ([11] trên menu) để tạo cấu hình tác vụ' : undefined
  });

  // 9. Windows Platform & Terminal
  const isWin = process.platform === 'win32';
  list.push({
    name: 'Windows Automation Platform',
    level: isWin ? 'PASS' : 'WARN',
    detail: isWin ? 'Windows OS phát hiện (UIA & WinVault hoạt động)' : 'Môi trường non-Windows (Desktop UIA bị giới hạn)'
  });

  // 10. Secrets isolation
  const hasEnv = existsSync('.env');
  list.push({
    name: 'Bảo Mật Secrets Không Lộ',
    level: !hasEnv ? 'PASS' : 'WARN',
    detail: !hasEnv ? 'Không có file .env plaintext ở thư mục gốc' : 'Phát hiện file .env; nên dùng OS Credential Vault thay thế'
  });

  return list;
}

export async function doctor(): Promise<void> {
  await loadTheme();
  header('SYSTEM DOCTOR  /  PREFLIGHT DIAGNOSTICS');
  renderBreadcrumb(['COMMAND DECK', 'SYSTEM DOCTOR']);

  section('KIỂM TRA HỆ THỐNG & MÔI TRƯỜNG');
  const checks = await collectChecks();

  const headers = ['Hạng mục', 'Kết quả', 'Chi tiết'];
  const rows = checks.map(c => [
    c.name,
    c.level === 'PASS' ? '● PASS' : c.level === 'WARN' ? '● CẢNH BÁO' : '● THẤT BẠI',
    c.detail
  ]);
  renderTable(headers, rows);

  // Recommendations for any warnings/failures
  const actionable = checks.filter(c => c.recommendation);
  if (actionable.length > 0) {
    section('HƯỚNG DẪN KHẮC PHỤC (RECOMMENDATIONS)');
    actionable.forEach(c => {
      entry(c.name, c.recommendation!, c.level === 'FAIL' ? 'red' : 'yellow');
    });
  }

  const a = await dashboardAlerts();
  section('TÌNH TRẠNG DEADLINE HÔM NAY');
  entry('HẠN CHÓT ≤ 24H', String(a.urgent), a.urgent ? 'orange' : 'green');
  entry('QUÁ HẠN', String(a.overdue), a.overdue ? 'red' : 'green');
  if (!a.lastReport) warn('Chưa có báo cáo deadline; quét LMS sau khi cấu hình Browser Agent.');

  section('TỔNG KẾT ĐÁNH GIÁ');
  const failed = checks.filter(x => x.level === 'FAIL').length;
  const warning = checks.filter(x => x.level === 'WARN').length;

  if (failed) {
    fail(`Có ${failed} thành phần chặn chạy ứng dụng; ${warning} cảnh báo.`);
  } else if (warning) {
    warn(`Các thành phần cơ bản đạt yêu cầu với ${warning} cảnh báo cấu hình. Có thể chạy app ngay.`);
  } else {
    success('Mọi thành phần cục bộ và phụ thuộc đều hoàn hảo!');
  }

  close('CHẨN ĐOÁN HOÀN TẤT');
}

if (process.argv[1] && /(?:^|[\\/])doctor\.(?:ts|js)$/.test(process.argv[1])) {
  doctor().catch(e => {
    fail(String(e));
    process.exitCode = 1;
  });
}
