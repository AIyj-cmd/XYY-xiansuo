import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { aiIdempotencyKey } from './ai/audit-store.js';
import { getActiveRecipient, validateDigestContext } from './ai/permission-query.js';
import { parseNotificationSnapshot } from './notifications/snapshot.js';
import { SYNTHETIC_PILOT_EVENT_SOURCE, assertSyntheticDatabaseSafety, isSyntheticPilotTask, syntheticOperationId } from './openclaw-synthetic-pilot.js';
import { CLAIMABLE_NOTIFICATION_WHERE } from './services/notification.js';

export type PilotQueueInput = { recipientUserId: number; eventType: 'scheduled_follow_overdue' | 'daily_report'; businessDate: string; now: string; databasePath: string; syntheticIdempotencyKey?: string };
type Candidate = import('./openclaw-synthetic-pilot.js').SyntheticPilotTask & { id: number };
type Decision = { pilot: boolean; reason?: string; operationId?: string };
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function expectedOperation(input: PilotQueueInput, snapshot: any): string | undefined {
  if (input.syntheticIdempotencyKey) return syntheticOperationId(input.syntheticIdempotencyKey);
  const scope = input.eventType === 'scheduled_follow_overdue' ? 'self' : snapshot.scope;
  if (scope !== 'self' && scope !== 'team') return undefined;
  return `ai:${aiIdempotencyKey(input.eventType, input.recipientUserId, input.businessDate, scope)}`;
}
function isValidPilot(db: DatabaseSync, row: Candidate, input: PilotQueueInput): Decision {
  if (input.syntheticIdempotencyKey) {
    if (row.event_source !== SYNTHETIC_PILOT_EVENT_SOURCE || row.event_type !== 'daily_report' || row.recipient_user_id !== input.recipientUserId) return { pilot: false, reason: 'outside_pilot_scope' };
    if (!isSyntheticPilotTask(row, input.recipientUserId, input.syntheticIdempotencyKey)) return { pilot: false, reason: 'pilot_snapshot_invalid' };
    try { if (JSON.parse(row.message_snapshot_json).business_date !== input.businessDate) return { pilot: false, reason: 'outside_pilot_scope' }; } catch { return { pilot: false, reason: 'pilot_snapshot_invalid' }; }
    const recipient = getActiveRecipient(db, input.recipientUserId);
    return recipient?.role === 'member' ? { pilot: true, operationId: row.operation_id } : { pilot: false, reason: 'recipient_inactive_or_missing' };
  }
  if (row.event_source !== 'ai_scheduler' || row.event_type !== input.eventType || row.recipient_user_id !== input.recipientUserId) return { pilot: false, reason: 'outside_pilot_scope' };
  let snapshot: any;
  try { snapshot = parseNotificationSnapshot(input.eventType, row.message_snapshot_json); } catch { return { pilot: false, reason: 'pilot_snapshot_invalid' }; }
  if (snapshot.business_date !== input.businessDate) return { pilot: false, reason: 'outside_pilot_scope' };
  const operationId = expectedOperation(input, snapshot);
  if (!operationId || row.operation_id !== operationId) return { pilot: false, reason: 'pilot_operation_mismatch' };
  const recipient = getActiveRecipient(db, input.recipientUserId);
  if (!recipient) return { pilot: false, reason: 'recipient_inactive_or_missing' };
  if (input.eventType === 'scheduled_follow_overdue' && (!Array.isArray(snapshot.subject_lead_ids) || !snapshot.subject_lead_ids.length)) return { pilot: false, reason: 'pilot_snapshot_invalid' };
  if (input.eventType === 'daily_report' && ((snapshot.scope === 'team' && recipient.role !== 'admin') || (snapshot.scope === 'self' && recipient.role !== 'member'))) return { pilot: false, reason: 'recipient_scope_invalid' };
  if (!validateDigestContext(db, input.eventType, input.recipientUserId, snapshot.subject_lead_ids)) return { pilot: false, reason: 'context_stale' };
  return { pilot: true, operationId };
}

/** Read-only point-in-time proof that starting the unmodified Worker is safe. */
export function inspectPilotQueue(db: DatabaseSync, input: PilotQueueInput): Record<string, unknown> {
  if (input.syntheticIdempotencyKey) {
    try { assertSyntheticDatabaseSafety(db, { databasePath: input.databasePath, pilotUserId: input.recipientUserId, idempotencyKey: input.syntheticIdempotencyKey }, 'queue'); }
    catch {
      return {
        database_path_hash: shortHash(input.databasePath), checked_at: input.now, recipient_user_id: input.recipientUserId, business_date: input.businessDate, event_type: input.eventType,
        claimable_task_count: 0, pilot_task_count: 0, non_pilot_task_count: 0, by_event_type: {}, by_status: {}, pilot_operation_ids: [], blockers: ['synthetic_database_unsafe'], conclusion: 'UNSAFE',
      };
    }
  }
  const rows = db.prepare(`SELECT * FROM notification_logs WHERE ${CLAIMABLE_NOTIFICATION_WHERE} ORDER BY available_at,id`).all(input.now, input.now, input.now, input.now) as Candidate[];
  const eventCounts: Record<string, number> = {}; const statusCounts: Record<string, number> = {};
  const blockers = new Set<string>(); const operationIds = new Set<string>(); let pilotCount = 0;
  for (const row of rows) {
    eventCounts[row.event_type] = (eventCounts[row.event_type] ?? 0) + 1;
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    const decision = isValidPilot(db, row, input);
    if (decision.pilot) { pilotCount += 1; if (decision.operationId) operationIds.add(shortHash(decision.operationId)); }
    else blockers.add(decision.reason ?? 'outside_pilot_scope');
  }
  if (!pilotCount) blockers.add('target_pilot_task_missing');
  if (input.syntheticIdempotencyKey && pilotCount !== 1) blockers.add('synthetic_pilot_task_count_invalid');
  return {
    database_path_hash: shortHash(input.databasePath), checked_at: input.now, recipient_user_id: input.recipientUserId,
    business_date: input.businessDate, event_type: input.eventType, claimable_task_count: rows.length,
    pilot_task_count: pilotCount, non_pilot_task_count: rows.length - pilotCount, by_event_type: eventCounts,
    by_status: statusCounts, pilot_operation_ids: [...operationIds].sort(), blockers: [...blockers].sort(),
    conclusion: blockers.size ? 'UNSAFE' : 'SAFE',
  };
}
