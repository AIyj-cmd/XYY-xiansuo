import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiFeature } from './providers/provider.js';

export type AiLog = Record<string, any>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function aiIdempotencyKey(job: AiFeature, userId: number, businessDate: string, scope: 'self' | 'team'): string { return hash(`v1|job_type=${job}|recipient_user_id=${userId}|business_date=${businessDate}|scope=${scope}`); }
const dateAfter = (now: string, days: number) => new Date(new Date(`${now.replace(' ', 'T')}+08:00`).getTime() + days * 86_400_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
export function createOrGetAiLog(db: DatabaseSync, input: { job: AiFeature; recipientUserId: number; role: 'admin' | 'member'; scope: 'self' | 'team'; businessDate: string; now: string; retentionDays: number }): AiLog {
  const key = aiIdempotencyKey(input.job, input.recipientUserId, input.businessDate, input.scope);
  db.prepare(`INSERT OR IGNORE INTO ai_request_logs(request_id,idempotency_key,job_type,recipient_user_id,recipient_role_snapshot,scope,business_date,prompt_version,status,available_at,retain_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), key, input.job, input.recipientUserId, input.role, input.scope, input.businessDate, 'phase4-v1', 'pending', input.now, dateAfter(input.now, input.retentionDays));
  return db.prepare('SELECT * FROM ai_request_logs WHERE idempotency_key=?').get(key) as AiLog;
}
export function claimAiLog(db: DatabaseSync, logId: number, owner: string, now: string): AiLog | undefined {
  const leaseUntil = new Date(new Date(`${now.replace(' ', 'T')}+08:00`).getTime() + 60_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
  const token = randomUUID(); db.exec('BEGIN IMMEDIATE;');
  try {
    const updated = db.prepare(`UPDATE ai_request_logs SET status='generating',lease_token=?,lease_owner=?,lease_until=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND (status='pending' OR (status='generating' AND lease_until<=?) OR status='ready')`).run(token, owner, leaseUntil, now, now, logId, now);
    const row = updated.changes ? db.prepare('SELECT * FROM ai_request_logs WHERE id=?').get(logId) as AiLog : undefined; db.exec('COMMIT;'); return row;
  } catch (error) { db.exec('ROLLBACK;'); throw error; }
}
export function saveAiReady(db: DatabaseSync, log: AiLog, result: unknown, metadata: { provider?: string; model?: string; inputChars: number; outputChars: number; fallbackUsed: boolean; attempts: number; inputTokens?: number; outputTokens?: number; errorCode?: string }, now: string, resultDays: number): boolean {
  // attempt_count is reserved before every outbound request. A recovered lease
  // can therefore start with a non-zero value; never overwrite that accounting
  // with attempts made only in the current runner invocation.
  const json = JSON.stringify(result); return db.prepare(`UPDATE ai_request_logs SET status='ready',provider=?,model=?,context_hash=COALESCE(context_hash,?),input_chars=?,output_chars=?,input_tokens=?,output_tokens=?,attempt_count=MAX(attempt_count,?),fallback_used=?,result_snapshot_json=?,result_hash=?,result_retain_until=?,error_code=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND status='generating' AND lease_token=?`).run(metadata.provider || null, metadata.model || null, log.context_hash || null, metadata.inputChars, metadata.outputChars, metadata.inputTokens ?? null, metadata.outputTokens ?? null, metadata.attempts, metadata.fallbackUsed ? 1 : 0, json, hash(json), dateAfter(now, resultDays), metadata.errorCode ?? null, now, now, log.id, log.lease_token).changes === 1;
}
export function finishAiLog(db: DatabaseSync, logId: number, operationId: string, notificationId: number | undefined, now: string, status: 'completed' | 'skipped' | 'cancelled' = 'completed', errorCode?: string): void {
  if (status === 'completed' && !notificationId) throw new Error('completed requires notification log');
  db.prepare(`UPDATE ai_request_logs SET status=?,notification_operation_id=CASE WHEN ?='completed' THEN ? ELSE notification_operation_id END,notification_log_id=CASE WHEN ?='completed' THEN ? ELSE notification_log_id END,result_snapshot_json=CASE WHEN ?='completed' THEN NULL ELSE result_snapshot_json END,result_hash=CASE WHEN ?='completed' THEN NULL ELSE result_hash END,error_code=?,completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(status, status, operationId, status, notificationId ?? null, status, status, errorCode ?? null, now, now, logId);
}
export function skipAiLog(db: DatabaseSync, logId: number, code: string, now: string): void { db.prepare(`UPDATE ai_request_logs SET status='skipped',error_code=?,completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')`).run(code, now, now, logId); }
export function failAiLog(db: DatabaseSync, logId: number, code: string, now: string): void { db.prepare(`UPDATE ai_request_logs SET status='failed',error_code=?,error_summary=?,completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='generating'`).run(code, code.slice(0, 200), now, now, logId); }
export function cancelAiLog(db: DatabaseSync, logId: number, now: string): void { db.prepare(`UPDATE ai_request_logs SET status='cancelled',error_code='context_stale',completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(now, now, logId); }
/** Reserve each outbound request inside one short SQLite transaction, including retries. */
export function reserveProviderAttempt(db: DatabaseSync, logId: number, recipientUserId: number, businessDate: string, globalLimit: number, userLimit: number, now: string): boolean {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const global = (db.prepare('SELECT COALESCE(SUM(attempt_count),0) AS count FROM ai_request_logs WHERE business_date=?').get(businessDate) as { count: number }).count;
    const user = (db.prepare('SELECT COALESCE(SUM(attempt_count),0) AS count FROM ai_request_logs WHERE business_date=? AND recipient_user_id=?').get(businessDate, recipientUserId) as { count: number }).count;
    if (global >= globalLimit || user >= userLimit) { db.exec('COMMIT;'); return false; }
    const changed = db.prepare(`UPDATE ai_request_logs SET attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='generating'`).run(now, logId).changes === 1;
    db.exec('COMMIT;'); return changed;
  } catch (error) { db.exec('ROLLBACK;'); throw error; }
}
export function cleanupAiRetention(db: DatabaseSync, now: string, limit = 100): number {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`UPDATE ai_request_logs SET status='failed',error_code='AI_RESULT_EXPIRED',error_summary='AI_RESULT_EXPIRED',completed_at=?,
      result_snapshot_json=NULL,result_hash=NULL,result_retain_until=NULL,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?
      WHERE id IN (SELECT id FROM ai_request_logs WHERE status='ready' AND result_snapshot_json IS NOT NULL AND result_retain_until<=? ORDER BY result_retain_until LIMIT ?)`).run(now, now, now, limit);
    db.prepare(`UPDATE ai_request_logs SET result_snapshot_json=NULL,result_hash=NULL,result_retain_until=NULL,updated_at=?
      WHERE id IN (SELECT id FROM ai_request_logs WHERE status!='ready' AND result_snapshot_json IS NOT NULL AND result_retain_until<=? ORDER BY result_retain_until LIMIT ?)`).run(now, now, limit);
    const deleted = db.prepare(`DELETE FROM ai_request_logs WHERE id IN (SELECT id FROM ai_request_logs WHERE status IN ('completed','skipped','failed','cancelled') AND retain_until<=? ORDER BY retain_until LIMIT ?)`).run(now, limit);
    db.exec('COMMIT;'); return Number(deleted.changes);
  } catch (error) { db.exec('ROLLBACK;'); throw error; }
}
