import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { closeDb, getDb, initDb } from './db.js';
import { resolveNotificationConfig } from './config.js';
import { cleanupNotificationRetention, claimNotificationTasks, finishNotificationTask, validateClaimedNotificationTask } from './services/notification.js';
import { MockNotificationChannel } from './services/mock-notification-channel.js';
import { nowDatetime } from './utils/datetime.js';

let stopping = false;
const WORKER_CONCURRENCY = 2;
async function processTask(db: ReturnType<typeof getDb>, channel: MockNotificationChannel, task: Record<string, any>): Promise<void> {
  const validation = validateClaimedNotificationTask(db, task, nowDatetime());
  if (validation !== 'valid') {
    console.log(JSON.stringify({ event: validation === 'cancelled' ? 'notification.worker.cancelled' : 'notification.worker.lease_lost', id: task.id }));
    return;
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let snapshot: { title?: unknown; detail_path?: unknown };
    try {
      snapshot = JSON.parse(task.message_snapshot_json) as { title?: unknown; detail_path?: unknown };
    } catch {
      throw Object.assign(new Error('消息快照不合法'), { code: 'invalid_message_schema', permanent: true });
    }
    if (typeof snapshot.title !== 'string' || typeof snapshot.detail_path !== 'string' || !snapshot.detail_path.startsWith('/pages/')) {
      throw Object.assign(new Error('消息快照不合法'), { code: 'invalid_message_schema', permanent: true });
    }
    if (!Number.isInteger(task.recipient_user_id) || typeof task.delivery_idempotency_key !== 'string') {
      throw Object.assign(new Error('任务数据不完整'), { code: 'unrecoverable_task_data', permanent: true });
    }
    const receipt = await channel.send({ userId: task.recipient_user_id }, { title: snapshot.title, detailPath: snapshot.detail_path }, task.delivery_idempotency_key, controller.signal);
    const updated = finishNotificationTask(db, task, { kind: 'sent', receipt: receipt.providerMessageId }, nowDatetime());
    console.log(JSON.stringify({ event: updated ? 'notification.worker.sent' : 'notification.worker.lease_lost', id: task.id }));
  } catch (error) {
    const e = error as { code?: string; permanent?: boolean; message?: string };
    const updated = finishNotificationTask(db, task, { kind: e.permanent ? 'permanent' : 'temporary', code: e.code, message: e.message }, nowDatetime());
    console.log(JSON.stringify({ event: updated ? (e.permanent ? 'notification.worker.failed' : 'notification.worker.retry_scheduled') : 'notification.worker.lease_lost', id: task.id, error_code: e.code ?? 'unknown' }));
  }
  finally { clearTimeout(timer); }
}
export async function runOnce(): Promise<void> {
  const config = resolveNotificationConfig(); if (!config.workerEnabled) return;
  const db = getDb(); const now = nowDatetime(); const cleaned = cleanupNotificationRetention(db, now);
  if (cleaned) console.log(JSON.stringify({ event: 'notification.worker.retention_cleaned', count: cleaned }));
  const tasks = claimNotificationTasks(db, `notification-worker:${process.pid}:${randomUUID()}`, now, 10);
  if (tasks.length) console.log(JSON.stringify({ event: 'notification.worker.claimed', count: tasks.length }));
  const channel = new MockNotificationChannel();
  for (let index = 0; index < tasks.length && !stopping; index += WORKER_CONCURRENCY) {
    await Promise.all(tasks.slice(index, index + WORKER_CONCURRENCY).map((task) => processTask(db, channel, task)));
  }
}
export async function startWorker(): Promise<void> {
  const config = resolveNotificationConfig();
  if (!config.workerEnabled) { console.log(JSON.stringify({ event: 'notification.worker.disabled' })); return; }
  if (!process.env.DB_PATH || !path.isAbsolute(process.env.DB_PATH)) throw new Error('通知 Worker 启用时 DB_PATH 必须为与 API 相同的绝对路径');
  initDb();
  const tick = async () => { if (stopping) return; try { await runOnce(); } catch (error) { console.error(JSON.stringify({ event: 'notification.worker.error', error: error instanceof Error ? error.name : 'UnknownError' })); } if (!stopping) setTimeout(tick, 1000); };
  await tick();
}
if (process.argv[1]?.endsWith('notification-worker.ts') || process.argv[1]?.endsWith('notification-worker.js')) {
  void startWorker().catch((error) => {
    console.error(JSON.stringify({ event: 'notification.worker.start_failed', error: error instanceof Error ? error.message : 'UnknownError' }));
    process.exitCode = 1;
  });
  const stop = () => { stopping = true; setTimeout(() => { closeDb(); process.exit(0); }, 10_000); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
