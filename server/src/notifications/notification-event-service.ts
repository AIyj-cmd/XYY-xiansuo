import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveNotificationConfig } from '../config.js';
import { parseAiRule, parseSingleNotificationChannel } from '../services/notification.js';
import { nowDatetime } from '../utils/datetime.js';
import { dailySnapshotSchema, scheduledSnapshotSchema } from './snapshot.js';
import { validateDigestContext } from '../ai/permission-query.js';

export type AiNotificationEvent = { eventType: 'scheduled_follow_overdue' | 'daily_report'; operationId: string; recipientUserId: number; businessDate: string; scope: 'self' | 'team'; subjectLeadIds: number[]; messageSnapshot: unknown; occurredAt?: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const plusMinutes = (now: string, minutes: number) => new Date(new Date(`${now.replace(' ', 'T')}+08:00`).getTime() + minutes * 60_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
/** Scheduler-only internal boundary. Provider never imports this module. */
export function createScheduledNotification(db: DatabaseSync, event: AiNotificationEvent): { id?: number; status: 'pending' | 'suppressed'; reason?: string } {
  const now = event.occurredAt || nowDatetime(); const snapshot = event.eventType === 'scheduled_follow_overdue' ? scheduledSnapshotSchema.parse(event.messageSnapshot) : dailySnapshotSchema.parse(event.messageSnapshot);
  const snapshotIds = snapshot.subject_lead_ids;
  if (snapshotIds.length !== event.subjectLeadIds.length || snapshotIds.some((id, index) => id !== event.subjectLeadIds[index])) {
    throw Object.assign(new Error('AI_CONTEXT_STALE'), { code: 'AI_CONTEXT_STALE' });
  }
  const recipient = db.prepare("SELECT id,role,is_active FROM users WHERE id=?").get(event.recipientUserId) as { id: number; role: string; is_active: number } | undefined;
  const invalidScope = event.eventType === 'scheduled_follow_overdue'
    ? event.scope !== 'self'
    : (recipient?.role === 'admin' ? event.scope !== 'team' : event.scope !== 'self');
  if (!recipient?.is_active || invalidScope || (event.scope === 'team' && recipient.role !== 'admin')
      || !validateDigestContext(db, event.eventType, event.recipientUserId, snapshotIds)) {
    throw Object.assign(new Error('AI_CONTEXT_STALE'), { code: 'AI_CONTEXT_STALE' });
  }
  const rule = db.prepare('SELECT event_type,enabled,recipient_strategy,channel_order_json,config_schema_version,config_json,version FROM notification_rules WHERE event_type=?').get(event.eventType) as any;
  const config = parseAiRule(rule, event.eventType); const capture = resolveNotificationConfig().captureEnabled;
  if (!capture) return { status: 'suppressed', reason: 'NOTIFICATION_CAPTURE_DISABLED' };
  let status: 'pending' | 'suppressed' = 'pending'; let reason: string | undefined;
  const notificationConfig = resolveNotificationConfig(); const channel = parseSingleNotificationChannel(rule.channel_order_json);
  if (!rule.enabled) { status = 'suppressed'; reason = 'rule_disabled'; }
  else if ((channel === 'mock' && !notificationConfig.mockEnabled) || (channel === 'openclaw' && !notificationConfig.openclawEnabled)) { status = 'suppressed'; reason = 'no_usable_channel'; }
  const dedupe = sha(`v1|${event.eventType}|operation_id=${event.operationId}|recipient_user_id=${event.recipientUserId}|business_date=${event.businessDate}`);
  const delivery = sha(`v1|channel=${channel}|event=${dedupe}`);
  try {
    const result = db.prepare(`INSERT INTO notification_logs (event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,suppression_reason,suppressed_at,retain_until,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.eventType, 'ai_scheduler', event.operationId, 'recipient_digest', event.recipientUserId, null, null, null, null, event.recipientUserId, now, dedupe, delivery, rule.version, JSON.stringify({ enabled: Boolean(rule.enabled), config }), rule.channel_order_json, status === 'pending' ? channel : null, JSON.stringify(snapshot), status, channel === 'openclaw' ? notificationConfig.openclawMaxAttempts : config.max_attempts, now, reason || null, status === 'suppressed' ? now : null, status === 'suppressed' ? plusMinutes(now, 180 * 24 * 60) : null, plusMinutes(now, config.ttl_minutes),
    );
    return { id: Number(result.lastInsertRowid), status, reason };
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      const row = db.prepare(`SELECT id,status,suppression_reason,event_type,event_source,operation_id,subject_type,subject_id,
        recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,message_snapshot_json
        FROM notification_logs WHERE dedupe_key=?`).get(dedupe) as any;
      if (row && row.event_type === event.eventType && row.event_source === 'ai_scheduler'
          && row.operation_id === event.operationId && row.subject_type === 'recipient_digest'
          && row.subject_id === event.recipientUserId && row.recipient_user_id === event.recipientUserId
          && row.dedupe_key === dedupe && row.delivery_idempotency_key === delivery
          && row.message_snapshot_json === JSON.stringify(snapshot)) {
        return { id: row.id, status: row.status, reason: row.suppression_reason ?? undefined };
      }
      throw new Error('NOTIFICATION_DEDUPE_CONFLICT');
    }
    throw error;
  }
}
