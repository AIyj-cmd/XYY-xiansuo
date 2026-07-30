import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-business-consistency-'));
process.env.JWT_SECRET = 'business-consistency-test-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.NODE_ENV = 'test';
process.env.POOL_IDLE_DAYS = '7';

const { closeDb, getDb, initDb, MIGRATIONS, runMigrations, configureConnection } = await import('../src/db.js');
const { signToken } = await import('../src/utils/jwt.js');
const { leadRoutes } = await import('../src/routes/leads.js');
const { DatabaseSync } = await import('node:sqlite');

initDb();
const db = getDb();
db.prepare(`
  INSERT INTO users (username, name, password_hash, role, is_active) VALUES
  ('admin', '管理员', 'hash', 'admin', 1),
  ('member', '业务员', 'hash', 'member', 1),
  ('target', '目标负责人', 'hash', 'member', 1),
  ('disabled', '已停用负责人', 'hash', 'member', 0)
`).run();
const users = Object.fromEntries((db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>)
  .map((row) => [row.username, row.id])) as Record<string, number>;
const adminToken = await signToken({ id: users.admin });
const memberToken = await signToken({ id: users.member });
const targetToken = await signToken({ id: users.target });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const app = Fastify();
await app.register(leadRoutes);
await app.ready();

function insertLead(contactName: string, ownerId = users.member, createdAt = '2026-01-01 09:00:00'): number {
  return Number(db.prepare(`
    INSERT INTO leads (contact_name, source, status, owner_id, lead_date, created_by, created_at)
    VALUES (?, '官网', '跟进中', ?, '2026-01-01', ?, ?)
  `).run(contactName, ownerId, users.admin, createdAt).lastInsertRowid);
}

test('创建线索在服务端限制 member 负责人并拒绝停用负责人', async () => {
  const common = { contact_name: '创建校验', wechat: 'create-owner-check', source: '官网', lead_date: '2026-01-01' };
  const forged = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(memberToken), payload: { ...common, owner_id: users.target } });
  assert.equal(forged.statusCode, 403);
  const self = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(memberToken), payload: { ...common, wechat: 'create-self' } });
  assert.equal(self.statusCode, 200);
  const selfLead = db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(self.json().data.id) as { owner_id: number };
  assert.equal(selfLead.owner_id, users.member);
  const adminAssigned = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(adminToken), payload: { ...common, wechat: 'create-admin', owner_id: users.target } });
  assert.equal(adminAssigned.statusCode, 200);
  const disabled = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(adminToken), payload: { ...common, wechat: 'create-disabled', owner_id: users.disabled } });
  assert.equal(disabled.statusCode, 400);
});

test('单条和批量负责人变更使用来源、批次号、真实旧值，并保持全有或全无', async () => {
  const first = insertLead('单条转移');
  const single = await app.inject({ method: 'PATCH', url: `/api/leads/${first}`, headers: bearer(memberToken), payload: { owner_id: users.target } });
  assert.equal(single.statusCode, 200);
  const singleLog = db.prepare('SELECT old_val, new_val, source, operation_id FROM audit_logs WHERE lead_id = ? AND action = ?').get(first, 'transfer') as any;
  assert.deepEqual({ old: singleLog.old_val, next: singleLog.new_val, source: singleLog.source }, { old: String(users.member), next: String(users.target), source: 'single_edit' });
  assert.ok(singleLog.operation_id);
  const sameOwner = await app.inject({ method: 'PATCH', url: `/api/leads/${first}`, headers: bearer(targetToken), payload: { owner_id: users.target } });
  assert.equal(sameOwner.statusCode, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE lead_id = ? AND action = 'transfer'").get(first) as { count: number }).count, 1);

  const second = insertLead('批量一');
  const third = insertLead('批量二');
  const batch = await app.inject({ method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken), payload: { ids: [second, third, second], action: 'transfer', owner_id: users.target } });
  assert.equal(batch.statusCode, 200);
  const batchLogs = db.prepare("SELECT lead_id, old_val, new_val, source, operation_id FROM audit_logs WHERE source = 'batch_transfer' ORDER BY lead_id").all() as any[];
  assert.equal(batchLogs.length, 2);
  assert.equal(batchLogs[0].operation_id, batchLogs[1].operation_id);
  assert.deepEqual(batchLogs.map((row) => row.old_val), [String(users.member), String(users.member)]);
  assert.ok(batchLogs.every((row) => row.new_val === String(users.target)));

  const inactiveTargetLead = insertLead('停用负责人批量校验');
  const inactiveTarget = await app.inject({ method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken), payload: { ids: [inactiveTargetLead], action: 'transfer', owner_id: users.disabled } });
  assert.equal(inactiveTarget.statusCode, 400);
  assert.equal((db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(inactiveTargetLead) as { owner_id: number }).owner_id, users.member);

  const rollbackOne = insertLead('回滚一');
  const rollbackTwo = insertLead('回滚二');
  db.exec(`CREATE TRIGGER block_second_transfer BEFORE INSERT ON audit_logs
    WHEN NEW.lead_id = ${rollbackTwo} AND NEW.action = 'transfer'
    BEGIN SELECT RAISE(ABORT, 'force batch rollback'); END;`);
  const failed = await app.inject({ method: 'POST', url: '/api/leads/batch', headers: bearer(adminToken), payload: { ids: [rollbackOne, rollbackTwo], action: 'transfer', owner_id: users.target } });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(
    (db.prepare('SELECT id, owner_id FROM leads WHERE id IN (?, ?) ORDER BY id').all(rollbackOne, rollbackTwo) as any[]).map((row) => ({ ...row })),
    [{ id: rollbackOne, owner_id: users.member }, { id: rollbackTwo, owner_id: users.member }],
  );
  db.exec('DROP TRIGGER block_second_transfer;');
});

test('公海重复认领不重复审计，且只能记录首次真实负责人变化', async () => {
  const pooled = insertLead('公海线索', users.member, '2026-01-01 09:00:00');
  db.prepare('UPDATE leads SET last_follow_at = ? WHERE id = ?').run('2026-01-01 09:00:00', pooled);
  const claimed = await app.inject({ method: 'POST', url: `/api/pool/${pooled}/claim`, headers: bearer(targetToken) });
  assert.equal(claimed.statusCode, 200);
  const duplicate = await app.inject({ method: 'POST', url: `/api/pool/${pooled}/claim`, headers: bearer(targetToken) });
  assert.equal(duplicate.statusCode, 400);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE lead_id = ? AND source = 'pool_claim'").get(pooled) as { count: number }).count, 1);
});

test('跟进编辑和删除以 created_at DESC、id DESC 重算，删除最后一条按方案 B 清空', async () => {
  const leadId = insertLead('跟进重算');
  const timestamp = '2026-05-01 10:00:00';
  const first = Number(db.prepare(`INSERT INTO follow_ups (lead_id, user_id, type, content, next_follow_at, created_at)
    VALUES (?, ?, '电话', '较早 ID', '2026-05-02', ?)`).run(leadId, users.member, timestamp).lastInsertRowid);
  const latest = Number(db.prepare(`INSERT INTO follow_ups (lead_id, user_id, type, content, next_follow_at, created_at)
    VALUES (?, ?, '微信', '较大 ID', '2026-05-03', ?)`).run(leadId, users.member, timestamp).lastInsertRowid);
  const recompute = await app.inject({ method: 'PATCH', url: `/api/follow-ups/${latest}`, headers: bearer(memberToken), payload: { content: '最新跟进已编辑' } });
  assert.equal(recompute.statusCode, 200);
  let lead = db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as any;
  assert.deepEqual({ ...lead }, { last_follow_at: timestamp, next_follow_at: '2026-05-03', next_follow_at_source: 'follow_up' });
  const timeline = await app.inject({ method: 'GET', url: `/api/leads/${leadId}/follow-ups`, headers: bearer(memberToken) });
  assert.deepEqual(timeline.json().data.map((row: { id: number }) => row.id), [latest, first]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/follow-ups/${latest}`, headers: bearer(memberToken) })).statusCode, 200);
  lead = db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as any;
  assert.deepEqual({ ...lead }, { last_follow_at: timestamp, next_follow_at: '2026-05-02', next_follow_at_source: 'follow_up' });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/follow-ups/${first}`, headers: bearer(memberToken) })).statusCode, 200);
  lead = db.prepare('SELECT last_follow_at, next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as any;
  assert.deepEqual({ ...lead }, { last_follow_at: null, next_follow_at: null, next_follow_at_source: null });
});

test('003 回填来源并保留 001、002 已发布校验和，前端不再有邮件跟进', () => {
  assert.equal(MIGRATIONS[0].checksum, 'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0');
  assert.equal(MIGRATIONS[1].checksum, 'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9');
  const legacy = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  configureConnection(legacy);
  runMigrations(legacy, MIGRATIONS.slice(0, 2));
  legacy.prepare("INSERT INTO users (username, name, password_hash) VALUES ('legacy', '旧用户', 'hash')").run();
  const leadId = Number(legacy.prepare("INSERT INTO leads (contact_name, source, lead_date, next_follow_at) VALUES ('旧客户', '官网', '2026-01-01', '2026-01-02')").run().lastInsertRowid);
  legacy.prepare("INSERT INTO follow_ups (lead_id, user_id, content, next_follow_at, created_at) VALUES (?, 1, '旧跟进', '2026-01-03', '2026-01-01 10:00:00')").run(leadId);
  runMigrations(legacy, [MIGRATIONS[2]]);
  assert.deepEqual({ ...(legacy.prepare('SELECT next_follow_at, next_follow_at_source FROM leads WHERE id = ?').get(leadId) as object) }, { next_follow_at: '2026-01-03', next_follow_at_source: 'follow_up' });
  assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
  legacy.close();
  const frontEnd = readFileSync(path.resolve(process.cwd(), '../app/src/pages/leads/list.vue'), 'utf8');
  assert.ok(!frontEnd.includes("'邮件'"));
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
