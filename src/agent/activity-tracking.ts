/** Activity tracking & local test URL helpers shared by Quiz and Assignment solvers */
import type { AgentContext } from './types.js';

export function isLocalTestUrl(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

export interface CheckedActivityRecord {
  url: string;
  title?: string;
  state: 'COMPLETED' | 'CLOSED' | 'OPEN' | 'SOLVED_NOW';
  details: string;
  grade?: string;
  canReattempt?: boolean;
  isClosed?: boolean;
  completionConfirmed?: boolean;
}

export function normalizeActivityUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('sesskey');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function recordCheckedActivity(
  ctx: AgentContext,
  url: string,
  state: 'COMPLETED' | 'CLOSED' | 'OPEN' | 'SOLVED_NOW',
  details: string,
  title?: string,
  grade?: string,
  canReattempt?: boolean,
  isClosed?: boolean,
  completionConfirmed?: boolean
): void {
  const norm = normalizeActivityUrl(url);
  if (!ctx.collectedFindings['activityStatusMap'] || typeof ctx.collectedFindings['activityStatusMap'] !== 'object') {
    ctx.collectedFindings['activityStatusMap'] = {};
  }
  const map = ctx.collectedFindings['activityStatusMap'] as Record<string, CheckedActivityRecord>;
  map[norm] = {
    url: norm,
    title: title || map[norm]?.title,
    state,
    details,
    grade: grade ?? map[norm]?.grade,
    canReattempt: canReattempt !== undefined ? canReattempt : map[norm]?.canReattempt,
    isClosed: isClosed !== undefined ? isClosed : map[norm]?.isClosed,
    completionConfirmed: completionConfirmed !== undefined ? completionConfirmed : map[norm]?.completionConfirmed
  };
}

export function getCheckedActivity(ctx: AgentContext, url: string): CheckedActivityRecord | undefined {
  const map = ctx.collectedFindings['activityStatusMap'] as Record<string, CheckedActivityRecord> | undefined;
  if (!map) return undefined;
  return map[normalizeActivityUrl(url)];
}
