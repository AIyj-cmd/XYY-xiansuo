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

export type SupportedNotificationChannel = 'mock' | 'openclaw';
export function parseSingleNotificationChannel(value: string): SupportedNotificationChannel {
  let channels: unknown;
  try { channels = JSON.parse(value); } catch { throw new Error('RULE_CONFIG_INVALID'); }
  const parsed = z.array(z.enum(['mock', 'openclaw'])).length(1).safeParse(channels);
  if (!parsed.success) throw new Error('RULE_CONFIG_INVALID');
  return parsed.data[0];
}

export function parseOwnerRule(rule: NotificationRule): OwnerRuleConfig {
  if (rule.event_type !== 'owner_changed' || rule.recipient_strategy !== 'new_owner') throw new Error('RULE_CONFIG_INVALID');
  // Empty owner rules are retained for legacy disabled/no-channel rows and
  // safely suppress delivery; new admin writes require exactly one channel.
  const channels = z.array(z.enum(['mock', 'openclaw'])).max(1).safeParse(JSON.parse(rule.channel_order_json));
  const config = ownerRuleSchema.safeParse(JSON.parse(rule.config_json));
  if (!channels.success || !config.success) throw new Error('RULE_CONFIG_INVALID');
  return config.data;
}
export function parseAiRule(rule: NotificationRule | undefined, eventType: 'scheduled_follow_overdue' | 'daily_report'): AiRuleConfig {
  if (!rule || rule.event_type !== eventType || rule.recipient_strategy !== 'reserved') throw new Error('RULE_CONFIG_INVALID');
  try {
    z.array(z.enum(['mock', 'openclaw'])).length(1).parse(JSON.parse(rule.channel_order_json));
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

type OwnerChangedLead = { company_name: string | null; contact_name: string | null; phone: string | null; source: string; demand_note: string | null; next_follow_at: string | null };
const ownerDetailForbidden = /(?:微信\s*(?:号|ID)|wxid[_-]?\S*|(?:\b(?:wechat|weixin|vx)\b|v信)\s*[:：]\s*\S+|微信\s*[:：]\s*\S+|\b(?:jwt|bearer|api[_ -]?key|token)\b)/i;
// Normalize invisible/bidi controls as well as conventional line breaks before
// owner detail fields are committed to the immutable outbox snapshot.
const unsafeOwnerDetailUnicode = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function truncateText(value: string, limit: number): string { return Array.from(value).slice(0, limit).join(''); }
function redactEmbeddedPhones(value: string): string {
  return value.replace(/(?<!\d)(?:\+?86[\s-]*)?(1[3-9]\d)[\s-]*(\d{4})[\s-]*(\d{4})(?!\d)/g, '$1****$3');
}
function cleanOwnerDetail(value: string | null | undefined, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = redactEmbeddedPhones(value.replace(unsafeOwnerDetailUnicode, ' ').replace(/\s+/g, ' ').trim());
  if (!cleaned || ownerDetailForbidden.test(cleaned)) return undefined;
  return truncateText(cleaned, limit);
}
function maskPhone(value: string | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  const mobile = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
  return /^1\d{10}$/.test(mobile) ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : undefined;
}
function safeFollowAt(value: string | null): string | undefined {
  if (!value) return undefined;
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) {
    const parsed = new Date(`${dateOnly[1]}T00:00:00+08:00`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 10) === dateOnly[1]) return `${dateOnly[1]}前`;
    return undefined;
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return undefined;
  const safe = `${match[1]} ${match[2]}`;
  const parsed = new Date(`${safe.replace(' ', 'T')}:00+08:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ').slice(0, 16) !== safe) return undefined;
  return `${safe}前`;
}
export function ownerChangedMessageSnapshot(lead: OwnerChangedLead): { title: '【新线索已分配】'; body: string; detail_path: string } {
  const fields: string[] = [];
  const company = cleanOwnerDetail(lead.company_name, 30); if (company) fields.push(`客户：${company}`);
  const contact = cleanOwnerDetail(lead.contact_name, 20); if (contact) fields.push(`联系人：${contact}`);
  const phone = maskPhone(lead.phone); if (phone) fields.push(`联系方式：${phone}`);
  const source = cleanOwnerDetail(lead.source, 20); if (!source) throw new Error('OWNER_CHANGED_SOURCE_INVALID'); else fields.push(`来源：${source}`);
  const demand = cleanOwnerDetail(lead.demand_note, 80); if (demand) fields.push(`需求：${demand}`);
  fields.push(`跟进要求：${safeFollowAt(lead.next_follow_at) ?? '请尽快联系'}`);
  return { title: '【新线索已分配】', body: [...fields, '请登录线索系统查看完整资料。'].join('\n'), detail_path: '/pages/leads/detail' };
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
  const rawChannels = JSON.parse(rule.channel_order_json) as SupportedNotificationChannel[];
  const channel = rawChannels.length === 1 ? rawChannels[0] : undefined;
  const recipient = database.prepare('SELECT id, is_active FROM users WHERE id = ?').get(event.newOwnerId) as { id: number; is_active: number } | undefined;
  const lead = database.prepare('SELECT company_name,contact_name,phone,source,demand_note,next_follow_at FROM leads WHERE id=? AND is_deleted=0').get(event.leadId) as OwnerChangedLead | undefined;
  if (!lead) throw new Error('线索不存在，拒绝创建负责人通知');
  const messageSnapshot = ownerChangedMessageSnapshot(lead);
  const canonical = `v1|owner_changed|operation_id=${event.operationId}|lead_id=${event.leadId}|new_owner_id=${event.newOwnerId}|recipient_user_id=${event.newOwnerId}`;
  const dedupeKey = hash(canonical);
  const deliveryKey = hash(`v1|channel=${channel ?? 'none'}|event=${dedupeKey}`);
  const now = event.occurredAt;
  let status = 'pending'; let suppression: string | null = null;
  if (!rule.enabled) { status = 'suppressed'; suppression = 'rule_disabled'; }
  else if (!recipient?.is_active) { status = 'suppressed'; suppression = 'recipient_inactive'; }
  else if (!channel || (channel === 'mock' && !config.mockEnabled) || (channel === 'openclaw' && !config.openclawEnabled)) { status = 'suppressed'; suppression = 'no_usable_channel'; }
  const terminalAt = status === 'suppressed' ? now : null;
  const availableAt = status === 'pending' ? ownerRuleAvailableAt(ruleConfig, now) : now;
  try {
    database.prepare(`INSERT INTO notification_logs (
      event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,occurred_at,
      dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,
      suppression_reason,suppressed_at,retain_until,expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'owner_changed', event.source, event.operationId, 'lead', event.leadId, event.leadId, event.actorUserId, event.oldOwnerId, event.newOwnerId, event.newOwnerId, now,
      dedupeKey, deliveryKey, rule.version, JSON.stringify({ enabled: Boolean(rule.enabled), config: ruleConfig }), rule.channel_order_json, status === 'pending' ? channel! : null,
      JSON.stringify(messageSnapshot), status, channel === 'openclaw' ? config.openclawMaxAttempts : ruleConfig.max_attempts, availableAt,
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
/** Shared with the pilot precheck so its point-in-time decision matches Worker claim/recovery behavior. */
export const CLAIMABLE_NOTIFICATION_WHERE = `((status IN ('pending','retry_wait') AND available_at <= ?) OR (status='sending' AND lease_until <= ? AND expires_at > ?)) AND expires_at > ?`;
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
export function claimNotificationTasks(database: DatabaseSync, workerId: string, now: string, limit = 10, channels: readonly SupportedNotificationChannel[] = ['mock']): ClaimedTask[] {
  maintainNotificationQueue(database, now);
  if (!channels.length) return [];
  const channelSql = channels.map(() => '?').join(',');
  database.exec('BEGIN IMMEDIATE;');
  try {
    const candidates = database.prepare(`SELECT id FROM notification_logs WHERE ${CLAIMABLE_NOTIFICATION_WHERE} AND channel IN (${channelSql}) ORDER BY available_at, id LIMIT ?`).all(now, now, now, now, ...channels, limit) as Array<{ id: number }>;
    const claimed: ClaimedTask[] = [];
    for (const row of candidates) {
      const token = randomUUID(); const leaseUntil = isoPlusMinutes(now, 1);
      const result = database.prepare(`UPDATE notification_logs SET status='sending', lease_token=?, lease_owner=?, lease_until=?, lease_recovery_count=lease_recovery_count + CASE WHEN status='sending' THEN 1 ELSE 0 END, updated_at=?, row_version=row_version+1 WHERE id=? AND ((status IN ('pending','retry_wait') AND available_at <= ?) OR (status='sending' AND lease_until <= ?))`).run(token, workerId, leaseUntil, now, row.id, now, now);
      if (result.changes) claimed.push(database.prepare('SELECT * FROM notification_logs WHERE id = ?').get(row.id) as ClaimedTask);
    }
    database.exec('COMMIT;'); return claimed;
  } catch (error) { database.exec('ROLLBACK;'); throw error; }
}

export function finishNotificationTask(database: DatabaseSync, task: ClaimedTask, outcome: { kind: 'sent' | 'temporary' | 'permanent'; code?: string; message?: string; receipt?: string; retryAllowed?: 0 | 1 }, now: string): boolean {
  if (outcome.kind === 'sent') {
    if (!outcome.receipt) throw new Error('发送成功结果缺少 receipt');
    return database.prepare(`UPDATE notification_logs SET status='sent', provider_message_id=?, sent_at=?, retain_until=?, attempt_count=attempt_count+1, automatic_attempt_count=automatic_attempt_count+1, last_attempt_at=?, lease_token=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?, row_version=row_version+1 WHERE id=? AND status='sending' AND lease_token=?`).run(outcome.receipt, now, isoPlusMinutes(now, 180 * 24 * 60), now, now, task.id, task.lease_token).changes === 1;
  }
  const attempts = Number(task.automatic_attempt_count) + 1;
  const terminal = outcome.kind === 'permanent' || attempts >= Number(task.max_attempts);
  const delaySeconds = [30, 120, 600, 1800][Math.min(attempts - 1, 3)];
  // Preserve legacy Mock manual-retry semantics unless a channel explicitly
  // declares its terminal result unsafe to retry.
  const retryAllowed = outcome.retryAllowed ?? (outcome.code === 'invalid_message_schema' || outcome.code === 'unrecoverable_task_data' ? 0 : 1);
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
