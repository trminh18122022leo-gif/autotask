/** Interactive Setup Wizard for AutoTask AI. Supports multi-site, multi-account, and edit mode. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  header,
  section,
  choice,
  entry,
  info,
  success,
  warn,
  fail,
  close,
  renderBreadcrumb,
  toast
} from './ui/tokyo.js';
import { ensureAllowed } from './config.js';
import { listAccounts } from './accounts.js';
import { platformForUrl } from './platforms.js';
import type { AppConfig, Task } from './types.js';

interface ModelProfileDb {
  default?: string;
  profiles: Record<string, { provider: string; model: string; kind: string; endpoint: string }>;
}

async function getProfileDb(): Promise<ModelProfileDb> {
  try {
    return JSON.parse(await readFile('.private/model-profiles.json', 'utf8'));
  } catch {
    return { default: undefined, profiles: {} };
  }
}

async function writeConfigSafe(name: string, data: object): Promise<void> {
  await mkdir('.private', { recursive: true });
  const path = resolve('.private', name);
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'w', mode: 0o600 });
  success(`Đã lưu cấu hình an toàn: ${path}`);
}

function isId(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,48}$/.test(s);
}

function cleanUrl(s: string): string {
  const url = new URL(s);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Chỉ chấp nhận URL HTTP(S) an toàn không nhúng mật khẩu');
  }
  return url.toString();
}

/** Check first-run configuration state */
export async function checkFirstRunStatus(): Promise<{
  modelConfigured: boolean;
  accountConfigured: boolean;
  browserTaskConfigured: boolean;
  details: string[];
}> {
  const modelDb = await getProfileDb();
  const accounts = await listAccounts();
  const hasBrowserTask = existsSync('.private/browser-task.json');

  const modelConfigured = Boolean(modelDb.default && modelDb.profiles[modelDb.default]);
  const accountConfigured = Object.keys(accounts).length > 0;
  const browserTaskConfigured = hasBrowserTask;

  const details: string[] = [];
  if (!modelConfigured) details.push('Chưa cấu hình Model AI chính (Model Center / Model Vault)');
  if (!accountConfigured) details.push('Chưa có tài khoản LMS/Web nào được lưu (Account Vault)');
  if (!browserTaskConfigured) details.push('Chưa có file cấu hình tác vụ trình duyệt (.private/browser-task.json)');

  return { modelConfigured, accountConfigured, browserTaskConfigured, details };
}

export async function browserSetupInteractive(existingConfig?: AppConfig): Promise<boolean> {
  const cli = createInterface({ input: stdin, output: stdout });
  const ask = async (promptText: string, def = ''): Promise<string> => {
    const hint = def ? ` [${def}]` : '';
    const ans = (await cli.question(`  ❯ ${promptText}${hint}  ›  `)).trim();
    return ans || def;
  };

  try {
    section(existingConfig ? 'CHỈNH SỬA CẤU HÌNH BROWSER AGENT' : 'THIẾT LẬP CẤU HÌNH BROWSER AGENT');
    info('Cấu hình cho phép kiểm soát danh sách website được duyệt và tài khoản thực thi.');

    // 1. Model selection
    const modelDb = await getProfileDb();
    const availableProfiles = Object.keys(modelDb.profiles);
    let selectedProfileId = existingConfig?.provider?.profileId || modelDb.default;

    if (!selectedProfileId && availableProfiles.length > 0) {
      selectedProfileId = availableProfiles[0];
    }

    if (!selectedProfileId) {
      warn('Chưa có Model AI nào trong Model Vault.');
      info('Gợi ý: Bạn có thể tiếp tục tạo cấu hình và thêm model ID thủ công.');
      selectedProfileId = await ask('Nhập tạm Profile ID hoặc Model ID', 'default-model');
    } else {
      entry('MODEL MẶC ĐỊNH', `${selectedProfileId} (${modelDb.profiles[selectedProfileId]?.model || 'model'})`, 'aqua');
      if (availableProfiles.length > 1) {
        info(`Các profile khả dụng: ${availableProfiles.join(', ')}`);
        const change = (await ask(`Dùng model profile khác? (Để trống giữ ${selectedProfileId})`, '')).trim();
        if (change && availableProfiles.includes(change)) {
          selectedProfileId = change;
        }
      }
    }

    // 2. Websites / Allowed Hosts
    section('1. Danh sách Website được phép (Multi-site)');
    const defaultSites = existingConfig?.allowedHosts?.join(', ') || 'courses.hust.edu.vn, forms.google.com';
    const sitesInput = await ask('Nhập các host được phép (cách nhau bằng dấu phẩy)', defaultSites);
    const allowedHosts = sitesInput
      .split(',')
      .map(s => {
        let clean = s.trim().toLowerCase();
        clean = clean.replace(/^https?:\/\//, '').split('/')[0];
        return clean;
      })
      .filter(Boolean);

    if (!allowedHosts.length) throw new Error('Cần ít nhất một website được phép trong allowedHosts');
    entry('ALLOWED HOSTS', allowedHosts.join(', '), 'green');

    // 3. Primary activity / dashboard URL
    section('2. URL Trang khởi đầu / Khám phá');
    const defaultUrl = existingConfig?.discoveryStartUrls?.[0] || existingConfig?.deadlinePages?.[0] || `https://${allowedHosts[0]}/`;
    const primaryUrlRaw = await ask('URL trang bài tập hoặc dashboard chính', defaultUrl);
    const primaryUrl = cleanUrl(primaryUrlRaw);
    const primaryHost = new URL(primaryUrl).hostname.toLowerCase();
    if (!allowedHosts.includes(primaryHost)) {
      allowedHosts.push(primaryHost);
      info(`Đã tự động thêm ${primaryHost} vào danh sách allowedHosts.`);
    }

    // 4. Accounts selection
    section('3. Tài khoản người dùng (Account Vault)');
    const accounts = await listAccounts();
    const accountIds = Object.keys(accounts);
    let chosenAccountId: string | undefined = existingConfig?.accountId;

    if (accountIds.length > 0) {
      info(`Các tài khoản đã lưu: ${accountIds.join(', ')}`);
      const defaultAcc = chosenAccountId || accountIds[0];
      const accChoice = await ask(`Chọn account ID để tự động đăng nhập (để trống: không dùng session tự động)`, defaultAcc);
      if (accChoice && accountIds.includes(accChoice)) {
        chosenAccountId = accChoice;
        entry('TÀI KHOẢN ĐÃ CHỌN', `${chosenAccountId} (${accounts[chosenAccountId].loginHost})`, 'aqua');
      } else {
        chosenAccountId = undefined;
        info('Chế độ: Đăng nhập thủ công qua trình duyệt Chromium khi cần.');
      }
    } else {
      info('Chưa có tài khoản nào được lưu trong Account Vault. Sẽ dùng cửa sổ trình duyệt thủ công.');
      chosenAccountId = undefined;
    }

    // 5. Automation settings
    section('4. Thiết lập quét & duyệt');
    const autoDiscoverInput = await ask('Tự động quét danh sách môn học, bài tập & deadline? (y/n)', existingConfig?.autoDiscover !== false ? 'y' : 'n');
    const autoDiscover = autoDiscoverInput.toLowerCase() !== 'n';

    const tabsInput = await ask('Số tab trình duyệt chạy song song (1–3)', String(existingConfig?.parallelTabs || 2));
    const parallelTabs = Math.max(1, Math.min(3, parseInt(tabsInput, 10) || 2));

    const maxPagesInput = await ask('Giới hạn số trang quét bài (1–50)', String(existingConfig?.maxDiscoveryPages || 20));
    const maxDiscoveryPages = Math.max(1, Math.min(50, parseInt(maxPagesInput, 10) || 20));

    const watchMinInput = await ask('Thời gian chờ cổng đọc tài liệu FAMI nếu gặp (phút, 0–30)', String(existingConfig?.accessWatchMinutes || 0));
    const accessWatchMinutes = Math.max(0, Math.min(30, parseInt(watchMinInput, 10) || 0));

    // 6. Direct task URL (optional)
    section('5. Tác vụ chỉ định cụ thể (Tùy chọn)');
    const directTaskUrl = await ask('URL trực tiếp đến một bài tập cụ thể (nếu có)', existingConfig?.tasks?.[0]?.url || '');
    let tasks: Task[] = [];
    if (directTaskUrl) {
      const safeDirect = cleanUrl(directTaskUrl);
      const host = new URL(safeDirect).hostname.toLowerCase();
      if (!allowedHosts.includes(host)) allowedHosts.push(host);
      tasks = [
        {
          id: existingConfig?.tasks?.[0]?.id || 'task-1',
          url: safeDirect,
          aiPermitted: true,
          maxPages: existingConfig?.tasks?.[0]?.maxPages || 8
        }
      ];
    } else if (existingConfig?.tasks && existingConfig.tasks.length > 0) {
      tasks = existingConfig.tasks;
    }

    const modeInput=(await ask('Chế độ: READ_ONLY hoặc PRACTICE_ASSISTED (chỉ bài tự luyện được phép)', existingConfig?.operationMode||'READ_ONLY')).trim().toUpperCase();
    if (!['READ_ONLY','PRACTICE_ASSISTED','ASSESSMENT_RESTRICTED'].includes(modeInput)) throw new Error('Chế độ không hợp lệ');
    const answerFile=(await ask('Tệp đáp án có sẵn (JSON/CSV/TSV/TXT/MD, bỏ trống nếu chưa có)', existingConfig?.answerFilePaths?.[0]||'')).trim();
    const config: AppConfig = {
      ...(answerFile?{answerFilePaths:[answerFile]}:{}),
      allowedHosts,
      operationMode: modeInput as AppConfig['operationMode'],
      approvedForAIUse: true,
      parallelTabs,
      accountId: chosenAccountId,
      authUrls: [],
      deadlinePages: [primaryUrl],
      autoDiscover,
      discoveryStartUrls: autoDiscover ? [primaryUrl] : [],
      maxDiscoveryPages,
      accessWatchMinutes,
      tasks,
      provider: {
        profileId: selectedProfileId,
        allowVision: true
      },
      fallbackProfileIds: existingConfig?.fallbackProfileIds || [],
      deadlineOffset: '+07:00'
    };

    section('XÁC NHẬN LƯU CẤU HÌNH');
    entry('ALLOWED HOSTS', config.allowedHosts.join(', '), 'green');
    entry('URL CHÍNH', primaryUrl, 'cyan');
    entry('TÀI KHOẢN', chosenAccountId || 'Đăng nhập thủ công', 'purple');
    entry('MODEL PROFILE', selectedProfileId, 'aqua');
    entry('TỰ ĐỘNG QUÉT', autoDiscover ? 'BẬT' : 'TẮT', autoDiscover ? 'green' : 'orange');

    const confirm = await ask('Lưu cấu hình vào .private/browser-task.json? (Y/n)', 'y');
    if (confirm.toLowerCase() === 'n') {
      warn('Đã hủy lưu cấu hình.');
      return false;
    }

    await writeConfigSafe('browser-task.json', config);
    toast('success', 'Cấu hình Browser Agent đã được lưu thành công!');
    return true;
  } catch (err) {
    fail(`Lỗi thiết lập: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    cli.close();
  }
}

export async function desktopSetupInteractive(): Promise<boolean> {
  const cli = createInterface({ input: stdin, output: stdout });
  const ask = async (promptText: string, def = ''): Promise<string> => {
    const hint = def ? ` [${def}]` : '';
    const ans = (await cli.question(`  ❯ ${promptText}${hint}  ›  `)).trim();
    return ans || def;
  };

  try {
    section('THIẾT LẬP DESKTOP COMPUTER USE');
    const windowTitleIncludes = await ask('Chuỗi ký tự nhận diện tiêu đề cửa sổ cần điều khiển', 'Notepad');
    if (windowTitleIncludes.length < 2) throw new Error('Tiêu đề cửa sổ phải có ít nhất 2 ký tự');

    const goal = await ask('Mục tiêu tác vụ tự động hóa', 'Ghi chú và tương tác trên cửa sổ');
    const taskId = await ask('Mã tác vụ (Task ID)', 'desktop-task-1');
    if (!isId(taskId)) throw new Error('Task ID không hợp lệ (chỉ chữ, số, gạch nối/dưới)');

    const modelDb = await getProfileDb();
    const p = modelDb.default;
    if (!p) warn('Chưa có model mặc định; vui lòng thêm model trong Model Center trước khi chạy');

    const config = {
      taskId,
      windowTitleIncludes,
      goal,
      maxSteps: 25,
      shareScreenshotWithAI: true,
      allowVisualClicks: true,
      allowUnmappedVisualClicks: false,
      fallbackProfileIds: [],
      ...(p ? { provider: { profileId: p } } : {})
    };

    const confirm = await ask('Lưu cấu hình vào .private/desktop-task.json? (Y/n)', 'y');
    if (confirm.toLowerCase() === 'n') {
      warn('Đã hủy');
      return false;
    }

    await writeConfigSafe('desktop-task.json', config);
    toast('success', 'Cấu hình Desktop Agent đã lưu thành công!');
    return true;
  } catch (err) {
    fail(`Lỗi thiết lập desktop: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    cli.close();
  }
}

export async function main(): Promise<void> {
  header('SETUP WIZARD');
  renderBreadcrumb(['COMMAND DECK', 'SETUP WIZARD']);

  const status = await checkFirstRunStatus();
  section('Tình trạng cấu hình hiện tại');
  entry('MODEL AI', status.modelConfigured ? 'ĐÃ CẤU HÌNH' : 'CHƯA CÓ MODEL MẶC ĐỊNH', status.modelConfigured ? 'green' : 'orange');
  entry('ACCOUNT VAULT', status.accountConfigured ? 'ĐÃ CÓ TÀI KHOẢN' : 'CHƯA CÓ TÀI KHOẢN', status.accountConfigured ? 'green' : 'orange');
  entry('BROWSER TASK', status.browserTaskConfigured ? 'ĐÃ CÓ (.private/browser-task.json)' : 'CHƯA CÓ', status.browserTaskConfigured ? 'green' : 'orange');

  section('Lựa chọn cấu hình');
  choice('1', 'Browser Agent', 'Cấu hình multi-site, multi-account cho bài tập và LMS web');
  choice('2', 'Desktop Computer Use', 'Điều khiển và quan sát cửa sổ Windows');
  choice('0', 'Quay lại', 'Trở về Command Deck');

  const cli = createInterface({ input: stdin, output: stdout });
  const sel = (await cli.question('  ❯ Chọn (0–2)  ›  ')).trim();
  cli.close();

  if (sel === '1') {
    let existing: AppConfig | undefined;
    if (existsSync('.private/browser-task.json')) {
      try {
        existing = JSON.parse(await readFile('.private/browser-task.json', 'utf8'));
      } catch {}
    }
    await browserSetupInteractive(existing);
  } else if (sel === '2') {
    await desktopSetupInteractive();
  } else {
    info('Không có thay đổi.');
  }

  close('SETUP HOÀN TẤT');
}

if (process.argv[1] && /(?:^|[\\/])setup\.(?:ts|js)$/.test(process.argv[1])) {
  void main();
}
