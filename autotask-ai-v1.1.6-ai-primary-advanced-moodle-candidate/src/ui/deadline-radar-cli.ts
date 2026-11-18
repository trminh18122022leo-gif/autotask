/** Interactive Deadline Radar Terminal Console. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  header,
  section,
  choice,
  entry,
  info,
  warn,
  close,
  renderBreadcrumb,
  renderTable
} from './tokyo.js';
import { loadTheme } from './themes.js';
import { recentReports, deadlineSeverity } from './dashboard.js';
import type { Deadline } from '../types.js';

export async function runDeadlineRadarCli(): Promise<void> {
  await loadTheme();
  header('DEADLINE RADAR  /  THEO DÕI HẠN NỘP');
  renderBreadcrumb(['COMMAND DECK', 'DEADLINE RADAR']);

  const reports = await recentReports(10);
  const rawDeadlines: Deadline[] = [];
  for (const r of reports) {
    rawDeadlines.push(...(r.report.deadlines || []));
  }

  // Deduplicate deadlines by source + dueAt + label
  const dedupMap = new Map<string, Deadline>();
  for (const d of rawDeadlines) {
    const key = `${d.source}|${d.dueAt}|${d.label}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, d);
    }
  }
  const allDeadlines = Array.from(dedupMap.values());

  // Recompute relative hours
  const now = Date.now();
  const processed = allDeadlines.map(d => {
    const target = Date.parse(d.dueAt);
    const diffHours = isNaN(target) ? null : (target - now) / 3600000;
    const severity = deadlineSeverity(diffHours);
    return {
      ...d,
      remainingHours: diffHours,
      severity
    };
  });

  // Sort: overdue first, then urgent, then soon, then future
  const severityOrder = { overdue: 0, urgent: 1, soon: 2, future: 3, unknown: 4 };
  processed.sort((a, b) => {
    const diff = (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5);
    if (diff !== 0) return diff;
    return (a.remainingHours ?? 99999) - (b.remainingHours ?? 99999);
  });

  const overdueCount = processed.filter(d => d.severity === 'overdue').length;
  const urgentCount = processed.filter(d => d.severity === 'urgent').length;
  const soonCount = processed.filter(d => d.severity === 'soon').length;

  section('TỔNG QUAN TÌNH TRẠNG DEADLINE');
  entry('QUÁ HẠN (OVERDUE)', `${overdueCount} bài`, overdueCount ? 'red' : 'green');
  entry('HẠN CHÓT ≤ 24H (KHẨN CẤP)', `${urgentCount} bài`, urgentCount ? 'orange' : 'green');
  entry('HẠN CHÓT ≤ 72H (SẮP TỚI)', `${soonCount} bài`, 'cyan');
  entry('TỔNG SỐ DEADLINE ĐÃ QUÉT', `${processed.length} bài`, 'purple');

  section('CHI TIẾT DANH SÁCH DEADLINE');
  if (!processed.length) {
    info('Chưa có dữ liệu deadline nào được lưu.');
    info('Hãy chạy LMS Discovery hoặc Browser Agent để tự động quét deadline từ các trang môn học.');
  } else {
    const headers = ['Mức độ', 'Tên bài tập / Hoạt động', 'Thời hạn (Due At)', 'Còn lại', 'Nguồn'];
    const rows = processed.map(d => {
      const sevLabel =
        d.severity === 'overdue'
          ? '● QUÁ HẠN'
          : d.severity === 'urgent'
          ? '● KHẨN CẤP'
          : d.severity === 'soon'
          ? '● SẮP TỚI'
          : '● TƯƠNG LAI';
      const rem =
        d.remainingHours === null
          ? 'Không rõ'
          : d.remainingHours < 0
          ? `Quá ${Math.abs(Math.round(d.remainingHours))}h`
          : `${Math.round(d.remainingHours)}h (${Math.round((d.remainingHours / 24) * 10) / 10} ngày)`;
      return [sevLabel, d.label, d.dueAt, rem, d.source];
    });
    renderTable(headers, rows);
  }

  const cli = createInterface({ input: stdin, output: stdout });
  try {
    await cli.question('\n  Nhấn Enter để quay về Command Deck... ');
  } finally {
    cli.close();
  }
}

if (process.argv[1] && /(?:^|[\\/])deadline-radar-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runDeadlineRadarCli();
}
