import type { DatabaseSync } from 'node:sqlite';
import { cancelAiLog, finishAiLog, skipAiLog, type AiLog } from '../ai/audit-store.js';
import { createScheduledNotification, type AiNotificationEvent } from '../notifications/notification-event-service.js';

/**
 * Persist the notification outbox row, its AI association and temporary-result
 * removal atomically. Context changes cancel the frozen digest without rewriting it.
 */
export function finalizeAiNotification(db: DatabaseSync, log: AiLog, event: AiNotificationEvent, now: string): void {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const created = createScheduledNotification(db, event);
    if (created.reason === 'NOTIFICATION_CAPTURE_DISABLED') {
      skipAiLog(db, log.id, 'NOTIFICATION_CAPTURE_DISABLED', now);
    } else {
      finishAiLog(db, log.id, event.operationId, created.id, now);
    }
    db.exec('COMMIT;');
  } catch (error: any) {
    if (error?.code === 'AI_CONTEXT_STALE') {
      cancelAiLog(db, log.id, now);
      db.exec('COMMIT;');
      return;
    }
    db.exec('ROLLBACK;');
    throw error;
  }
}
