import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { closeDb, getDb, initDb } from './db.js';
import { resolveNotificationConfig } from './config.js';
import { cleanupNotificationRetention, claimNotificationTasks, finishNotificationTask, validateClaimedNotificationTask } from './services/notification.js';
import { MockNotificationChannel } from './services/mock-notification-channel.js';
import { OpenClawNotificationChannel, openClawMessage, type NotificationChannelMessage } from './services/openclaw-notification-channel.js';
import { HermesNotificationChannel } from './services/hermes-notification-channel.js';
import { SYNTHETIC_PILOT_EVENT_SOURCE, assertSyntheticDatabasePath, assertSyntheticDatabaseSafety, assertSyntheticWorkerBatchSafety, isSyntheticPilotTask, openClawSyntheticPilotMessage, readSyntheticPilotControl, type SyntheticPilotTask } from './openclaw-synthetic-pilot.js';
import { nowDatetime } from './utils/datetime.js';
import { parseNotificationSnapshot, toChannelMessage } from './notifications/snapshot.js';

let stopping = false;
const WORKER_CONCURRENCY = 2;
export function workerAbortTimeoutMs(channel: string): number | undefined { return channel === 'mock' ? 10_000 : undefined; }
export function mapChannelResult(task: { channel: string; delivery_idempotency_key: string }, result: { status: string; providerMessageId?: string; errorCode?: string }) {
  return result.status === 'sent'
    ? result.providerMessageId
      ? { kind: 'sent' as const, receipt: result.providerMessageId }
      : { kind: 'permanent' as const, code: 'OPENCLAW_SENT_RECEIPT_MISSING', retryAllowed: 0 as const }
    : result.status === 'deduplicated'
      ? result.providerMessageId
        ? { kind: 'sent' as const, receipt: result.providerMessageId }
        : { kind: 'permanent' as const, code: 'OPENCLAW_DEDUPLICATED_RECEIPT_MISSING', retryAllowed: 0 as const }
      : result.status === 'result_unknown'
        ? { kind: 'permanent' as const, code: task.channel === 'hermes' ? 'HERMES_SEND_RESULT_UNKNOWN' : 'OPENCLAW_SEND_RESULT_UNKNOWN', message: result.errorCode, retryAllowed: 0 as const }
        : result.status === 'permanent_failure'
          ? { kind: 'permanent' as const, code: result.errorCode, retryAllowed: task.channel === 'openclaw' || task.channel === 'hermes' ? 0 as const : undefined }
          : { kind: 'temporary' as const, code: result.errorCode };
}
async function processTask(db: ReturnType<typeof getDb>, channels: { mock: MockNotificationChannel; openclaw?: OpenClawNotificationChannel; hermes?: HermesNotificationChannel }, task: Record<string, any>): Promise<void> {
  const validation = validateClaimedNotificationTask(db, task, nowDatetime());
  if (validation !== 'valid') {
    console.log(JSON.stringify({ event: validation === 'cancelled' ? 'notification.worker.cancelled' : 'notification.worker.lease_lost', id: task.id }));
    return;
  }
  const controller = new AbortController();
  // Mock retains its historical 10s Worker ceiling. OpenClaw owns its timeout
  // inside the channel so OPENCLAW_GATEWAY_TIMEOUT_MS is never masked here.
  const workerTimeout = workerAbortTimeoutMs(task.channel);
  const timer = workerTimeout === undefined ? undefined : setTimeout(() => controller.abort(), workerTimeout);
  try {
    if (!Number.isInteger(task.recipient_user_id) || typeof task.delivery_idempotency_key !== 'string') {
      throw Object.assign(new Error('任务数据不完整'), { code: 'unrecoverable_task_data', permanent: true });
    }
    let result: { status: string; providerMessageId?: string; errorCode?: string };
    const syntheticMessage = task.event_source === SYNTHETIC_PILOT_EVENT_SOURCE
      ? isSyntheticPilotTask(task as SyntheticPilotTask, Number(task.recipient_user_id), String(task.delivery_idempotency_key)) ? openClawSyntheticPilotMessage() : undefined
      : undefined;
    if (task.event_source === SYNTHETIC_PILOT_EVENT_SOURCE && (!syntheticMessage || task.channel !== 'openclaw')) {
      throw Object.assign(new Error('合成测试任务不合法'), { code: 'OPENCLAW_SYNTHETIC_TASK_INVALID', permanent: true });
    }
    let controlledSyntheticMessage: NotificationChannelMessage | undefined = syntheticMessage;
    if (syntheticMessage) {
      try {
        const databasePath = assertSyntheticDatabasePath(process.env.DB_PATH || '').databasePath;
        assertSyntheticDatabaseSafety(db, { databasePath, pilotUserId: Number(task.recipient_user_id), idempotencyKey: String(task.delivery_idempotency_key) }, 'worker');
        controlledSyntheticMessage = { ...syntheticMessage, pilotControl: readSyntheticPilotControl(db, { databasePath, pilotUserId: Number(task.recipient_user_id), idempotencyKey: String(task.delivery_idempotency_key) }, task as SyntheticPilotTask) };
      } catch { throw Object.assign(new Error('合成测试数据库封印不合法'), { code: 'OPENCLAW_SYNTHETIC_DATABASE_UNSAFE', permanent: true }); }
    }
    if (task.channel === 'mock') {
      const snapshot = parseNotificationSnapshot(task.event_type, task.message_snapshot_json);
      const receipt = await channels.mock.send({ userId: task.recipient_user_id }, toChannelMessage(task.event_type, snapshot), task.delivery_idempotency_key, controller.signal);
      result = { status: 'sent', providerMessageId: receipt.providerMessageId };
    } else if (task.channel === 'openclaw' && channels.openclaw) {
      const ownerMessage = task.event_type === 'owner_changed'
        ? toChannelMessage(task.event_type, parseNotificationSnapshot(task.event_type, task.message_snapshot_json))
        : undefined;
      result = await channels.openclaw.send({ userId: task.recipient_user_id }, controlledSyntheticMessage ?? ownerMessage ?? openClawMessage(task.event_type), task.delivery_idempotency_key, controller.signal);
    } else if (task.channel === 'hermes' && channels.hermes) {
      if (!Number.isInteger(task.recipient_binding_generation) || task.recipient_binding_generation < 1) throw Object.assign(new Error('Hermes 任务缺少绑定代次'), { code: 'HERMES_BINDING_GENERATION_INVALID', permanent: true });
      const ownerMessage = task.event_type === 'owner_changed' ? toChannelMessage(task.event_type, parseNotificationSnapshot(task.event_type, task.message_snapshot_json)) : undefined;
      if (!ownerMessage) throw Object.assign(new Error('Hermes 仅支持负责人变更通知'), { code: 'EVENT_NOT_IMPLEMENTED', permanent: true });
      result = await channels.hermes.send({ userId: task.recipient_user_id, generation: task.recipient_binding_generation }, ownerMessage, task.delivery_idempotency_key, controller.signal);
    } else throw Object.assign(new Error('渠道任务不允许领取'), { code: 'CHANNEL_NOT_ALLOWED', permanent: true });
    const outcome = mapChannelResult(task as { channel: string; delivery_idempotency_key: string }, result);
    const updated = finishNotificationTask(db, task, outcome, nowDatetime());
    const event = result.status === 'result_unknown' ? 'notification.worker.result_unknown' : outcome.kind === 'sent' ? 'notification.worker.sent' : outcome.kind === 'temporary' ? 'notification.worker.retry_scheduled' : 'notification.worker.failed';
    console.log(JSON.stringify({ event: updated ? event : 'notification.worker.lease_lost', id: task.id, ...(result.status === 'result_unknown' ? { error_code: result.errorCode ?? 'OPENCLAW_SEND_RESULT_UNKNOWN' } : {}) }));
  } catch (error) {
    const e = error as { code?: string; permanent?: boolean; message?: string };
    const updated = finishNotificationTask(db, task, { kind: e.permanent ? 'permanent' : 'temporary', code: e.code, message: e.message }, nowDatetime());
    console.log(JSON.stringify({ event: updated ? (e.permanent ? 'notification.worker.failed' : 'notification.worker.retry_scheduled') : 'notification.worker.lease_lost', id: task.id, error_code: e.code ?? 'unknown' }));
  }
  finally { if (timer) clearTimeout(timer); }
}
export async function runOnce(): Promise<void> {
  const config = resolveNotificationConfig(process.env, { requireOpenClawSecret: true }); if (!config.workerEnabled) return;
  const db = getDb(); const now = nowDatetime();
  // The synthetic marker turns this DB into a sealed single-task workspace.
  // Gate before *any* queue maintenance, and again after claim with the
  // expected `sending` phase. Retention cleanup must never erase evidence of
  // contamination before the sealed-state proof runs.
  try { assertSyntheticWorkerBatchSafety(db, process.env.DB_PATH || '', config.openclawPilotUserId, 'repeat'); }
  catch {
    console.error(JSON.stringify({ event: 'notification.worker.synthetic_batch_blocked', stage: 'before_claim' }));
    return;
  }
  const cleaned = cleanupNotificationRetention(db, now);
  if (cleaned) console.log(JSON.stringify({ event: 'notification.worker.retention_cleaned', count: cleaned }));
  const available: Array<'mock' | 'openclaw' | 'hermes'> = [];
  if (config.mockEnabled) available.push('mock');
  if (config.openclawEnabled) available.push('openclaw');
  if (config.hermesEnabled) available.push('hermes');
  const tasks = claimNotificationTasks(db, `notification-worker:${process.pid}:${randomUUID()}`, now, 10, available);
  if (tasks.length) console.log(JSON.stringify({ event: 'notification.worker.claimed', count: tasks.length }));
  if (tasks.length) {
    try { assertSyntheticWorkerBatchSafety(db, process.env.DB_PATH || '', config.openclawPilotUserId, 'worker'); }
    catch {
      console.error(JSON.stringify({ event: 'notification.worker.synthetic_batch_blocked', stage: 'after_claim', claimed: tasks.length }));
      return;
    }
  }
  const channels = { mock: new MockNotificationChannel(), ...(config.openclawEnabled ? { openclaw: new OpenClawNotificationChannel(config) } : {}), ...(config.hermesEnabled ? { hermes: new HermesNotificationChannel(config) } : {}) };
  for (let index = 0; index < tasks.length && !stopping; index += WORKER_CONCURRENCY) {
    await Promise.all(tasks.slice(index, index + WORKER_CONCURRENCY).map((task) => processTask(db, channels, task)));
  }
}
export async function startWorker(): Promise<void> {
  const config = resolveNotificationConfig(process.env, { requireOpenClawSecret: true });
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
