import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-pool-'));
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-bytes-long';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.POOL_IDLE_DAYS = '7';

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { signToken } = await import('../src/utils/jwt.js');
const { leadRoutes } = await import('../src/routes/leads.js');

initDb();
const db = getDb();
db.prepare(`
  INSERT INTO users (username, name, password_hash, role)
  VALUES ('owner', '原负责人', 'test$hash', 'member'),
         ('claimer', '认领人', 'test$hash', 'member')
`).run();
const owner = db.prepare("SELECT id FROM users WHERE username = 'owner'").get() as { id: number };
const claimer = db.prepare("SELECT id FROM users WHERE username = 'claimer'").get() as { id: number };

const oldLead = db.prepare(`
  INSERT INTO leads (
    contact_name, source, status, owner_id, lead_date, created_by, created_at, last_follow_at
  ) VALUES ('旧线索', '官网', '跟进中', ?, '2026-07-01', ?, '2026-07-01 09:00:00', '2026-07-01 09:00:00')
`).run(owner.id, owner.id);
const recentLead = db.prepare(`
  INSERT INTO leads (
    contact_name, source, status, owner_id, lead_date, created_by, created_at, last_follow_at
  ) VALUES ('新线索', '官网', '跟进中', ?, date('now','localtime'), ?, datetime('now','localtime'), datetime('now','localtime'))
`).run(owner.id, owner.id);

const token = await signToken({
  id: claimer.id,
  username: 'claimer',
  name: '认领人',
  role: 'member',
});
const app = Fastify();
await app.register(leadRoutes);
await app.ready();

test('公海接口只返回达到未跟进阈值的线索', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/pool?days=7',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.data.minimum_days, 7);
  assert.equal(body.data.threshold_days, 7);
  assert.equal(body.data.total, 1);
  assert.equal(body.data.list[0].id, Number(oldLead.lastInsertRowid));
});

test('符合条件的公海线索可认领且负责人会更新', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/pool/${oldLead.lastInsertRowid}/claim`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const updated = db.prepare('SELECT owner_id FROM leads WHERE id = ?')
    .get(oldLead.lastInsertRowid) as { owner_id: number };
  assert.equal(updated.owner_id, claimer.id);
});

test('未达到阈值的线索不能绕过列表直接认领', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/pool/${recentLead.lastInsertRowid}/claim`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 409);
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
