import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import { DatabaseSync } from 'node:sqlite';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-phase2-independent-'));
process.env.JWT_SECRET = 'phase-two-independent-verifier-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.NODE_ENV = 'test';
process.env.POOL_IDLE_DAYS = '7';
process.env.LEAD_POOL_CLAIM_ENABLED = 'true';

const { closeDb, configureConnection, getDb, initDb, MIGRATIONS, runMigrations } = await import('../src/db.js');
const { signToken } = await import('../src/utils/jwt.js');
const { leadRoutes } = await import('../src/routes/leads.js');
const { importExportRoutes } = await import('../src/routes/import_export.js');
const { buildApp } = await import('../src/index.js');

initDb();
const db = getDb();
db.prepare(`
  INSERT INTO users (username, name, password_hash, role, is_active) VALUES
    ('phase2-admin', '阶段二管理员', 'hash', 'admin', 1),
    ('phase2-member', '阶段二成员', 'hash', 'member', 1),
    ('phase2-target', '阶段二目标', 'hash', 'member', 1),
    ('phase2-disabled', '阶段二停用', 'hash', 'member', 0),
    ('phase2-outsider', '阶段二他人', 'hash', 'member', 1)
`).run();

const users = Object.fromEntries((db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>)
  .map((row) => [row.username, row.id])) as Record<string, number>;
const adminToken = await signToken({ id: users['phase2-admin'] });
const memberToken = await signToken({ id: users['phase2-member'] });
const targetToken = await signToken({ id: users['phase2-target'] });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const app = Fastify();
app.setErrorHandler((_error, _request, reply) => {
  reply.code(500).send({ code: 1, msg: '服务器内部错误', data: null });
});
await app.register(multipart);
await app.register(leadRoutes);
await app.register(importExportRoutes);
await app.ready();
let directAppClosed = false;

function insertLead(contactName: string, ownerId = users['phase2-member'], createdAt = '2026-01-01 00:00:00'): number {
  return Number(db.prepare(`
    INSERT INTO leads (contact_name, source, status, owner_id, lead_date, created_by, created_at)
    VALUES (?, '独立测试', '跟进中', ?, '2026-01-01', ?, ?)
  `).run(contactName, ownerId, users['phase2-admin'], createdAt).lastInsertRowid);
}

function assertEnvelope(response: { json: () => { code: number; msg: string; data: unknown } }): void {
  const body = response.json();
  assert.equal(typeof body.code, 'number');
  assert.equal(typeof body.msg, 'string');
  assert.ok(Object.hasOwn(body, 'data'));
}

function multipartFile(filename: string, contentType: string, body: Buffer): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----xiansuo-phase2-independent-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test('负责人入口以服务端实时授权和启用状态为准，且保持响应包络', async () => {
  const common = { contact_name: '独立创建', source: '独立测试', lead_date: '2026-01-01', wechat: 'independent-owner-check' };
  const forged = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(memberToken), payload: { ...common, owner_id: users['phase2-target'] } });
  assert.equal(forged.statusCode, 403);
  assertEnvelope(forged);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leads WHERE wechat = 'independent-owner-check'").get() as { count: number }).count, 0);

  const invalidOwner = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(adminToken), payload: { ...common, wechat: 'independent-invalid-owner', owner_id: 999999 } });
  assert.equal(invalidOwner.statusCode, 400);
  assertEnvelope(invalidOwner);
  const disabledOwner = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(adminToken), payload: { ...common, wechat: 'independent-disabled-owner', owner_id: users['phase2-disabled'] } });
  assert.equal(disabledOwner.statusCode, 400);
  assertEnvelope(disabledOwner);

  const self = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(memberToken), payload: { ...common, wechat: 'independent-self-owner', owner_id: users['phase2-member'] } });
  assert.equal(self.statusCode, 200);
  assertEnvelope(self);
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(self.json().data.id) as { owner_id: number }).owner_id, users['phase2-member']);
});

test('批量负责人转移去重且在越权、缺失和审计故障时完全回滚', async () => {
  const owned = insertLead('批量独立一');
  const alsoOwned = insertLead('批量独立二');
  const other = insertLead('批量他人', users['phase2-outsider']);

  const unauthorized = await app.inject({
    method: 'POST', url: '/api/leads/batch', headers: bearer(memberToken),
    payload: { ids: [owned, other], action: 'transfer', owner_id: users['phase2-target'] },
  });
  assert.equal(unauthorized.statusCode, 403);
  assertEnvelope(unauthorized);
  assert.deepEqual(
    (db.prepare('SELECT id, owner_id FROM leads WHERE id IN (?, ?) ORDER BY id').all(owned, other) as object[]).map((row) => ({ ...row })),
    [{ id: owned, owner_id: users['phase2-member'] }, { id: other, owner_id: users['phase2-outsider'] }],
  );

  const missing = await app.inject({
    method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken),
    payload: { ids: [owned, 999999], action: 'transfer', owner_id: users['phase2-target'] },
  });
  assert.equal(missing.statusCode, 404);
  assertEnvelope(missing);
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(owned) as { owner_id: number }).owner_id, users['phase2-member']);

  db.exec(`CREATE TRIGGER phase2_block_second_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'transfer' AND NEW.lead_id = ${alsoOwned}
    BEGIN SELECT RAISE(ABORT, 'independent audit failure'); END;`);
  const failed = await app.inject({
    method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken),
    payload: { ids: [owned, alsoOwned, owned], action: 'transfer', owner_id: users['phase2-target'] },
  });
  assert.equal(failed.statusCode, 500);
  assertEnvelope(failed);
  assert.deepEqual(
    (db.prepare('SELECT id, owner_id FROM leads WHERE id IN (?, ?) ORDER BY id').all(owned, alsoOwned) as object[]).map((row) => ({ ...row })),
    [{ id: owned, owner_id: users['phase2-member'] }, { id: alsoOwned, owner_id: users['phase2-member'] }],
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE lead_id IN (?, ?) AND action = 'transfer'").get(owned, alsoOwned) as { count: number }).count, 0);
  db.exec('DROP TRIGGER phase2_block_second_audit;');

  const successful = await app.inject({
    method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken),
    payload: { ids: [owned, alsoOwned, owned], action: 'transfer', owner_id: users['phase2-target'] },
  });
  assert.equal(successful.statusCode, 200);
  assertEnvelope(successful);
  const logs = db.prepare("SELECT lead_id, old_val, new_val, source, operation_id FROM audit_logs WHERE lead_id IN (?, ?) AND action = 'transfer' ORDER BY lead_id").all(owned, alsoOwned) as Array<Record<string, string>>;
  assert.equal(logs.length, 2);
  assert.ok(logs.every((row) => row.source === 'batch_transfer' && row.old_val === String(users['phase2-member']) && row.new_val === String(users['phase2-target'])));
  assert.ok(logs[0].operation_id && logs[0].operation_id === logs[1].operation_id);
});

test('公海并发式重复认领只有一次真实转移审计', async () => {
  const leadId = insertLead('独立公海', users['phase2-member'], '2026-01-01 00:00:00');
  db.prepare('UPDATE leads SET last_follow_at = ? WHERE id = ?').run('2026-01-01 00:00:00', leadId);
  const [first, second] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/pool/${leadId}/claim`, headers: bearer(targetToken) }),
    app.inject({ method: 'POST', url: `/api/pool/${leadId}/claim`, headers: bearer(targetToken) }),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 400]);
  assertEnvelope(first);
  assertEnvelope(second);
  const logs = (db.prepare("SELECT old_val, new_val, source FROM audit_logs WHERE lead_id = ? AND action = 'transfer'").all(leadId) as Array<Record<string, string>>)
    .map((row) => ({ ...row }));
  assert.deepEqual(logs, [{ old_val: String(users['phase2-member']), new_val: String(users['phase2-target']), source: 'pool_claim' }]);
});

test('跟进创建、编辑、删除及导入使用同一派生规则；删除最后一条按方案 B 清空', async () => {
  const leadId = insertLead('独立跟进');
  const created = await app.inject({
    method: 'POST', url: `/api/leads/${leadId}/follow-ups`, headers: bearer(memberToken),
    payload: { type: '电话', content: '第一条', status: '跟进中', next_follow_at: '2026-08-01' },
  });
  assert.equal(created.statusCode, 200);
  assertEnvelope(created);
  const firstFollowId = Number(created.json().data.id);
  const afterCreate = db.prepare('SELECT created_at FROM follow_ups WHERE id = ?').get(firstFollowId) as { created_at: string };
  assert.deepEqual(
    { ...(db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as object) },
    { last_follow_at: afterCreate.created_at, next_follow_at: '2026-08-01', next_follow_at_source: 'follow_up' },
  );

  const timestamp = '2026-09-01 09:00:00';
  const lowerId = Number(db.prepare("INSERT INTO follow_ups (lead_id, user_id, type, content, next_follow_at, created_at) VALUES (?, ?, '电话', 'same-time-low', '2026-09-02', ?)")
    .run(leadId, users['phase2-member'], timestamp).lastInsertRowid);
  const higherId = Number(db.prepare("INSERT INTO follow_ups (lead_id, user_id, type, content, next_follow_at, created_at) VALUES (?, ?, '微信', 'same-time-high', '2026-09-03', ?)")
    .run(leadId, users['phase2-member'], timestamp).lastInsertRowid);
  const recompute = await app.inject({ method: 'PATCH', url: `/api/follow-ups/${higherId}`, headers: bearer(memberToken), payload: { content: '修改最新记录' } });
  assert.equal(recompute.statusCode, 200);
  assert.deepEqual(
    { ...(db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as object) },
    { last_follow_at: timestamp, next_follow_at: '2026-09-03', next_follow_at_source: 'follow_up' },
  );
  const timeline = await app.inject({ method: 'GET', url: `/api/leads/${leadId}/follow-ups`, headers: bearer(memberToken) });
  assert.deepEqual(timeline.json().data.slice(0, 2).map((row: { id: number }) => row.id), [higherId, lowerId]);

  for (const followUpId of [higherId, lowerId, firstFollowId]) {
    const deleted = await app.inject({ method: 'DELETE', url: `/api/follow-ups/${followUpId}`, headers: bearer(memberToken) });
    assert.equal(deleted.statusCode, 200);
    assertEnvelope(deleted);
  }
  assert.deepEqual(
    { ...(db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as object) },
    { last_follow_at: null, next_follow_at: null, next_follow_at_source: null },
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('导入');
  sheet.addRow(['序号', '年份', '月份', '线索日期', '跟进人', '线索来源', '跟进情况', '行业类型', '联系人', '手机', '微信号', '跟进记录', '跟进状态']);
  sheet.addRow([1, 2026, 1, '1月10', '阶段二停用', '独立导入', '已处理', '行业', '导入派生客户', '', 'phase2-import-wx', '导入历史跟进', '跟进中']);
  const upload = multipartFile('phase2-import.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(await workbook.xlsx.writeBuffer()));
  const imported = await app.inject({ method: 'POST', url: '/api/import', headers: { ...bearer(adminToken), ...upload.headers }, payload: upload.payload });
  assert.equal(imported.statusCode, 200);
  assertEnvelope(imported);
  assert.equal(imported.json().data.warnings, 1);
  const importedLead = db.prepare("SELECT id, owner_id, last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE wechat = 'phase2-import-wx'").get() as Record<string, unknown>;
  assert.deepEqual({ ...importedLead }, {
    id: importedLead.id,
    owner_id: users['phase2-admin'],
    last_follow_at: '2026-01-10 00:00:00',
    next_follow_at: null,
    next_follow_at_source: 'follow_up',
  });
});

test('004 可重复执行且不改变既有 001/002/003 checksum、完整性或禁止对象边界', () => {
  assert.deepEqual(MIGRATIONS.map((migration) => migration.version), ['001', '002', '003', '004']);
  assert.equal(MIGRATIONS[0].checksum, 'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0');
  assert.equal(MIGRATIONS[1].checksum, 'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9');
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  configureConnection(database);
  runMigrations(database);
  runMigrations(database);
  assert.deepEqual((database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>).map((row) => row.version), ['001', '002', '003', '004']);
  assert.deepEqual((database.prepare('PRAGMA integrity_check').all() as object[]).map((row) => ({ ...row })), [{ integrity_check: 'ok' }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const forbidden of ['wechat_bindings', 'visit_plans', 'ai_analysis_logs', 'ai_permissions']) {
    assert.ok(!tables.includes(forbidden), `unexpected stage-two table: ${forbidden}`);
  }
  const leadColumns = (database.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(!leadColumns.includes('sales_stage'));
  database.close();
});

test('完整应用的事务异常仍保持既有响应包络', { concurrency: false }, async () => {
  await app.close();
  directAppClosed = true;
  closeDb();
  process.env.DB_PATH = path.join(testDirectory, 'full-app-envelope.db');
  process.env.ADMIN_INITIAL_PASSWORD = 'phase-two-full-app-password';
  const fullApp = await buildApp();
  const fullDb = getDb();
  fullDb.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('full-member', '全应用成员', 'hash', 'member'), ('full-target', '全应用目标', 'hash', 'member')").run();
  const member = fullDb.prepare("SELECT id FROM users WHERE username = 'full-member'").get() as { id: number };
  const target = fullDb.prepare("SELECT id FROM users WHERE username = 'full-target'").get() as { id: number };
  const lead = fullDb.prepare("INSERT INTO leads (contact_name, source, owner_id, lead_date, created_by) VALUES ('全应用包络', '独立测试', ?, '2026-01-01', 1)").run(member.id);
  fullDb.exec(`CREATE TRIGGER phase2_full_app_error BEFORE INSERT ON audit_logs
    WHEN NEW.lead_id = ${lead.lastInsertRowid} AND NEW.action = 'transfer'
    BEGIN SELECT RAISE(ABORT, 'forced full application failure'); END;`);
  const token = await signToken({ id: member.id });
  const response = await fullApp.inject({
    method: 'PATCH', url: `/api/leads/${lead.lastInsertRowid}`,
    headers: bearer(token), payload: { owner_id: target.id },
  });
  assert.equal(response.statusCode, 500);
  assertEnvelope(response);
  assert.equal((fullDb.prepare('SELECT owner_id FROM leads WHERE id = ?').get(lead.lastInsertRowid) as { owner_id: number }).owner_id, member.id);
  await fullApp.close();
  closeDb();
});

test.after(async () => {
  if (!directAppClosed) await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
