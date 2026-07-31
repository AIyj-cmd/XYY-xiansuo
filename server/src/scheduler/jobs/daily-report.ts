import type { DatabaseSync } from 'node:sqlite';
import type { AiConfig } from '../../config.js';
import type { AiProvider } from '../../ai/providers/provider.js';
import { buildLeadContext } from '../../ai/context-builder.js';
import { addProviderLatency, cancelAiLog, claimAiLog, createOrGetAiLog, failAiLog, reserveProviderAttempt, saveAiReady, skipAiLog } from '../../ai/audit-store.js';
import { generateDaily } from '../../ai/service.js';
import { dailyHighlights, dailyMetrics, getActiveRecipient, validateDigestContext, type AiRecipient } from '../../ai/permission-query.js';
import { dailyFallback } from '../../ai/fallback.js';
import { resolveNotificationConfig } from '../../config.js';
import { dailySnapshotSchema } from '../../notifications/snapshot.js';
import { finalizeAiNotification } from '../finalize-notification.js';
import { promptVersion } from '../../ai/prompt.js';
export async function runDailyReport(db: DatabaseSync, config: AiConfig, provider: AiProvider | undefined, recipientInput: AiRecipient, businessDate: string, now: string): Promise<void> {
  const recipient = getActiveRecipient(db, recipientInput.id); if (!recipient) return; const scope = recipient.role === 'admin' ? 'team' : 'self';
  const log = createOrGetAiLog(db, { job: 'daily_report', recipientUserId: recipient.id, role: recipient.role, scope, businessDate, now, retentionDays: config.auditRetentionDays, promptVersion: promptVersion('daily_report') }); if (log.status === 'completed' || log.status === 'skipped' || log.status === 'cancelled') return;
  if (log.status === 'ready' && log.result_snapshot_json) {
    const snapshot = dailySnapshotSchema.parse(JSON.parse(log.result_snapshot_json));
    finalizeAiNotification(db, log, { eventType: 'daily_report', operationId: `ai:${log.idempotency_key}`, recipientUserId: recipient.id, businessDate, scope, subjectLeadIds: snapshot.subject_lead_ids, messageSnapshot: snapshot, occurredAt: now }, now);
    return;
  }
  const metrics = dailyMetrics(db, recipient, businessDate, now); const leads = dailyHighlights(db, recipient, businessDate, now); const built = buildLeadContext(db, leads, businessDate, config.maxContextChars, config.maxFollowUpRecords);
  if (!Object.values(metrics).some(Boolean) && !built.items.length) { skipAiLog(db, log.id, 'AI_CONTEXT_EMPTY', now); return; }
  if (!resolveNotificationConfig().captureEnabled) { skipAiLog(db, log.id, 'NOTIFICATION_CAPTURE_DISABLED', now); return; }
  const fresh = getActiveRecipient(db, recipient.id);
  if (!fresh || fresh.role !== recipient.role || !validateDigestContext(db, 'daily_report', recipient.id, built.items.map((item) => item.lead_id))) {
    cancelAiLog(db, log.id, now); return;
  }
  db.prepare(`UPDATE ai_request_logs SET context_hash=?,candidate_count=?,input_chars=?,updated_at=? WHERE id=?`).run(built.hash, leads.length, built.chars, now, log.id);
  const claimed = claimAiLog(db, log.id, 'ai-scheduler', now); if (!claimed) return;
  const ruleEnabled = Boolean((db.prepare("SELECT enabled FROM notification_rules WHERE event_type='daily_report'").get() as { enabled: number } | undefined)?.enabled);
  let generated: any; try { generated = ruleEnabled ? await generateDaily(config, provider, claimed.request_id, { business_date: businessDate, metrics, context: built.context }, metrics, () => reserveProviderAttempt(db, claimed.id, recipient.id, businessDate, config.dailyGlobalLimit, config.dailyUserLimit, now), (latencyMs) => { addProviderLatency(db, claimed.id, latencyMs, now); }) : { value: dailyFallback(metrics), fallback: true, attempts: 0, errorCode: 'AI_FALLBACK_USED' }; } catch (error: any) { if (error?.code === 'DEEPSEEK_DISABLED') skipAiLog(db, claimed.id, 'DEEPSEEK_DISABLED', now); else failAiLog(db, claimed.id, error?.code || 'AI_INTERNAL_ERROR', now); return; }
  const snapshot = { schema_version: 1 as const, ...generated.value, metrics, subject_lead_ids: built.items.map((item) => item.lead_id), business_date: businessDate, scope, fallback_used: generated.fallback, detail_path: '/pages/notify/index' as const };
  if (!saveAiReady(db, claimed, snapshot, { provider: generated.provider, model: generated.model, inputChars: built.chars, outputChars: JSON.stringify(snapshot).length, fallbackUsed: generated.fallback, attempts: generated.attempts, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, errorCode: generated.errorCode }, now, config.resultRetentionDays)) return;
  finalizeAiNotification(db, log, { eventType: 'daily_report', operationId: `ai:${log.idempotency_key}`, recipientUserId: recipient.id, businessDate, scope, subjectLeadIds: snapshot.subject_lead_ids, messageSnapshot: snapshot, occurredAt: now }, now);
}
