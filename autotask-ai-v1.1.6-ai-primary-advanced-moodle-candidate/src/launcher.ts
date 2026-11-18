/** Main Command Deck: Tokyo Night / Cyberpunk Workstation Console.
 * Arrow-key navigable, non-flicker re-rendering, complete 13 modules and real-time status HUD.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  header,
  section,
  info,
  warn,
  success,
  fail,
  entry,
  close,
  renderBreadcrumb,
  renderStatusBar,
  introAnimation,
  setupTerminalCleanup,
  toast
} from './ui/tokyo.js';
import { loadTheme, theme } from './ui/themes.js';
import { selectMenu, type MenuItem } from './ui/menu.js';
import { dashboardAlerts, showReports, recentReports } from './ui/dashboard.js';
import { checkFirstRunStatus, browserSetupInteractive } from './setup.js';
import { runModelCenter } from './ui/model-center-cli.js';
import { runAppearanceStudio } from './ui/appearance-cli.js';
import { runTaskQueueCli } from './ui/task-queue-cli.js';
import { runDeadlineRadarCli } from './ui/deadline-radar-cli.js';
import { runAccountsConsole } from './ui/accounts-cli.js';
import { listAccounts } from './accounts.js';
import { listAllCheckpoints } from './task-manager.js';

type RecordAny = Record<string, any>;
const python = process.env.AUTOTASK_PYTHON || 'python';

const menu: MenuItem[] = [
  { id: '1', label: 'Browser Agent', description: 'Web tasks, Moodle, Forms, an toàn có xác nhận nộp' },
  { id: '2', label: 'Desktop Computer Use', description: 'Quan sát và điều khiển cửa sổ Windows UI Automation' },
  { id: '3', label: 'LMS & Course Discovery', description: 'Quét tự động khóa học, môn học, bài tập & deadline' },
  { id: '4', label: 'Task Queue', description: 'Quản lý tác vụ, tiến độ, checkpoint, tạm dừng & thử lại' },
  { id: '5', label: 'Model Center', description: 'Quản lý AI: My Models, Catalog, Key Manager & Routing' },
  { id: '6', label: 'Account Vault', description: 'Quản lý tài khoản LMS, mật khẩu Windows Keyring & Sessions' },
  { id: '7', label: 'AI Notes', description: 'Ghi chú chỉ dẫn riêng cho AI (Global, Host & Task scoped)' },
  { id: '8', label: 'Deadline Radar', description: 'Ra-đa theo dõi hạn chót bài tập theo thời gian thực' },
  { id: '9', label: 'Task History & Reports', description: 'Lịch sử thực thi, điểm số đã quan sát & báo cáo chi tiết' },
  { id: '10', label: 'Appearance Studio', description: 'Đổi Theme (Tokyo Night/Cyberpunk), font, opacity & cursor' },
  { id: '11', label: 'Setup Wizard', description: 'Tạo & chỉnh sửa cấu hình multi-site, multi-account' },
  { id: '12', label: 'System Doctor', description: 'Chẩn đoán môi trường, dependencies, Keyring & Playwright' },
  { id: '0', label: 'Exit', description: 'Đóng Command Deck an toàn' }
];

async function collectWorkspaceState() {
  let defaultModel = 'Chưa cấu hình';
  let defaultProvider = 'N/A';
  let modelProfilesCount = 0;

  try {
    const d = JSON.parse(await readFile('.private/model-profiles.json', 'utf8')) as RecordAny;
    const profiles = d.profiles || {};
    modelProfilesCount = Object.keys(profiles).length;
    if (d.default && profiles[d.default]) {
      defaultModel = d.default;
      defaultProvider = profiles[d.default].provider || 'custom';
    }
  } catch {}

  const accounts = await listAccounts();
  const accountsCount = Object.keys(accounts).length;

  const browserConfigExists = existsSync('.private/browser-task.json');
  const browserAgentStatus = browserConfigExists ? 'SẴN SÀNG (READY)' : 'CHƯA CẤU HÌNH (CẦN SETUP)';

  let queuedTasks = 0;
  let runningTasks = 0;

  try {
    const q = JSON.parse(await readFile('.private/desktop-queue.json', 'utf8')) as RecordAny;
    const jobs = q.jobs || [];
    queuedTasks += jobs.filter((x: RecordAny) => x.status === 'PENDING').length;
    runningTasks += jobs.filter((x: RecordAny) => x.status === 'RUNNING').length;
  } catch {}

  const checkpoints = await listAllCheckpoints();
  queuedTasks += checkpoints.filter(c => c.status === 'PENDING').length;
  runningTasks += checkpoints.filter(c => c.status === 'RUNNING').length;

  const reports = await recentReports(10);
  const reportsCount = reports.length;

  const alerts = await dashboardAlerts();

  return {
    defaultModel,
    defaultProvider,
    modelProfilesCount,
    accountsCount,
    browserAgentStatus,
    browserConfigExists,
    queuedTasks,
    runningTasks,
    reportsCount,
    alerts
  };
}

function execute(args: string[], label: string): void {
  info('Mở ' + label + '…');
  const res = spawnSync(args[0], args.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32' && args[0] === 'npm'
  });
  if (res.error) fail(res.error.message);
  else if (res.status !== 0) warn(`${label}: mã thoát ${res.status ?? 'unknown'}`);
  else success(`${label} đã hoàn tất`);
}

async function pause(): Promise<void> {
  if (!stdin.isTTY) return;
  const r = createInterface({ input: stdin, output: stdout });
  try {
    await r.question('\n  Nhấn Enter để quay về Command Deck… ');
  } finally {
    r.close();
  }
}

export async function launch(): Promise<void> {
  setupTerminalCleanup();
  await loadTheme();
  await introAnimation();

  // First-run setup check
  const firstRun = await checkFirstRunStatus();
  if (!firstRun.browserTaskConfigured) {
    header('FIRST-RUN SETUP ASSISTANT');
    renderBreadcrumb(['COMMAND DECK', 'FIRST-RUN ONBOARDING']);
    info('Chào mừng bạn đến với AutoTask AI Terminal Workstation!');
    firstRun.details.forEach(d => warn(`  • ${d}`));
    info('Bạn có thể cấu hình nhanh Browser Agent ngay bây giờ hoặc tiếp tục vào Command Deck.');

    if (stdin.isTTY) {
      const cli = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await cli.question('  ❯ Bạn có muốn khởi chạy Setup Wizard ngay bây giờ không? (Y/n)  ›  ')).trim();
        if (answer.toLowerCase() !== 'n') {
          cli.close();
          await browserSetupInteractive();
        }
      } finally {
        try { cli.close(); } catch {}
      }
    }
  }

  while (true) {
    header('COMMAND DECK  /  AI WORKSTATION');
    renderBreadcrumb(['AUTOTASK AI', 'COMMAND DECK']);

    const s = await collectWorkspaceState();

    section('BẢNG ĐIỀU KHIỂN HỆ THỐNG (LIVE WORKSPACE HUD)');
    entry('THEME MÀU', theme().theme.toUpperCase(), theme().theme === 'cyberpunk' ? 'purple' : 'cyan');
    entry(
      'MODEL MẶC ĐỊNH',
      `${s.defaultModel} [${s.defaultProvider.toUpperCase()}] (${s.modelProfilesCount} profile)`,
      s.modelProfilesCount ? 'aqua' : 'orange'
    );
    entry('TÀI KHOẢN ĐÃ LƯU', `${s.accountsCount} profile trong OS Keyring`, s.accountsCount ? 'green' : 'orange');
    entry('BROWSER AGENT', s.browserAgentStatus, s.browserConfigExists ? 'green' : 'orange');
    entry('TÁC VỤ ĐANG CHẠY', `${s.runningTasks} tác vụ`, s.runningTasks ? 'cyan' : 'muted');
    entry('HÀNG ĐỢI (QUEUE)', `${s.queuedTasks} tác vụ đang chờ`, s.queuedTasks ? 'purple' : 'muted');
    entry(
      'DEADLINE RADAR',
      `${s.alerts.urgent} bài ≤24h  ·  ${s.alerts.overdue} bài quá hạn`,
      s.alerts.urgent || s.alerts.overdue ? 'red' : 'green'
    );

    if (!s.browserConfigExists) {
      warn('Chưa có cấu hình tác vụ trình duyệt (.private/browser-task.json). Hãy chọn [11] Setup Wizard.');
    }

    const action = await selectMenu('MENU CHÍNH (ĐIỀU HƯỚNG BẰNG PHÍM MŨI TÊN HOẶC SỐ)', menu);
    if (action === '0' || action.toLowerCase() === 'exit') {
      close('PHIÊN LÀM VIỆC ĐÃ ĐÓNG AN TOÀN');
      break;
    }

    if (action === '1') {
      if (!s.browserConfigExists) {
        warn('Chưa có cấu hình .private/browser-task.json. Mở Setup Wizard...');
        await browserSetupInteractive();
      } else {
        execute(['npm', 'run', 'browser'], 'Browser Agent');
      }
    } else if (action === '2') {
      execute(['npm', 'run', 'desktop'], 'Desktop Computer Use');
    } else if (action === '3') {
      execute(['npm', 'run', 'discover'], 'LMS & Course Discovery');
    } else if (action === '4') {
      await runTaskQueueCli();
    } else if (action === '5') {
      await runModelCenter();
    } else if (action === '6') {
      await runAccountsConsole();
    } else if (action === '7') {
      execute(['npm', 'run', 'notes'], 'AI Notes');
    } else if (action === '8') {
      await runDeadlineRadarCli();
    } else if (action === '9') {
      await showReports();
    } else if (action === '10') {
      await runAppearanceStudio();
      await loadTheme();
    } else if (action === '11') {
      const { main: runSetup } = await import('./setup.js');
      await runSetup();
    } else if (action === '12') {
      execute(['npm', 'run', 'doctor'], 'System Doctor');
    } else {
      warn('Lựa chọn không hợp lệ.');
    }

    await pause();
  }
}

if (process.argv[1] && /(?:^|[\\/])launcher\.(?:ts|js)$/.test(process.argv[1])) {
  launch().catch(e => {
    fail(String(e));
    process.exitCode = 1;
  });
}
