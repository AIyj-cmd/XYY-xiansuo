import type { DatabaseSync } from 'node:sqlite';
import type { AiConfig } from '../../config.js';
import { buildLeadContext } from '../../ai/context-builder.js';
import { cancelAiLog, claimAiLog, createOrGetAiLog, failAiLog, reserveProviderAttempt, saveAiReady, skipAiLog } from '../../ai/audit-store.js';
import { generateScheduled } from '../../ai/service.js';
import type { AiProvider } from '../../ai/providers/provider.js';
import { overdueLeads, getActiveRecipient, validateDigestContext, type AiRecipient } from '../../ai/permission-query.js';
import { scheduledFallback } from '../../ai/fallback.js';
import { resolveNotificationConfig } from '../../config.js';
import { scheduledSnapshotSchema } from '../../notifications/snapshot.js';
import { finalizeAiNotification } from '../finalize-notification.js';
export async function runScheduledFollow(db: DatabaseSync, config: AiConfig, provider: AiProvider | undefined, recipientInput: AiRecipient, businessDate: string, now: string): Promise<void> {
  const recipient = getActiveRecipient(db, recipientInput.id); if (!recipient) return;
  const scope = 'self' as const; const log = createOrGetAiLog(db, { job: 'scheduled_follow_overdue', recipientUserId: recipient.id, role: recipient.role, scope, businessDate, now, retentionDays: config.auditRetentionDays });
  if (log.status === 'completed' || log.status === 'skipped' || log.status === 'cancelled') return;
  if (log.status === 'ready' && log.result_snapshot_json) {
    const snapshot = scheduledSnapshotSchema.parse(JSON.parse(log.result_snapshot_json));
    finalizeAiNotification(db, log, { eventType: 'scheduled_follow_overdue', operationId: `ai:${log.idempotency_key}`, recipientUserId: recipient.id, businessDate, scope, subjectLeadIds: snapshot.subject_lead_ids, messageSnapshot: snapshot, occurredAt: now }, now);
    return;
  }
  const candidates = overdueLeads(db, recipient, businessDate); if (!candidates.total) { skipAiLog(db, log.id, 'AI_CONTEXT_EMPTY', now); return; }
  if (!resolveNotificationConfig().captureEnabled) { skipAiLog(db, log.id, 'NOTIFICATION_CAPTURE_DISABLED', now); return; }
  const built = buildLeadContext(db, candidates.leads, businessDate, config.maxContextChars, config.maxFollowUpRecords); if (!built.items.length) { skipAiLog(db, log.id, 'AI_CONTEXT_EMPTY', now); return; }
  const fresh = getActiveRecipient(db, recipient.id);
  if (!fresh || fresh.role !== recipient.role || !validateDigestContext(db, 'scheduled_follow_overdue', recipient.id, built.items.map((item) => item.lead_id))) {
    cancelAiLog(db, log.id, now); return;
  }
  db.exec('BEGIN IMMEDIATE;'); try { db.prepare(`UPDATE ai_request_logs SET context_hash=?,candidate_count=?,input_chars=?,updated_at=? WHERE id=?`).run(built.hash, candidates.total, built.chars, now, log.id); db.exec('COMMIT;'); } catch (error) { db.exec('ROLLBACK;'); throw error; }
  const claimed = claimAiLog(db, log.id, 'ai-scheduler', now); if (!claimed) return;
  const ruleEnabled = Boolean((db.prepare("SELECT enabled FROM notification_rules WHERE event_type='scheduled_follow_overdue'").get() as { enabled: number } | undefined)?.enabled);
  let generated: any; try { generated = ruleEnabled ? await generateScheduled(config, provider, claimed.request_id, { business_date: businessDate, total_candidate_count: candidates.total, context: built.context }, built.items, () => reserveProviderAttempt(db, claimed.id, recipient.id, businessDate, config.dailyGlobalLimit, config.dailyUserLimit, now)) : { value: scheduledFallback(built.items), fallback: true, attempts: 0, errorCode: 'AI_FALLBACK_USED' }; } catch (error: any) { if (error?.code === 'DEEPSEEK_DISABLED') skipAiLog(db, claimed.id, 'DEEPSEEK_DISABLED', now); else failAiLog(db, claimed.id, error?.code || 'AI_INTERNAL_ERROR', now); return; }
  const snapshot = { schema_version: 1 as const, ...generated.value, subject_lead_ids: built.items.map((item) => item.lead_id), business_date: businessDate, fallback_used: generated.fallback, detail_path: '/pages/notify/index' as const };
  if (!saveAiReady(db, claimed, snapshot, { provider: generated.provider, model: generated.model, inputChars: built.chars, outputChars: JSON.stringify(snapshot).length, fallbackUsed: generated.fallback, attempts: generated.attempts, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, errorCode: generated.errorCode }, now, config.resultRetentionDays)) return;
  finalizeAiNotification(db, log, { eventType: 'scheduled_follow_overdue', operationId: `ai:${log.idempotency_key}`, recipientUserId: recipient.id, businessDate, scope, subjectLeadIds: snapshot.subject_lead_ids, messageSnapshot: snapshot, occurredAt: now }, now);
}
