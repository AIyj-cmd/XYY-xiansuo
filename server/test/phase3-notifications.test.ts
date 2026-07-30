import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-phase3-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.JWT_SECRET = 'phase-three-notification-test-secret-32';
process.env.LEAD_POOL_CLAIM_ENABLED = 'false';
process.env.NOTIFICATION_CAPTURE_ENABLED = 'true';
process.env.NOTIFICATION_WORKER_ENABLED = 'false';
process.env.NOTIFICATION_MOCK_ENABLED = 'false';
process.env.NOTIFICATION_SCHEDULER_ENABLED = 'false';
const { initDb, getDb, closeDb } = await import('../src/db.js');
const { leadRoutes } = await import('../src/routes/leads.js');
const { signToken } = await import('../src/utils/jwt.js');
const { claimNotificationTasks, finishNotificationTask } = await import('../src/services/notification.js');
const { transferLeadOwner } = await import('../src/services/lead-owner.js');
initDb(); const db = getDb();
db.prepare("INSERT INTO users (username,name,password_hash,role) VALUES ('p3admin','管理员','hash','admin'),('p3owner','原负责人','hash','member'),('p3target','新负责人','hash','member')").run();
const users = Object.fromEntries((db.prepare('SELECT id,username FROM users').all() as Array<{ id:number; username:string }>).map((v) => [v.username, v.id])) as Record<string, number>;
const token = await signToken({ id: users.p3admin, username: 'p3admin', name: '管理员', role: 'admin' });
const app = Fastify(); await app.register(leadRoutes); await app.ready();
function lead(name: string) { return Number(db.prepare("INSERT INTO leads (contact_name,source,status,owner_id,lead_date,created_by,created_at) VALUES (?,'官网','跟进中',?,'2026-01-01',?,'2026-01-01 00:00:00')").run(name, users.p3owner, users.p3admin).lastInsertRowid); }

test('默认关闭公海在参数校验前拒绝，且不产生认领审计或负责人变化', async () => {
  const id = lead('关闭公海'); const response = await app.inject({ method: 'POST', url: `/api/pool/${id}/claim?bad=1`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 403); assert.deepEqual(response.json().data, { error_code: 'LEAD_POOL_CLAIM_DISABLED' });
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id=?').get(id) as any).owner_id, users.p3owner);
  assert.equal((db.prepare("SELECT count(*) AS count FROM audit_logs WHERE lead_id=? AND source='pool_claim'").get(id) as any).count, 0);
});

test('合格负责人转移在规则关闭时写 suppressed，普通字段编辑不写任务', async () => {
  const id = lead('通知抑制'); const changed = await app.inject({ method: 'PATCH', url: `/api/leads/${id}`, headers: { authorization: `Bearer ${token}` }, payload: { owner_id: users.p3target } }); assert.equal(changed.statusCode, 200);
  const task = db.prepare('SELECT status,suppression_reason,event_source,recipient_user_id FROM notification_logs WHERE lead_id=?').get(id) as any;
  assert.deepEqual({ ...task }, { status: 'suppressed', suppression_reason: 'rule_disabled', event_source: 'single_edit', recipient_user_id: users.p3target });
  const edited = await app.inject({ method: 'PATCH', url: `/api/leads/${id}`, headers: { authorization: `Bearer ${token}` }, payload: { company_name: '普通编辑' } }); assert.equal(edited.statusCode, 200);
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs WHERE lead_id=?').get(id) as any).count, 1);
});

test('Mock 开启后 pending 可被领取，旧 lease token 不能覆盖发送结果', () => {
  process.env.NOTIFICATION_MOCK_ENABLED = 'true'; db.prepare("UPDATE notification_rules SET enabled=1 WHERE event_type='owner_changed'").run(); const id = lead('待发送');
  // 通过服务确保业务审计和 outbox 同一事务。
  transferLeadOwner(db, { leadId: id, newOwnerId: users.p3target, actorUserId: users.p3admin, source: 'single_edit', operationId: 'phase3-operation', updatedAt: '2026-07-30 10:00:00' });
  const tasks = claimNotificationTasks(db, 'test-worker', '2026-07-30 10:00:01'); assert.equal(tasks.length, 1);
  assert.equal(finishNotificationTask(db, { ...tasks[0], lease_token: 'old-token' }, { kind: 'sent', receipt: 'wrong' }, '2026-07-30 10:00:02'), false);
  assert.equal(finishNotificationTask(db, tasks[0], { kind: 'sent', receipt: 'mock-ok' }, '2026-07-30 10:00:02'), true);
  assert.equal((db.prepare('SELECT status FROM notification_logs WHERE id=?').get(tasks[0].id) as any).status, 'sent');
});

test.after(async () => { await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true }); });
