/** Interactive Task Queue Command Center.
 * Provides real-time job monitoring, step tracking, pause/resume, retry, and checkpoint inspector.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
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
  renderTable,
  renderErrorCard,
  toast,
  pill
} from './tokyo.js';
import { loadTheme } from './themes.js';
import {
  listAllCheckpoints,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  type TaskCheckpoint,
  type ExtendedJobStatus
} from '../task-manager.js';
import { QueueStore, type QueueState, type JobState } from '../desktop-queue.js';
import type { AppConfig } from '../types.js';

async function promptInput(msg: string, def = ''): Promise<string> {
  const cli = createInterface({ input: stdin, output: stdout });
  try {
    const hint = def ? ` [${def}]` : '';
    const ans = (await cli.question(`  ❯ ${msg}${hint}  ›  `)).trim();
    return ans || def;
  } finally {
    cli.close();
  }
}

export async function runTaskQueueCli(): Promise<void> {
  await loadTheme();
  while (true) {
    header('TASK QUEUE  /  JOB MANAGEMENT');
    renderBreadcrumb(['COMMAND DECK', 'TASK QUEUE']);

    // Load tasks from both browser config and desktop queue and checkpoints
    const checkpoints = await listAllCheckpoints();
    const cpMap = new Map(checkpoints.map(cp => [cp.taskId, cp]));

    let browserConfig: AppConfig | undefined;
    try {
      browserConfig = JSON.parse(await readFile('.private/browser-task.json', 'utf8'));
    } catch {}

    const store = new QueueStore(resolve('.private', 'desktop-queue.json'));
    const desktopQueue = await store.load();

    // Consolidate jobs
    const allJobs: {
      id: string;
      type: 'BROWSER' | 'DESKTOP';
      status: ExtendedJobStatus;
      steps: string;
      website: string;
      deadline: string;
      model: string;
      priority: number;
      error?: string;
    }[] = [];

    // Browser tasks
    if (browserConfig && Array.isArray(browserConfig.tasks)) {
      for (const t of browserConfig.tasks) {
        const cp = cpMap.get(t.id);
        const host = new URL(t.url).hostname;
        allJobs.push({
          id: t.id,
          type: 'BROWSER',
          status: cp?.status || 'PENDING',
          steps: cp ? `${cp.questionsFilled}/${cp.questionsFound || t.maxPages || '?'}` : `0/${t.maxPages || 1}`,
          website: host,
          deadline: cp?.deadline || 'N/A',
          model: cp?.modelUsed || browserConfig.provider.profileId || browserConfig.provider.model || 'default',
          priority: cp?.priority || 1,
          error: cp?.error
        });
      }
    }

    // Desktop queue jobs
    if (desktopQueue && Array.isArray(desktopQueue.jobs)) {
      for (const j of desktopQueue.jobs) {
        const cp = cpMap.get(j.id);
        allJobs.push({
          id: j.id,
          type: 'DESKTOP',
          status: cp?.status || (j.status as ExtendedJobStatus),
          steps: `${j.steps} bước`,
          website: 'Windows UIA',
          deadline: 'N/A',
          model: cp?.modelUsed || 'default',
          priority: 2,
          error: j.error || cp?.error
        });
      }
    }

    section('DANH SÁCH TÁC VỤ (WORK QUEUE)');
    if (!allJobs.length) {
      info('Hiện chưa có tác vụ nào trong hàng đợi.');
      info('Bạn có thể cấu hình thêm tác vụ trong Setup Wizard hoặc LMS Discovery.');
    } else {
      const headers = ['Task ID', 'Loại', 'Trạng thái', 'Tiến độ', 'Website / Nền tảng', 'Model', 'Ưu tiên'];
      const rows = allJobs.map(j => [
        j.id,
        j.type,
        j.status,
        j.steps,
        j.website,
        j.model,
        `P${j.priority}`
      ]);
      renderTable(headers, rows);
    }

    section('THAO TÁC QUẢN LÝ');
    choice('1', 'Xem Chi Tiết Tác Vụ & Checkpoint', 'Xem chi tiết câu hỏi, thời gian thực thi & nguyên nhân lỗi');
    choice('2', 'Tiếp Tục Tác Vụ (Resume from Checkpoint)', 'Khôi phục và chạy tiếp tác vụ từ điểm dừng');
    choice('3', 'Thử Lại Tác Vụ (Retry Failed Task)', 'Đặt lại trạng thái PENDING để chạy lại');
    choice('4', 'Tạm Dừng Tác Vụ (Pause Task)', 'Chuyển sang trạng thái PAUSED');
    choice('5', 'Dọn Dẹp Checkpoint Đã Xong (Clear Completed)', 'Xóa các checkpoint của tác vụ đã xong');
    choice('0', 'Quay lại', 'Trở về Command Deck');

    const sel = await promptInput('Lựa chọn (0–5)');
    if (sel === '0') break;

    if (sel === '1') {
      const tId = await promptInput('Nhập Task ID muốn xem');
      const cp = await loadCheckpoint(tId);
      if (cp) {
        section(`CHI TIẾT CHECKPOINT: ${tId}`);
        entry('STATUS', cp.status, cp.status === 'COMPLETED' ? 'green' : cp.status === 'FAILED' ? 'red' : 'orange');
        entry('URL', cp.url, 'cyan');
        entry('QUESTIONS', `${cp.questionsFilled}/${cp.questionsFound}`, 'aqua');
        entry('MODEL USED', cp.modelUsed || 'default', 'purple');
        entry('CẬP NHẬT LẦN CUỐI', cp.lastUpdated, 'muted');
        if (cp.runtimeMs) entry('RUNTIME', `${Math.round(cp.runtimeMs / 1000)}s`, 'fg');
        if (cp.error) {
          renderErrorCard(
            `Lỗi tác vụ: ${cp.error}`,
            cp.cause || 'Không rõ nguyên nhân',
            'Sử dụng tùy chọn [3] Thử lại sau khi kiểm tra kết nối mạng hoặc model.'
          );
        }
      } else {
        warn(`Không tìm thấy checkpoint cho tác vụ "${tId}".`);
      }
      await promptInput('Nhấn Enter để tiếp tục...');
    } else if (sel === '2') {
      const tId = await promptInput('Nhập Task ID muốn tiếp tục (Resume)');
      const cp = await loadCheckpoint(tId);
      if (cp) {
        cp.status = 'PENDING';
        await saveCheckpoint(cp);
        toast('success', `Tác vụ "${tId}" đã được đưa trở lại trạng thái PENDING để tiếp tục!`);
      } else {
        warn('Không tìm thấy checkpoint');
      }
    } else if (sel === '3') {
      const tId = await promptInput('Nhập Task ID muốn thử lại (Retry)');
      const cp = await loadCheckpoint(tId);
      if (cp) {
        cp.status = 'PENDING';
        cp.error = undefined;
        cp.cause = undefined;
        await saveCheckpoint(cp);
        toast('success', `Đã reset trạng thái tác vụ "${tId}" về PENDING!`);
      } else {
        warn('Không tìm thấy tác vụ');
      }
    } else if (sel === '4') {
      const tId = await promptInput('Nhập Task ID muốn tạm dừng (Pause)');
      const cp = await loadCheckpoint(tId);
      if (cp) {
        cp.status = 'PAUSED';
        await saveCheckpoint(cp);
        toast('warn', `Tác vụ "${tId}" đã tạm dừng.`);
      }
    } else if (sel === '5') {
      for (const cp of checkpoints) {
        if (cp.status === 'COMPLETED') {
          await clearCheckpoint(cp.taskId);
        }
      }
      toast('success', 'Đã dọn dẹp các checkpoint đã hoàn thành!');
    }
  }
}

if (process.argv[1] && /(?:^|[\\/])task-queue-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runTaskQueueCli();
}
