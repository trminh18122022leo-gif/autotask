/** Interactive Account Vault console for terminal workstation. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  header,
  section,
  choice,
  entry,
  info,
  warn,
  close,
  renderBreadcrumb,
  renderTable,
  toast
} from './tokyo.js';
import { loadTheme } from './themes.js';
import { listAccounts, forgetSession } from '../accounts.js';

const python = process.env.AUTOTASK_PYTHON || 'python';

export async function runAccountsConsole(): Promise<void> {
  await loadTheme();
  while (true) {
    header('ACCOUNT VAULT  /  LMS & WEB CREDENTIALS');
    renderBreadcrumb(['COMMAND DECK', 'ACCOUNT VAULT']);

    info('Mật khẩu và thông tin đăng nhập được lưu mã hóa an toàn trong Windows Credential Manager.');
    info('Phiên trình duyệt (Cookies) được lưu trữ riêng biệt tại .private/sessions/<accountId>.');

    const accounts = await listAccounts();
    const accountIds = Object.keys(accounts);

    section('DANH SÁCH TÀI KHOẢN ĐÃ LƯU');
    if (!accountIds.length) {
      warn('Chưa có tài khoản nào được cấu hình trong Account Vault.');
    } else {
      const headers = ['Account ID', 'Login Host', 'Trusted SSO Hosts', 'Session Saved?'];
      const rows = accountIds.map(id => {
        const acc = accounts[id];
        const sDir = resolve('.private', 'sessions', id);
        const hasSession = existsSync(sDir) ? '✓ CÓ' : 'Chưa có';
        const trusted = (acc.trustedLoginHosts || []).join(', ') || 'None';
        return [id, acc.loginHost, trusted, hasSession];
      });
      renderTable(headers, rows);
    }

    section('THAO TÁC');
    choice('1', 'Thêm Tài Khoản Mới (Add Account)', 'Nhập URL, username và password lưu vào OS Keyring');
    choice('2', 'Xóa Tài Khoản (Remove Account)', 'Gỡ tài khoản và mật khẩu khỏi Windows Credential Manager');
    choice('3', 'Xóa Phiên Đăng Nhập / Cookies (Forget Session)', 'Xóa cache cookies của một tài khoản');
    choice('0', 'Quay lại', 'Trở về Command Deck');

    const cli = createInterface({ input: stdin, output: stdout });
    const sel = (await cli.question('  ❯ Chọn (0–3)  ›  ')).trim();
    cli.close();

    if (sel === '0') break;

    if (sel === '1') {
      spawnSync(python, ['desktop/accounts_cli.py'], { stdio: 'inherit' });
    } else if (sel === '2') {
      spawnSync(python, ['desktop/accounts_cli.py'], { stdio: 'inherit' });
    } else if (sel === '3') {
      const pCli = createInterface({ input: stdin, output: stdout });
      const target = (await pCli.question(`  ❯ Nhập Account ID muốn xóa session (${accountIds.join(', ')}): `)).trim();
      pCli.close();
      if (accounts[target]) {
        await forgetSession(target);
        toast('success', `Đã xóa session cookies của tài khoản ${target}!`);
      } else {
        warn('Tài khoản không tồn tại');
      }
    }
  }
}

if (process.argv[1] && /(?:^|[\\/])accounts-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runAccountsConsole();
}
