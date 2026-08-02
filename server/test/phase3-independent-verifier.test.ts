import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

// 独立验证使用专用临时库，绝不触碰 server/data。
const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-phase3-independent-'));
process.env.DB_PATH = path.join(directory, 'verification.db');
process.env.JWT_SECRET = 'phase-three-independent-verifier-secret-32';
process.env.LEAD_POOL_CLAIM_ENABLED = 'false';
process.env.NOTIFICATION_CAPTURE_ENABLED = 'true';
process.env.NOTIFICATION_WORKER_ENABLED = 'false';
process.env.NOTIFICATION_MOCK_ENABLED = 'false';
process.env.NOTIFICATION_SCHEDULER_ENABLED = 'false';

const { initDb, getDb, closeDb, MIGRATIONS } = await import('../src/db.js');
const { leadRoutes } = await import('../src/routes/leads.js');
const { notificationAdminRoutes } = await import('../src/routes/notification-admin.js');
const { signToken } = await import('../src/utils/jwt.js');
const { transferLeadOwner } = await import('../src/services/lead-owner.js');
const { captureOwnerChanged, claimNotificationTasks, cleanupNotificationRetention, finishNotificationTask, maintainNotificationQueue, validateClaimedNotificationTask } = await import('../src/services/notification.js');
const { resolveNotificationConfig } = await import('../src/config.js');
const { MockNotificationChannel } = await import('../src/services/mock-notification-channel.js');
const { runOnce, startWorker } = await import('../src/notification-worker.js');
const { schedulerDryRunOptions, schedulerRegistry } = await import('../src/services/notification-scheduler.js');

initDb();
const db = getDb();
db.prepare("INSERT INTO users (username,name,password_hash,role) VALUES ('iv-admin','管理员','hash','admin'),('iv-member','成员','hash','member'),('iv-old','原负责人','hash','member'),('iv-new','新负责人','hash','member')").run();
const ids = Object.fromEntries((db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>).map((row) => [row.username, row.id])) as Record<string, number>;
const adminToken = await signToken({ id: ids['iv-admin'], username: 'iv-admin', name: '管理员', role: 'admin' });
const memberToken = await signToken({ id: ids['iv-member'], username: 'iv-member', name: '成员', role: 'member' });
const app = Fastify();
await app.register(leadRoutes);
await app.register(notificationAdminRoutes);
await app.ready();

function makeLead(name: string, ownerId = ids['iv-old']): number {
  return Number(db.prepare("INSERT INTO leads (contact_name,source,status,owner_id,lead_date,created_by) VALUES (?,'官网','跟进中',?,'2026-07-01',?)").run(name, ownerId, ids['iv-admin']).lastInsertRowid);
}

test('004 仅追加通知结构、初始规则均关闭，且 001-003 checksum 未变化', () => {
  assert.deepEqual(MIGRATIONS.slice(0, 3).map((migration) => [migration.version, migration.checksum]), [
    ['001', 'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0'],
    ['002', 'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9'],
    ['003', 'e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704'],
  ]);
  assert.equal((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('notification_rules','notification_logs')").get() as any).count, 2);
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_rules WHERE enabled != 0').get() as any).count, 0);
  assert.equal((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '%pool%'").get() as any).count, 0);
});

test('关闭公海时认证后于参数校验、查询和事务之前统一拒绝，未认证保持 401', async () => {
  const id = makeLead('公海关闭验证');
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/pool?days=invalid' });
  assert.equal(unauthenticated.statusCode, 401);
  for (const request of [
    { method: 'GET' as const, url: '/api/pool?days=invalid' },
    { method: 'POST' as const, url: `/api/pool/not-a-number/claim` },
  ]) {
    const response = await app.inject({ ...request, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json().data, { error_code: 'LEAD_POOL_CLAIM_DISABLED' });
  }
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id=?').get(id) as any).owner_id, ids['iv-old']);
  assert.equal((db.prepare("SELECT count(*) AS count FROM audit_logs WHERE lead_id=? AND source='pool_claim'").get(id) as any).count, 0);
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs WHERE lead_id=?').get(id) as any).count, 0);
});

test('保留全部线索并且成员不能访问管理通知 API', async () => {
  const id = makeLead('全部线索保留');
  const list = await app.inject({ method: 'GET', url: '/api/leads?keyword=全部线索保留', headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.list.some((row: { id: number }) => row.id === id), true);
  const memberRules = await app.inject({ method: 'GET', url: '/api/admin/notification-rules', headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(memberRules.statusCode, 403);
});

test('开启捕获且规则启用但无渠道时必须抑制 no_usable_channel', () => {
  const id = makeLead('无渠道抑制');
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  db.prepare("UPDATE notification_rules SET enabled=1, channel_order_json='[]' WHERE event_type='owner_changed'").run();
  db.exec('BEGIN IMMEDIATE;');
  try {
    transferLeadOwner(db, { leadId: id, newOwnerId: ids['iv-new'], actorUserId: ids['iv-admin'], source: 'single_edit', operationId: 'independent-empty-channel', updatedAt: '2026-07-30 12:00:00' });
    db.exec('COMMIT;');
  } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
  const task = db.prepare('SELECT status, suppression_reason FROM notification_logs WHERE lead_id=?').get(id) as any;
  assert.deepEqual({ ...task }, { status: 'suppressed', suppression_reason: 'no_usable_channel' });
});

test('迁移级 JSON 约束拒绝非对象规则配置', () => {
  assert.throws(() => db.prepare("UPDATE notification_rules SET config_json='[]' WHERE event_type='inactive_lead'").run(), /CHECK constraint failed/);
});

test('捕获关闭仍保留负责人和 transfer 审计、但不写 outbox', () => {
  const id = makeLead('捕获关闭');
  process.env.NOTIFICATION_CAPTURE_ENABLED = 'false';
  db.exec('BEGIN IMMEDIATE;');
  try {
    transferLeadOwner(db, { leadId: id, newOwnerId: ids['iv-new'], actorUserId: ids['iv-admin'], source: 'single_edit', operationId: 'independent-capture-off', updatedAt: '2026-07-30 12:10:00' });
    db.exec('COMMIT;');
  } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id=?').get(id) as any).owner_id, ids['iv-new']);
  assert.equal((db.prepare("SELECT count(*) AS count FROM audit_logs WHERE lead_id=? AND action='transfer'").get(id) as any).count, 1);
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs WHERE lead_id=?').get(id) as any).count, 0);
  process.env.NOTIFICATION_CAPTURE_ENABLED = 'true';
});

test('outbox 写入失败使负责人和 transfer 审计整体回滚', async () => {
  const id = makeLead('outbox 回滚');
  db.exec("CREATE TRIGGER independent_block_outbox BEFORE INSERT ON notification_logs BEGIN SELECT RAISE(ABORT, 'independent outbox failure'); END;");
  const response = await app.inject({ method: 'PATCH', url: `/api/leads/${id}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { owner_id: ids['iv-new'] } });
  assert.equal(response.statusCode, 500);
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id=?').get(id) as any).owner_id, ids['iv-old']);
  assert.equal((db.prepare("SELECT count(*) AS count FROM audit_logs WHERE lead_id=? AND action='transfer'").get(id) as any).count, 0);
  db.exec('DROP TRIGGER independent_block_outbox;');
});

test('管理 preview 不落库、敏感规则字段被拒绝、版本冲突返回 409', async () => {
  const initial = await app.inject({ method: 'GET', url: '/api/admin/notification-rules/owner_changed', headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(initial.statusCode, 200);
  const rule = initial.json().data;
  const payload = { rule: { enabled: false, recipient_strategy: 'new_owner', channel_order: ['mock'], config: rule.config, expected_version: rule.version }, sample: { lead_id: 1, actor_user_id: ids['iv-admin'], old_owner_id: ids['iv-old'], new_owner_id: ids['iv-new'] }, as_of: '2026-07-30 12:20:00' };
  const before = (db.prepare('SELECT count(*) AS count FROM notification_logs').get() as any).count;
  const preview = await app.inject({ method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: { authorization: `Bearer ${adminToken}` }, payload });
  assert.equal(preview.statusCode, 200);
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs').get() as any).count, before);
  payload.rule.config = { ...rule.config, secret: 'forbidden' };
  const rejected = await app.inject({ method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: { authorization: `Bearer ${adminToken}` }, payload });
  assert.equal(rejected.statusCode, 400);
  const conflict = await app.inject({ method: 'PUT', url: '/api/admin/notification-rules/owner_changed', headers: { authorization: `Bearer ${adminToken}` }, payload: { enabled: false, recipient_strategy: 'new_owner', channel_order: ['mock'], config: rule.config, expected_version: rule.version + 100 } });
  assert.equal(conflict.statusCode, 409);
});

test('管理员 preview 与 PUT 对单渠道和接收人策略采用相同校验，且未实现事件不回归', async () => {
  const current = (await app.inject({ method: 'GET', url: '/api/admin/notification-rules/owner_changed', headers: { authorization: `Bearer ${adminToken}` } })).json().data;
  const sample = { lead_id: 1, actor_user_id: ids['iv-admin'], old_owner_id: ids['iv-old'], new_owner_id: ids['iv-new'] };
  const requestFor = (enabled: boolean, channel_order: string[], recipient_strategy = 'new_owner') => ({ enabled, recipient_strategy, channel_order, config: current.config, expected_version: current.version });
  for (const enabled of [false, true]) {
    for (const channel_order of [[], ['mock', 'openclaw'], ['other']]) {
      const rule = requestFor(enabled, channel_order);
      const put = await app.inject({ method: 'PUT', url: '/api/admin/notification-rules/owner_changed', headers: { authorization: `Bearer ${adminToken}` }, payload: rule });
      const preview = await app.inject({ method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: { authorization: `Bearer ${adminToken}` }, payload: { rule, sample } });
      assert.equal(put.statusCode, 400); assert.equal(preview.statusCode, 400);
      assert.equal(put.json().data.error_code, preview.json().data.error_code);
      assert.notEqual(preview.json().data?.decision, 'pending');
    }
    const wrongRecipient = requestFor(enabled, ['mock'], 'reserved');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/notification-rules/owner_changed', headers: { authorization: `Bearer ${adminToken}` }, payload: wrongRecipient });
    const preview = await app.inject({ method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: { authorization: `Bearer ${adminToken}` }, payload: { rule: wrongRecipient, sample } });
    assert.equal(put.statusCode, 400); assert.equal(preview.statusCode, 400);
    assert.equal(put.json().data.error_code, 'CHANNEL_NOT_ALLOWED'); assert.equal(preview.json().data.error_code, 'CHANNEL_NOT_ALLOWED');
  }
  const memberPreview = await app.inject({ method: 'POST', url: '/api/admin/notification-rules/owner_changed/preview', headers: { authorization: `Bearer ${memberToken}` }, payload: { rule: requestFor(false, ['mock']), sample } });
  assert.equal(memberPreview.statusCode, 403);
  const unsupportedRule = requestFor(false, ['mock']);
  for (const request of [
    app.inject({ method: 'PUT', url: '/api/admin/notification-rules/visit_reminder', headers: { authorization: `Bearer ${adminToken}` }, payload: unsupportedRule }),
    app.inject({ method: 'POST', url: '/api/admin/notification-rules/visit_reminder/preview', headers: { authorization: `Bearer ${adminToken}` }, payload: { rule: unsupportedRule, sample } }),
  ]) {
    const response = await request;
    assert.equal(response.statusCode, 400); assert.equal(response.json().data.error_code, 'EVENT_NOT_IMPLEMENTED');
  }
});

test('成功投递也必须计入总尝试次数', () => {
  const id = makeLead('成功尝试计数');
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  db.prepare("UPDATE notification_rules SET enabled=1, channel_order_json='[\"mock\"]' WHERE event_type='owner_changed'").run();
  transferLeadOwner(db, { leadId: id, newOwnerId: ids['iv-new'], actorUserId: ids['iv-admin'], source: 'single_edit', operationId: 'independent-success-attempt', updatedAt: '2026-07-30 12:30:00' });
  const [task] = claimNotificationTasks(db, 'independent-worker', '2026-07-30 12:30:01');
  assert.ok(task);
  assert.equal(finishNotificationTask(db, task, { kind: 'sent', receipt: 'independent-receipt' }, '2026-07-30 12:30:02'), true);
  assert.equal((db.prepare('SELECT attempt_count FROM notification_logs WHERE id=?').get(task.id) as any).attempt_count, 1);
});

test('quiet hours 跨午夜时延后任务，preview 使用相同判定且不落库', async () => {
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  const config = {
    schema_version: 1,
    quiet_hours: { enabled: true, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' },
    max_attempts: 5,
    ttl_minutes: 1440,
  };
  db.prepare("UPDATE notification_rules SET enabled=1, channel_order_json='[\"mock\"]', config_json=? WHERE event_type='owner_changed'").run(JSON.stringify(config));
  const id = makeLead('跨午夜静默');
  transferLeadOwner(db, {
    leadId: id,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-quiet-hours',
    updatedAt: '2026-07-30 23:15:00',
  });
  assert.equal(
    (db.prepare('SELECT available_at FROM notification_logs WHERE lead_id=?').get(id) as any).available_at,
    '2026-07-31 08:00:00',
  );

  const before = (db.prepare('SELECT count(*) AS count FROM notification_logs').get() as any).count;
  const preview = await app.inject({
    method: 'POST',
    url: '/api/admin/notification-rules/owner_changed/preview',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      rule: { enabled: true, recipient_strategy: 'new_owner', channel_order: ['mock'], config, expected_version: 1 },
      sample: { lead_id: id, actor_user_id: ids['iv-admin'], old_owner_id: ids['iv-old'], new_owner_id: ids['iv-new'] },
      as_of: '2026-07-30 23:15:00',
    },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().data.available_at, '2026-07-31 08:00:00');
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs').get() as any).count, before);
});

test('幂等命中必须拒绝不可变事件字段不一致', () => {
  db.prepare("UPDATE notification_rules SET enabled=0 WHERE event_type='owner_changed'").run();
  const id = makeLead('幂等冲突');
  const event = {
    schemaVersion: 1 as const,
    eventType: 'owner_changed' as const,
    operationId: 'independent-dedupe-conflict',
    source: 'single_edit' as const,
    occurredAt: '2026-07-30 14:00:00',
    leadId: id,
    actorUserId: ids['iv-admin'],
    oldOwnerId: ids['iv-old'],
    newOwnerId: ids['iv-new'],
  };
  captureOwnerChanged(db, event);
  assert.throws(
    () => captureOwnerChanged(db, { ...event, actorUserId: ids['iv-member'] }),
    /NOTIFICATION_DEDUPE_CONFLICT/,
  );
  assert.equal((db.prepare('SELECT count(*) AS count FROM notification_logs WHERE operation_id=?').get(event.operationId) as any).count, 1);
});

test('Worker 发送前取消负责人已变化的任务，旧租约不能继续发送', () => {
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  db.prepare(`UPDATE notification_rules SET enabled=1,channel_order_json='["mock"]',
    config_json='{"schema_version":1,"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00","timezone":"Asia/Shanghai"},"max_attempts":5,"ttl_minutes":1440}'
    WHERE event_type='owner_changed'`).run();
  const id = makeLead('发送前负责人校验');
  transferLeadOwner(db, {
    leadId: id,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-pre-send-validation',
    updatedAt: '2026-07-30 15:00:00',
  });
  const task = claimNotificationTasks(db, 'pre-send-worker', '2026-07-30 15:00:01')
    .find((candidate) => candidate.operation_id === 'independent-pre-send-validation');
  assert.ok(task);
  db.prepare('UPDATE leads SET owner_id=? WHERE id=?').run(ids['iv-old'], id);
  assert.equal(validateClaimedNotificationTask(db, task, '2026-07-30 15:00:02'), 'cancelled');
  assert.deepEqual(
    { ...(db.prepare('SELECT status,cancellation_reason,lease_token FROM notification_logs WHERE id=?').get(task.id) as any) },
    { status: 'cancelled', cancellation_reason: 'owner_changed', lease_token: null },
  );
  assert.equal(finishNotificationTask(db, task, { kind: 'sent', receipt: 'must-not-win' }, '2026-07-30 15:00:03'), false);
});

test('Mock 七种模式保持确定性 receipt 与批准错误分类', async () => {
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  const signal = new AbortController().signal;
  const recipient = { userId: ids['iv-new'] };
  const message = { title: '测试', detailPath: '/pages/leads/detail?id=1' };
  const success = await new MockNotificationChannel('success').send(recipient, message, 'same-key', signal);
  const duplicate = await new MockNotificationChannel('duplicate').send(recipient, message, 'same-key', signal);
  assert.equal(success.providerMessageId, duplicate.providerMessageId);
  assert.equal(duplicate.deduplicated, true);
  await new MockNotificationChannel('delay').send(recipient, message, 'delay-key', signal);
  for (const [mode, code, permanent] of [
    ['timeout', 'timeout', false],
    ['rate_limit', 'rate_limit', false],
    ['temporary_5xx', 'temporary_5xx', false],
    ['permanent_config_error', 'invalid_channel_config', true],
  ] as const) {
    await assert.rejects(
      new MockNotificationChannel(mode).send(recipient, message, `${mode}-key`, signal),
      (error: any) => error.code === code && Boolean(error.permanent) === permanent,
    );
  }
});

test('Worker 启用时拒绝缺失或非绝对 DB_PATH，关闭时不打开数据库', async () => {
  const savedPath = process.env.DB_PATH;
  const savedWorker = process.env.NOTIFICATION_WORKER_ENABLED;
  process.env.NOTIFICATION_WORKER_ENABLED = 'true';
  delete process.env.DB_PATH;
  await assert.rejects(startWorker(), /DB_PATH.*绝对路径/);
  process.env.DB_PATH = 'relative-worker.db';
  await assert.rejects(startWorker(), /DB_PATH.*绝对路径/);
  process.env.NOTIFICATION_WORKER_ENABLED = 'false';
  await assert.doesNotReject(startWorker());
  process.env.DB_PATH = savedPath;
  process.env.NOTIFICATION_WORKER_ENABLED = savedWorker;
});

test('Worker 租约竞争、恢复、最多五次自动尝试和 180 天限批清理', () => {
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  db.prepare(`UPDATE notification_rules SET enabled=1,channel_order_json='["mock"]',
    config_json='{"schema_version":1,"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00","timezone":"Asia/Shanghai"},"max_attempts":5,"ttl_minutes":1440}'
    WHERE event_type='owner_changed'`).run();

  const leaseLead = makeLead('租约恢复');
  transferLeadOwner(db, {
    leadId: leaseLead,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-lease-recovery',
    updatedAt: '2026-07-30 16:00:00',
  });
  const firstLease = claimNotificationTasks(db, 'worker-a', '2026-07-30 16:00:01')
    .find((candidate) => candidate.operation_id === 'independent-lease-recovery');
  assert.ok(firstLease);
  assert.equal(claimNotificationTasks(db, 'worker-b', '2026-07-30 16:00:01').some((candidate) => candidate.id === firstLease.id), false);
  const recovered = claimNotificationTasks(db, 'worker-b', '2026-07-30 16:01:02')
    .find((candidate) => candidate.id === firstLease.id);
  assert.ok(recovered);
  assert.notEqual(recovered.lease_token, firstLease.lease_token);
  assert.equal(recovered.lease_recovery_count, 1);
  assert.equal(finishNotificationTask(db, firstLease, { kind: 'sent', receipt: 'stale' }, '2026-07-30 16:01:03'), false);
  assert.equal(finishNotificationTask(db, recovered, { kind: 'sent', receipt: 'lease-recovered' }, '2026-07-30 16:01:03'), true);

  const retryLead = makeLead('有限重试');
  transferLeadOwner(db, {
    leadId: retryLead,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-max-attempts',
    updatedAt: '2026-07-30 17:00:00',
  });
  let availableAt = '2026-07-30 17:00:01';
  let failedId = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const task = claimNotificationTasks(db, 'retry-worker', availableAt)
      .find((candidate) => candidate.operation_id === 'independent-max-attempts');
    assert.ok(task);
    failedId = task.id;
    assert.equal(finishNotificationTask(db, task, { kind: 'temporary', code: 'temporary_5xx', message: '模拟临时错误' }, availableAt), true);
    const row = db.prepare('SELECT status,automatic_attempt_count,available_at FROM notification_logs WHERE id=?').get(task.id) as any;
    assert.equal(row.automatic_attempt_count, attempt);
    assert.equal(row.status, attempt === 5 ? 'failed' : 'retry_wait');
    availableAt = row.available_at;
  }
  const failed = db.prepare('SELECT retain_until FROM notification_logs WHERE id=?').get(failedId) as any;
  assert.ok(failed.retain_until);
  assert.ok(cleanupNotificationRetention(db, '2027-01-28 17:00:02', 100) >= 1);
  assert.equal(db.prepare('SELECT id FROM notification_logs WHERE id=?').get(failedId), undefined);
});

test('管理日志分页筛选脱敏，failed 仅在条件恢复后允许一次人工重试', async () => {
  const manualRetryUpdatedAt = new Date(Date.now() - 2_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
  const manualRetryClaimedAt = new Date(Date.now() - 1_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
  const manualRetryFailedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  db.prepare(`UPDATE notification_rules SET enabled=1,channel_order_json='["mock"]',
    config_json='{"schema_version":1,"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00","timezone":"Asia/Shanghai"},"max_attempts":5,"ttl_minutes":1440}'
    WHERE event_type='owner_changed'`).run();
  const id = makeLead('人工重试');
  transferLeadOwner(db, {
    leadId: id,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-manual-retry',
    updatedAt: manualRetryUpdatedAt,
  });
  const task = claimNotificationTasks(db, 'manual-retry-worker', manualRetryClaimedAt)
    .find((candidate) => candidate.operation_id === 'independent-manual-retry');
  assert.ok(task);
  assert.equal(finishNotificationTask(db, task, { kind: 'permanent', code: 'invalid_channel_config', message: 'sensitive provider detail' }, manualRetryFailedAt), true);
  const failed = db.prepare('SELECT id,row_version FROM notification_logs WHERE id=?').get(task.id) as any;

  const list = await app.inject({
    method: 'GET',
    url: `/api/admin/notification-logs?page=1&pageSize=1&status=failed&lead_id=${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.total, 1);
  const summary = list.json().data.list[0];
  assert.equal(summary.id, task.id);
  assert.equal('last_error_message' in summary, false);
  assert.equal('message_snapshot_json' in summary, false);
  assert.equal('rule_snapshot_json' in summary, false);

  const detail = await app.inject({ method: 'GET', url: `/api/admin/notification-logs/${task.id}`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(detail.statusCode, 200);
  assert.equal('last_error_message' in detail.json().data, false);
  const invalidId = await app.inject({ method: 'GET', url: '/api/admin/notification-logs/not-a-number', headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(invalidId.statusCode, 400);
  assert.deepEqual(Object.keys(invalidId.json()).sort(), ['code', 'data', 'msg']);

  const memberRetry = await app.inject({ method: 'POST', url: `/api/admin/notification-logs/${task.id}/retry`, headers: { authorization: `Bearer ${memberToken}` }, payload: { expected_version: failed.row_version, reason: '不应允许' } });
  assert.equal(memberRetry.statusCode, 403);
  const retry = await app.inject({ method: 'POST', url: `/api/admin/notification-logs/${task.id}/retry`, headers: { authorization: `Bearer ${adminToken}` }, payload: { expected_version: failed.row_version, reason: '配置已修复' } });
  assert.equal(retry.statusCode, 200);
  const retried = db.prepare('SELECT status,manual_retry_count,management_audit_json,row_version FROM notification_logs WHERE id=?').get(task.id) as any;
  assert.equal(retried.status, 'pending');
  assert.equal(retried.manual_retry_count, 1);
  assert.equal(JSON.parse(retried.management_audit_json)[0].reason, '配置已修复');
  const duplicateRetry = await app.inject({ method: 'POST', url: `/api/admin/notification-logs/${task.id}/retry`, headers: { authorization: `Bearer ${adminToken}` }, payload: { expected_version: retried.row_version, reason: '重复' } });
  assert.equal(duplicateRetry.statusCode, 409);
});

test('Worker 关闭保留 pending，空 Scheduler dry-run 只生成受限选项', async () => {
  process.env.NOTIFICATION_WORKER_ENABLED = 'false';
  const id = makeLead('Worker关闭保留');
  transferLeadOwner(db, {
    leadId: id,
    newOwnerId: ids['iv-new'],
    actorUserId: ids['iv-admin'],
    source: 'single_edit',
    operationId: 'independent-worker-disabled',
    updatedAt: '2026-07-30 18:00:00',
  });
  await runOnce();
  assert.equal((db.prepare('SELECT status FROM notification_logs WHERE operation_id=?').get('independent-worker-disabled') as any).status, 'pending');
  assert.deepEqual(schedulerRegistry, []);
  const before = Date.now();
  const options = schedulerDryRunOptions({ as_of: '2026-07-30T18:00:00+08:00', limit: 5000, deadline_ms: 60_000 });
  assert.equal(options.asOf, '2026-07-30T18:00:00+08:00');
  assert.equal(options.limit, 1000);
  assert.equal(options.dryRun, true);
  assert.ok(options.deadlineAt >= before + 30_000 && options.deadlineAt <= Date.now() + 30_000);
});

test('五个阶段三开关默认关闭且拒绝非法值', () => {
  const keys = ['LEAD_POOL_CLAIM_ENABLED', 'NOTIFICATION_CAPTURE_ENABLED', 'NOTIFICATION_WORKER_ENABLED', 'NOTIFICATION_MOCK_ENABLED', 'NOTIFICATION_SCHEDULER_ENABLED'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  assert.deepEqual(resolveNotificationConfig(), { leadPoolClaimEnabled: false, captureEnabled: false, workerEnabled: false, mockEnabled: false, schedulerEnabled: false, openclawEnabled: false, openclawGatewaySendTimeoutMs: 30000, openclawGatewayTimeoutMs: 40000, openclawMaxAttempts: 2 });
  for (const key of keys) {
    process.env[key] = 'invalid';
    assert.throws(() => resolveNotificationConfig(), new RegExp(`${key}.*true.*false`));
    delete process.env[key];
  }
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('已过期 sending 任务必须立即取消，不能等待租约到期', () => {
  const id = makeLead('sending TTL');
  const newOwner = ids['iv-new'];
  db.prepare(`INSERT INTO notification_logs (event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,lease_token,lease_owner,lease_until,expires_at)
    VALUES ('owner_changed','single_edit','sending-expired','lead',?,?,?,?,?,?,?,?,?,1,'{}','["mock"]','mock','{}','sending',5,?,'token','worker','2026-07-30 13:00:00','2026-07-30 12:00:00')`).run(id, id, ids['iv-admin'], ids['iv-old'], newOwner, newOwner, '2026-07-30 11:00:00', 'sending-expired-dedupe', 'sending-expired-delivery', '2026-07-30 11:00:00');
  maintainNotificationQueue(db, '2026-07-30 12:01:00');
  const task = db.prepare("SELECT status,cancellation_reason FROM notification_logs WHERE dedupe_key='sending-expired-dedupe'").get() as any;
  assert.deepEqual({ ...task }, { status: 'cancelled', cancellation_reason: 'task_expired' });
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});
