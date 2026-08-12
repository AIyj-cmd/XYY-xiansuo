import type { DatabaseSync } from 'node:sqlite';
import { getDatabasePath, openReadOnlyDatabase } from '../db.js';
import { resolveAiDryRunConfig } from '../config.js';
import { todayDate } from '../utils/datetime.js';
import { buildLeadContext } from '../ai/context-builder.js';
import { getActiveRecipient, overdueLeads, dailyHighlights, dailyHighlightTotal, dailyMetrics, type AiLead, type AiRecipient } from '../ai/permission-query.js';

export type DryRunJob = 'scheduled_follow_overdue' | 'daily_report';
export type DryRunReport = Record<string, unknown>;

function sortReason(job: DryRunJob): string {
  return job === 'scheduled_follow_overdue'
    ? 'next_follow_at ASC → intent 高/中/低/未知 → last_follow_at ASC → lead_id ASC'
    : '重点优先级（历史/当日到期 → 高意向 → 次日到期）→ next_follow_at ASC → last_follow_at ASC → lead_id ASC';
}
function isoShanghai(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
}
function evidence(items: AiLead[], displayedIds: ReadonlySet<number>, itemRefs: Map<number, string>, job: DryRunJob): Array<Record<string, unknown>> {
  return items.flatMap((lead, index) => !displayedIds.has(lead.id) ? [] : [{
    rank: index + 1, item_ref: itemRefs.get(lead.id), internal_lead_id: lead.id,
    next_follow_at: isoShanghai(lead.next_follow_at), intent_level: lead.intent_level,
    last_follow_at: isoShanghai(lead.last_follow_at), sort_reason: sortReason(job),
  }]);
}

/** Pure read-only inspection result. The caller owns a SQLite read-only connection. */
export function buildAiDryRunReport(db: DatabaseSync, input: { job: DryRunJob; userId: number; businessDate: string; maxContextChars: number; maxFollowUpRecords: number }): DryRunReport {
  const recipient = getActiveRecipient(db, input.userId); if (!recipient) throw new Error('接收人不存在或已停用');
  const source = input.job === 'scheduled_follow_overdue'
    ? overdueLeads(db, recipient, input.businessDate)
    : { total: dailyHighlightTotal(db, recipient, input.businessDate), leads: dailyHighlights(db, recipient, input.businessDate) };
  const context = buildLeadContext(db, source.leads, input.businessDate, input.maxContextChars, input.maxFollowUpRecords);
  const ids = new Set(context.items.map((item) => item.lead_id));
  const refs = new Map(context.items.map((item) => [item.lead_id, item.item_ref]));
  return {
    job: input.job, recipient_user_id: recipient.id, scope: input.job === 'scheduled_follow_overdue' ? 'self' : (recipient.role === 'admin' ? 'team' : 'self'),
    business_date: input.businessDate, timezone: 'Asia/Shanghai', candidate_total_count: source.total,
    queried_candidate_count: source.leads.length, displayed_candidate_count: context.items.length,
    sorting_rule_version: 'phase4.5-v1', sorted_candidates: evidence(source.leads, ids, refs, input.job),
    context_hash: context.hash, context_chars: context.chars,
    clipping: { query_cap_count: Math.max(0, source.total - source.leads.length), context_cap_count: Math.max(0, source.leads.length - context.items.length), omitted_total_count: Math.max(0, source.total - context.items.length) },
    redaction: '未查询或输出公司、联系人、手机号、微信号、需求全文、跟进正文、通知正文或AI结果正文',
    ...(input.job === 'daily_report' ? { metrics: dailyMetrics(db, recipient, input.businessDate) } : {}),
  };
}

function argument(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
export function runAiDryRunCli(args = process.argv, databasePath = getDatabasePath()): void {
  const job = argument(args, '--job') as DryRunJob | undefined;
  const userId = Number(argument(args, '--user-id')); const businessDate = argument(args, '--business-date'); const date = businessDate ?? todayDate();
  if ((args.includes('--business-date') && businessDate === undefined) || (job !== 'scheduled_follow_overdue' && job !== 'daily_report') || !Number.isInteger(userId) || userId < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('用法: ai:dry-run --job scheduled_follow_overdue|daily_report --user-id 正整数 [--business-date YYYY-MM-DD]');
  const config = resolveAiDryRunConfig(); const db = openReadOnlyDatabase(databasePath);
  try { console.log(JSON.stringify(buildAiDryRunReport(db, { job, userId, businessDate: date, maxContextChars: config.maxContextChars, maxFollowUpRecords: config.maxFollowUpRecords }))); } finally { db.close(); }
}
if (process.argv[1]?.endsWith('ai-dry-run.ts') || process.argv[1]?.endsWith('ai-dry-run.js')) runAiDryRunCli();
