import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { resolveNotificationConfig } from '../config.js';

export const NOTIFICATION_EVENT_TYPES = [
  'owner_changed', 'scheduled_follow_overdue', 'visit_reminder', 'status_changed', 'daily_report', 'weekly_report', 'inactive_lead',
] as const;
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];
export type OwnerChangedEvent = {
  schemaVersion: 1; eventType: 'owner_changed'; operationId: string; source: 'single_edit' | 'batch_transfer';
  occurredAt: string; leadId: number; actorUserId: number; oldOwnerId: number | null; newOwnerId: number;
};

const prohibitedKey = /(?:url|token|secret|password|webhook|key)/i;
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ownerRuleSchema = z.object({
  schema_version: z.literal(1),
  quiet_hours: z.object({ enabled: z.boolean(), start: timeSchema, end: timeSchema, timezone: z.literal('Asia/Shanghai') }).strict(),
  max_attempts: z.number().int().min(1).max(5),
  ttl_minutes: z.number().int().min(1).max(1440),
}).strict().superRefine((value, context) => {
  for (const key of Object.keys(value)) if (prohibitedKey.test(key)) context.addIssue({ code: 'custom', message: '规则配置不能包含敏感渠道字段' });
});
export type OwnerRuleConfig = z.infer<typeof ownerRuleSchema>;
const aiRuleSchema = z.object({
  schema_version: z.literal(1), recipient_mode: z.literal('job_recipient'),
  quiet_hours: z.object({ enabled: z.boolean(), start: timeSchema, end: timeSchema, timezone: z.literal('Asia/Shanghai') }).strict(),
  max_attempts: z.number().int().min(1).max(5), ttl_minutes: z.number().int().min(1).max(1440),
}).strict();
export type AiRuleConfig = z.infer<typeof aiRuleSchema>;

export type NotificationRule = {
  event_type: string; enabled: number; recipient_strategy: string; channel_order_json: string;
  config_schema_version: number; config_json: string; version: number;
};

export function parseOwnerRule(rule: NotificationRule): OwnerRuleConfig {
  if (rule.event_type !== 'owner_changed' || rule.recipient_strategy !== 'new_owner') throw new Error('RULE_CONFIG_INVALID');
  const channels = z.array(z.literal('mock')).max(1).safeParse(JSON.parse(rule.channel_order_json));
  const config = ownerRuleSchema.safeParse(JSON.parse(rule.config_json));
  if (!channels.success || !config.success) throw new Error('RULE_CONFIG_INVALID');
  return config.data;
}
export function parseAiRule(rule: NotificationRule | undefined, eventType: 'scheduled_follow_overdue' | 'daily_report'): AiRuleConfig {
  if (!rule || rule.event_type !== eventType || rule.recipient_strategy !== 'reserved') throw new Error('RULE_CONFIG_INVALID');
  try {
    const channels = z.array(z.literal('mock')).min(1).max(1).parse(JSON.parse(rule.channel_order_json));
    if (!channels.includes('mock')) throw new Error('invalid channel');
    return aiRuleSchema.parse(JSON.parse(rule.config_json));
  } catch { throw new Error('RULE_CONFIG_INVALID'); }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizeShanghaiDatetime(value: string): string {
  const localMatch = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  const date = localMatch
    ? new Date(`${localMatch[1]}T${localMatch[2]}:${localMatch[3] ?? '00'}+08:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('DATETIME_INVALID');
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ');
}

export function ownerRuleAvailableAt(config: OwnerRuleConfig, asOf: string): string {
  const normalized = normalizeShanghaiDatetime(asOf);
  if (!config.quiet_hours.enabled || config.quiet_hours.start === config.quiet_hours.end) return normalized;
  const [datePart, timePart] = normalized.split(' ');
  const current = timePart.slice(0, 5);
  const { start, end } = config.quiet_hours;
  const crossesMidnight = start > end;
  const inQuietHours = crossesMidnight
    ? current >= start || current < end
    : current >= start && current < end;
  if (!inQuietHours) return normalized;
  const endDate = new Date(`${datePart}T${end}:00+08:00`);
  if (crossesMidnight && current >= start) endDate.setTime(endDate.getTime() + 24 * 60 * 60 * 1000);
  return endDate.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ');
}

function isoPlusMinutes(now: string, minutes: number): string {
  const date = new Date(`${now.replace(' ', 'T')}+08:00`);
  return new Date(date.getTime() + minutes * 60_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}

/** 已处于负责人事务内调用；任何写入失败必须冒泡，由调用方回滚。 */
export function captureOwnerChanged(database: DatabaseSync, event: OwnerChangedEvent): void {
  const config = resolveNotificationConfig();
  if (!config.captureEnabled) {
    console.warn(JSON.stringify({ event: 'notification.capture.disabled', event_type: event.eventType, operation_id: event.operationId, replay: 'disabled_events_will_not_be_replayed' }));
    return;
  }
  if (event.oldOwnerId === event.newOwnerId || event.newOwnerId === event.actorUserId) return;
  database.prepare(`UPDATE notification_logs SET status='cancelled', cancellation_reason='owner_changed', cancelled_at=?, retain_until=?, updated_at=?, row_version=row_version+1
    WHERE lead_id=? AND event_type='owner_changed' AND status IN ('pending','retry_wait')`).run(
    event.occurredAt, isoPlusMinutes(event.occurredAt, 180 * 24 * 60), event.occurredAt, event.leadId,
  );
  const rule = database.prepare('SELECT event_type, enabled, recipient_strategy, channel_order_json, config_schema_version, config_json, version FROM notification_rules WHERE event_type = ?').get('owner_changed') as NotificationRule | undefined;
  if (!rule) throw new Error('通知规则缺失，拒绝提交负责人变更');
  const ruleConfig = parseOwnerRule(rule);
  const channelOrder = JSON.parse(rule.channel_order_json) as unknown[];
  const recipient = database.prepare('SELECT id, is_active FROM users WHERE id = ?').get(event.newOwnerId) as { id: number; is_active: number } | undefined;
  const canonical = `v1|owner_changed|operation_id=${event.operationId}|lead_id=${event.leadId}|new_owner_id=${event.newOwnerId}|recipient_user_id=${event.newOwnerId}`;
  const dedupeKey = hash(canonical);
  const deliveryKey = hash(`v1|channel=mock|event=${dedupeKey}`);
  const now = event.occurredAt;
  let status = 'pending'; let suppression: string | null = null;
  if (!rule.enabled) { status = 'suppressed'; suppression = 'rule_disabled'; }
  else if (!recipient?.is_active) { status = 'suppressed'; suppression = 'recipient_inactive'; }
  else if (!channelOrder.includes('mock') || !resolveNotificationConfig().mockEnabled) { status = 'suppressed'; suppression = 'no_usable_channel'; }
  const terminalAt = status === 'suppressed' ? now : null;
  const availableAt = status === 'pending' ? ownerRuleAvailableAt(ruleConfig, now) : now;
  try {
    database.prepare(`INSERT INTO notification_logs (
      event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,occurred_at,
      dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,
      suppression_reason,suppressed_at,retain_until,expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'owner_changed', event.source, event.operationId, 'lead', event.leadId, event.leadId, event.actorUserId, event.oldOwnerId, event.newOwnerId, event.newOwnerId, now,
      dedupeKey, deliveryKey, rule.version, JSON.stringify({ enabled: Boolean(rule.enabled), config: ruleConfig }), rule.channel_order_json, status === 'pending' ? 'mock' : null,
      JSON.stringify({ title: '负责人已变更', detail_path: `/pages/leads/detail?id=${event.leadId}` }), status, ruleConfig.max_attempts, availableAt,
      suppression, terminalAt, terminalAt ? isoPlusMinutes(terminalAt, 180 * 24 * 60) : null, isoPlusMinutes(now, ruleConfig.ttl_minutes),
    );
    console.log(JSON.stringify({ event: status === 'suppressed' ? 'notification.task.suppressed' : 'notification.task.created', dedupe_key: dedupeKey }));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      const existing = database.prepare(`SELECT event_type,event_source,operation_id,occurred_at,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id
        FROM notification_logs WHERE dedupe_key = ?`).get(dedupeKey) as Record<string, unknown> | undefined;
      if (existing
        && existing.event_type === event.eventType
        && existing.event_source === event.source
        && existing.operation_id === event.operationId
        && existing.occurred_at === event.occurredAt
        && existing.lead_id === event.leadId
        && existing.actor_user_id === event.actorUserId
        && existing.old_owner_id === event.oldOwnerId
        && existing.new_owner_id === event.newOwnerId
        && existing.recipient_user_id === event.newOwnerId) return;
      console.error(JSON.stringify({ event: 'notification.task.dedupe_conflict', dedupe_key: dedupeKey }));
      throw new Error('NOTIFICATION_DEDUPE_CONFLICT');
    }
    throw error;
  }
}

export type ClaimedTask = Record<string, any>;
export function maintainNotificationQueue(database: DatabaseSync, now: string, limit = 100): number {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = database.prepare(`UPDATE notification_logs SET status='cancelled', cancellation_reason='task_expired', cancelled_at=?, retain_until=?, lease_token=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?, row_version=row_version+1
      WHERE id IN (SELECT id FROM notification_logs WHERE status IN ('pending','retry_wait','sending') AND expires_at <= ? ORDER BY expires_at,id LIMIT ?)`).run(
      now, isoPlusMinutes(now, 180 * 24 * 60), now, now, limit,
    );
    database.exec('COMMIT;');
    return Number(result.changes);
  } catch (error) { database.exec('ROLLBACK;'); throw error; }
}
export function claimNotificationTasks(database: DatabaseSync, workerId: string, now: string, limit = 10): ClaimedTask[] {
  maintainNotificationQueue(database, now);
  database.exec('BEGIN IMMEDIATE;');
  try {
    const candidates = database.prepare(`SELECT id FROM notification_logs WHERE
      ((status IN ('pending','retry_wait') AND available_at <= ?) OR (status='sending' AND lease_until <= ? AND expires_at > ?))
      AND expires_at > ? ORDER BY available_at, id LIMIT ?`).all(now, now, now, now, limit) as Array<{ id: number }>;
    const claimed: ClaimedTask[] = [];
    for (const row of candidates) {
      const token = randomUUID(); const leaseUntil = isoPlusMinutes(now, 1);
      const result = database.prepare(`UPDATE notification_logs SET status='sending', lease_token=?, lease_owner=?, lease_until=?, lease_recovery_count=lease_recovery_count + CASE WHEN status='sending' THEN 1 ELSE 0 END, updated_at=?, row_version=row_version+1 WHERE id=? AND ((status IN ('pending','retry_wait') AND available_at <= ?) OR (status='sending' AND lease_until <= ?))`).run(token, workerId, leaseUntil, now, row.id, now, now);
      if (result.changes) claimed.push(database.prepare('SELECT * FROM notification_logs WHERE id = ?').get(row.id) as ClaimedTask);
    }
    database.exec('COMMIT;'); return claimed;
  } catch (error) { database.exec('ROLLBACK;'); throw error; }
}

export function finishNotificationTask(database: DatabaseSync, task: ClaimedTask, outcome: { kind: 'sent' | 'temporary' | 'permanent'; code?: string; message?: string; receipt?: string }, now: string): boolean {
  if (outcome.kind === 'sent') {
    if (!outcome.receipt) throw new Error('发送成功结果缺少 receipt');
    return database.prepare(`UPDATE notification_logs SET status='sent', provider_message_id=?, sent_at=?, retain_until=?, attempt_count=attempt_count+1, automatic_attempt_count=automatic_attempt_count+1, last_attempt_at=?, lease_token=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?, row_version=row_version+1 WHERE id=? AND status='sending' AND lease_token=?`).run(outcome.receipt, now, isoPlusMinutes(now, 180 * 24 * 60), now, now, task.id, task.lease_token).changes === 1;
  }
  const attempts = Number(task.automatic_attempt_count) + 1;
  const terminal = outcome.kind === 'permanent' || attempts >= Number(task.max_attempts);
  const delaySeconds = [30, 120, 600, 1800][Math.min(attempts - 1, 3)];
  const retryAllowed = outcome.code === 'invalid_message_schema' || outcome.code === 'unrecoverable_task_data' ? 0 : 1;
  return database.prepare(`UPDATE notification_logs SET status=?, automatic_attempt_count=?, attempt_count=attempt_count+1, last_attempt_at=?, failed_at=CASE WHEN ? THEN ? ELSE NULL END, retain_until=CASE WHEN ? THEN ? ELSE NULL END, available_at=CASE WHEN ? THEN available_at ELSE ? END, failure_class=?, last_error_code=?, last_error_message=?, retry_allowed=?, lease_token=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?, row_version=row_version+1 WHERE id=? AND status='sending' AND lease_token=?`).run(terminal ? 'failed' : 'retry_wait', attempts, now, terminal ? 1 : 0, now, terminal ? 1 : 0, isoPlusMinutes(now, 180 * 24 * 60), terminal ? 1 : 0, isoPlusMinutes(now, Math.ceil(delaySeconds / 60)), outcome.kind, outcome.code ?? null, outcome.message?.slice(0, 200) ?? null, retryAllowed, now, task.id, task.lease_token).changes === 1;
}

export function validateClaimedNotificationTask(database: DatabaseSync, task: ClaimedTask, now: string): 'valid' | 'cancelled' | 'lease_lost' {
  if (task.event_type === 'scheduled_follow_overdue' || task.event_type === 'daily_report') {
    let snapshot: { subject_lead_ids?: unknown; scope?: unknown };
    try { snapshot = JSON.parse(task.message_snapshot_json); } catch { snapshot = {}; }
    const ids = Array.isArray(snapshot.subject_lead_ids) && snapshot.subject_lead_ids.every((id) => Number.isInteger(id) && id > 0) ? snapshot.subject_lead_ids as number[] : null;
    const recipient = database.prepare('SELECT role,is_active FROM users WHERE id=?').get(task.recipient_user_id) as { role: string; is_active: number } | undefined;
    let reason: string | null = !recipient?.is_active ? 'context_stale' : null;
    if (!reason && task.event_type === 'daily_report' && snapshot.scope === 'team' && recipient?.role !== 'admin') reason = 'context_stale';
    if (!reason && task.event_type === 'scheduled_follow_overdue' && (!ids || !ids.length)) reason = 'context_stale';
    if (!reason && ids?.length) {
      const marks = ids.map(() => '?').join(','); const count = (database.prepare(`SELECT COUNT(*) AS count FROM leads WHERE id IN (${marks}) AND is_deleted=0 AND owner_id=?`).get(...ids, task.recipient_user_id) as { count: number }).count;
      if (count !== ids.length && !(task.event_type === 'daily_report' && snapshot.scope === 'team' && recipient?.role === 'admin')) reason = 'context_stale';
    }
    if (!reason) return 'valid';
    const cancelled = database.prepare(`UPDATE notification_logs SET status='cancelled', cancellation_reason='context_stale', cancelled_at=?, retain_until=?, lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,row_version=row_version+1 WHERE id=? AND status='sending' AND lease_token=?`).run(now, isoPlusMinutes(now, 180 * 24 * 60), now, task.id, task.lease_token);
    return cancelled.changes === 1 ? 'cancelled' : 'lease_lost';
  }
  const state = database.prepare(`SELECT l.owner_id,l.is_deleted,u.is_active
    FROM leads l LEFT JOIN users u ON u.id=? WHERE l.id=?`).get(task.recipient_user_id, task.lead_id) as {
      owner_id: number | null; is_deleted: number; is_active: number | null;
    } | undefined;
  let reason: string | null = null;
  if (!state || state.is_deleted || state.owner_id !== task.recipient_user_id) reason = 'owner_changed';
  else if (!state.is_active) reason = 'recipient_inactive';
  if (!reason) return 'valid';
  const result = database.prepare(`UPDATE notification_logs SET status='cancelled', cancellation_reason=?, cancelled_at=?, retain_until=?,
    lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,row_version=row_version+1
    WHERE id=? AND status='sending' AND lease_token=?`).run(
    reason, now, isoPlusMinutes(now, 180 * 24 * 60), now, task.id, task.lease_token,
  );
  return result.changes === 1 ? 'cancelled' : 'lease_lost';
}

export function cleanupNotificationRetention(database: DatabaseSync, now: string, limit = 100): number {
  database.exec('BEGIN IMMEDIATE;');
  try { const result = database.prepare(`DELETE FROM notification_logs WHERE id IN (SELECT id FROM notification_logs WHERE status IN ('sent','suppressed','cancelled','failed') AND retain_until <= ? ORDER BY retain_until LIMIT ?)` ).run(now, limit); database.exec('COMMIT;'); return Number(result.changes); } catch (error) { database.exec('ROLLBACK;'); throw error; }
}
