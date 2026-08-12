import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-notification-capabilities-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'notification.sqlite');
process.env.JWT_SECRET = 'notification-capabilities-test-secret-at-least-32';
process.env.NOTIFICATION_CAPTURE_ENABLED = 'true';
process.env.NOTIFICATION_MOCK_ENABLED = 'true';

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { notificationAdminRoutes } = await import('../src/routes/notification-admin.js');
const { createScheduledNotification } = await import('../src/notifications/notification-event-service.js');
const { isNotificationEventChannelSupported, claimNotificationTasks, validateClaimedNotificationTask } = await import('../src/services/notification.js');
const { signToken } = await import('../src/utils/jwt.js');

const snapshot = {
  schema_version: 1, title: '日报', summary: '摘要',
  metrics: { today_new_count: 1, today_follow_up_count: 0, overdue_count: 0, next_day_count: 0 },
  highlights: [], actions: [], closing: '以实际为准', subject_lead_ids: [1],
  business_date: '2099-01-02', scope: 'self', fallback_used: true, detail_path: '/pages/notify/index',
};

test('事件×渠道矩阵统一约束规则、preview、AI入队、Worker领取与人工重试', { concurrency: false }, async () => {
  initDb(); const db = getDb();
  db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('cap-admin','管理员','x','admin'),('cap-member','成员','x','member')").run();
  db.prepare("INSERT INTO leads(contact_name,source,lead_date,status,owner_id) VALUES ('通知线索','官网','2099-01-02','跟进中',2)").run();
  const app = Fastify(); await app.register(notificationAdminRoutes); await app.ready();
  const token = await signToken({ id: 1 }); const auth = { authorization: `Bearer ${token}` };

  assert.equal(isNotificationEventChannelSupported('owner_changed', 'hermes'), true);
  assert.equal(isNotificationEventChannelSupported('daily_report', 'hermes'), false);
  assert.equal(isNotificationEventChannelSupported('scheduled_follow_overdue', 'hermes'), false);
  assert.equal(isNotificationEventChannelSupported('daily_report', 'mock'), true);
  assert.equal(isNotificationEventChannelSupported('daily_report', 'openclaw'), true);

  const ownerRule = (await app.inject({ method: 'GET', url: '/api/admin/notification-rules/owner_changed', headers: auth })).json().data;
  const ownerPreview = await app.inject({
    method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: auth,
    payload: { rule: { enabled: false, recipient_strategy: 'new_owner', channel_order: ['hermes'], config: ownerRule.config, expected_version: ownerRule.version }, sample: { lead_id: 1, actor_user_id: 1, old_owner_id: 1, new_owner_id: 2 } },
  });
  assert.equal(ownerPreview.statusCode, 200);

  for (const eventType of ['daily_report', 'scheduled_follow_overdue']) {
    const rule = (await app.inject({ method: 'GET', url: `/api/admin/notification-rules/${eventType}`, headers: auth })).json().data;
    const rejected = await app.inject({ method: 'PUT', url: `/api/admin/notification-rules/${eventType}`, headers: auth, payload: { enabled: false, recipient_strategy: 'reserved', channel_order: ['hermes'], config: rule.config, expected_version: rule.version } });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().data.error_code, 'CHANNEL_NOT_ALLOWED');
  }

  // Simulate a legacy admin configuration that predates this capability table.
  db.prepare("UPDATE notification_rules SET enabled=1,channel_order_json='[\"hermes\"]' WHERE event_type='daily_report'").run();
  const created = createScheduledNotification(db, { eventType: 'daily_report', operationId: 'legacy-ai-hermes', recipientUserId: 2, businessDate: '2099-01-02', scope: 'self', subjectLeadIds: [1], messageSnapshot: snapshot, occurredAt: '2099-01-02 18:00:00' });
  assert.deepEqual({ status: created.status, reason: created.reason }, { status: 'suppressed', reason: 'channel_not_supported' });
  assert.deepEqual({ ...(db.prepare("SELECT status,channel,suppression_reason FROM notification_logs WHERE operation_id='legacy-ai-hermes'").get() as object) }, { status: 'suppressed', channel: null, suppression_reason: 'channel_not_supported' });

  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
    VALUES ('daily_report','legacy','legacy-pending','recipient_digest',2,2,'2099-01-02 18:00:00','legacy-pending','legacy-pending-delivery',1,'{}','["hermes"]','hermes',?,'pending',1,'2099-01-02 18:00:00','2099-01-03 18:00:00')`).run(JSON.stringify(snapshot));
  const claimed = claimNotificationTasks(db, 'capability-worker', '2099-01-02 18:00:00', 10, ['hermes']);
  assert.equal(claimed.length, 1);
  assert.equal(validateClaimedNotificationTask(db, claimed[0], '2099-01-02 18:00:01'), 'cancelled');
  assert.deepEqual({ ...(db.prepare("SELECT status,cancellation_reason FROM notification_logs WHERE operation_id='legacy-pending'").get() as object) }, { status: 'cancelled', cancellation_reason: 'channel_not_supported' });

  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at,retry_allowed,failed_at,retain_until)
    VALUES ('daily_report','legacy','legacy-failed','recipient_digest',2,2,'2099-01-02 18:00:00','legacy-failed','legacy-failed-delivery',1,'{}','["hermes"]','hermes',?,'failed',1,'2099-01-02 18:00:00','2099-01-03 18:00:00',1,'2099-01-02 18:00:01','2099-07-01 00:00:00')`).run(JSON.stringify(snapshot));
  const failed = db.prepare("SELECT id,row_version FROM notification_logs WHERE operation_id='legacy-failed'").get() as { id: number; row_version: number };
  const retry = await app.inject({ method: 'POST', url: `/api/admin/notification-logs/${failed.id}/retry`, headers: auth, payload: { expected_version: failed.row_version, reason: '不得重放非法渠道任务' } });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().data.error_code, 'RETRY_NOT_ALLOWED');
  assert.equal((db.prepare('SELECT status FROM notification_logs WHERE id=?').get(failed.id) as { status: string }).status, 'failed');

  await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true });
});
