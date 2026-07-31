import type { DatabaseSync } from 'node:sqlite';

export type AiRecipient = { id: number; role: 'admin' | 'member'; is_active: number };
export type AiLead = { id: number; company_name: string | null; contact_name: string; status: string; source: string; demand_note: string | null; intent_level: string; last_follow_at: string | null; next_follow_at: string | null };
export type AiFollowUp = { type: string; content: string; result: string | null; next_follow_at: string | null; created_at: string };
export function getActiveRecipient(db: DatabaseSync, userId: number): AiRecipient | undefined {
  return db.prepare("SELECT id,role,is_active FROM users WHERE id=? AND is_active=1 AND role IN ('admin','member')").get(userId) as AiRecipient | undefined;
}
export function listPilotRecipients(db: DatabaseSync, ids: readonly number[], limit: number): AiRecipient[] {
  if (!ids.length) return []; const marks = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id,role,is_active FROM users WHERE is_active=1 AND id IN (${marks}) ORDER BY id ASC LIMIT ?`).all(...ids, limit) as AiRecipient[];
}
function scopeClause(recipient: AiRecipient): { sql: string; values: number[] } { return recipient.role === 'admin' ? { sql: 'l.is_deleted=0', values: [] } : { sql: 'l.owner_id=? AND l.is_deleted=0', values: [recipient.id] }; }
const selectedLeadFields = 'l.id,l.company_name,l.contact_name,l.status,l.source,l.demand_note,l.intent_level,l.last_follow_at,l.next_follow_at';
export function overdueLeads(db: DatabaseSync, recipient: AiRecipient, businessDate: string): { total: number; leads: AiLead[] } {
  // A scheduled overdue digest is always personal, including when its recipient
  // is an admin. Team scope is limited to daily report below.
  const scope = { sql: 'l.owner_id=? AND l.is_deleted=0', values: [recipient.id] }; const end = `${businessDate} 23:59:59`;
  const where = `${scope.sql} AND l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)<=datetime(?) AND l.status NOT IN ('已成交','已流失','停止跟进')`;
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM leads l WHERE ${where}`).get(...scope.values, end) as { count: number }).count;
  const leads = db.prepare(`SELECT ${selectedLeadFields} FROM leads l WHERE ${where} ORDER BY datetime(l.next_follow_at) ASC, CASE l.intent_level WHEN '高' THEN 0 WHEN '中' THEN 1 WHEN '低' THEN 2 ELSE 3 END ASC, CASE WHEN l.last_follow_at IS NULL THEN 0 ELSE 1 END ASC, datetime(l.last_follow_at) ASC, l.id ASC LIMIT 10`).all(...scope.values, end) as AiLead[];
  return { total, leads };
}
export function recentFollowUps(db: DatabaseSync, leadId: number, businessDate: string, limit = 3): AiFollowUp[] {
  const cutoff = `${businessDate} 23:59:59`;
  return db.prepare(`SELECT type,content,result,next_follow_at,created_at FROM follow_ups
    WHERE lead_id=? AND datetime(created_at)>=datetime(?, '-60 days') AND datetime(created_at)<=datetime(?)
    ORDER BY datetime(created_at) DESC,id DESC LIMIT ?`).all(leadId, cutoff, cutoff, limit) as AiFollowUp[];
}
export type DailyMetrics = { today_new_count: number; today_follow_up_count: number; overdue_count: number; next_day_count: number };
export function dailyMetrics(db: DatabaseSync, recipient: AiRecipient, businessDate: string, asOf = `${businessDate} 23:59:59`): DailyMetrics {
  const scope = scopeClause(recipient); const start = `${businessDate} 00:00:00`; const plusDays = (days: number) => new Date(new Date(`${businessDate}T00:00:00+08:00`).getTime() + days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); const tomorrow = plusDays(1); const dayAfter = plusDays(2); const end = `${tomorrow} 00:00:00`;
  const dueCutoff = asOf < end ? asOf : end;
  const leadsWhere = scope.sql; const author = recipient.role === 'admin' ? '1=1' : 'f.user_id=?'; const authorVals = recipient.role === 'admin' ? [] : [recipient.id];
  const count = (sql: string, ...values: any[]) => (db.prepare(sql).get(...values) as { count: number }).count;
  return {
    today_new_count: count(`SELECT COUNT(*) AS count FROM leads l WHERE ${leadsWhere} AND datetime(l.created_at)>=datetime(?) AND datetime(l.created_at)<datetime(?)`, ...scope.values, start, end),
    today_follow_up_count: count(`SELECT COUNT(*) AS count FROM follow_ups f WHERE ${author} AND datetime(f.created_at)>=datetime(?) AND datetime(f.created_at)<datetime(?)`, ...authorVals, start, end),
    overdue_count: count(`SELECT COUNT(*) AS count FROM leads l WHERE ${leadsWhere} AND l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<=datetime(?) AND l.status NOT IN ('已成交','已流失','停止跟进')`, ...scope.values, start, dueCutoff),
    next_day_count: count(`SELECT COUNT(*) AS count FROM leads l WHERE ${leadsWhere} AND l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<datetime(?) AND l.status NOT IN ('已成交','已流失','停止跟进')`, ...scope.values, end, `${dayAfter} 00:00:00`),
  };
}
export function dailyHighlights(db: DatabaseSync, recipient: AiRecipient, businessDate: string, asOf = `${businessDate} 18:00:00`): AiLead[] {
  const scope = scopeClause(recipient);
  const tomorrow = new Date(new Date(`${businessDate}T00:00:00+08:00`).getTime() + 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const dayAfter = new Date(new Date(`${businessDate}T00:00:00+08:00`).getTime() + 2 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const end = `${tomorrow} 00:00:00`; const nextEnd = `${dayAfter} 00:00:00`;
  return db.prepare(`SELECT ${selectedLeadFields} FROM leads l
    WHERE ${scope.sql} AND l.status NOT IN ('已成交','已流失','停止跟进')
      AND (
        (l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)<datetime(?))
        OR (l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<datetime(?))
        OR l.intent_level='高'
        OR (l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<datetime(?))
      )
    ORDER BY CASE
      WHEN l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)<datetime(?) THEN 0
      WHEN l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<datetime(?) THEN 1
      WHEN l.intent_level='高' THEN 2
      WHEN l.next_follow_at IS NOT NULL AND datetime(l.next_follow_at)>=datetime(?) AND datetime(l.next_follow_at)<datetime(?) THEN 3
      ELSE 4 END,
      CASE WHEN l.next_follow_at IS NULL THEN 1 ELSE 0 END,
      datetime(l.next_follow_at) ASC,
      CASE WHEN l.last_follow_at IS NULL THEN 0 ELSE 1 END,
      datetime(l.last_follow_at) ASC,l.id ASC LIMIT 10`).all(
    ...scope.values,
    asOf, asOf, end, end, nextEnd,
    asOf, asOf, end, end, nextEnd,
  ) as AiLead[];
}
export function validateDigestContext(db: DatabaseSync, eventType: string, recipientId: number, leadIds: number[]): boolean {
  const recipient = getActiveRecipient(db, recipientId); if (!recipient) return false;
  if (eventType === 'daily_report' && recipient.role === 'admin') return true;
  if (!leadIds.length) return true;
  const marks = leadIds.map(() => '?').join(','); const row = db.prepare(`SELECT COUNT(*) AS count FROM leads WHERE id IN (${marks}) AND is_deleted=0 AND owner_id=?`).get(...leadIds, recipientId) as { count: number };
  return row.count === leadIds.length;
}
