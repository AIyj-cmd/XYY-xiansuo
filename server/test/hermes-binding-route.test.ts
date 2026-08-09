import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-hermes-remove-route-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'hermes-remove-route-test-secret-at-least-32';
process.env.DB_PATH = path.join(directory, 'route.sqlite');
process.env.HERMES_BINDING_ENABLED = 'false';

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { hermesBindingRoutes } = await import('../src/routes/hermes-bindings.js');
const { signToken } = await import('../src/utils/jwt.js');

test('DELETE /api/hermes-binding 仅解绑 JWT 本人，管理器失败不回滚已提交数据库', { concurrency: false }, async () => {
  initDb(); const db = getDb();
  db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('remove-route-a','用户甲','x'),('remove-route-b','用户乙','x'),('remove-route-c','用户丙','x')").run();
  const refs = ['hr_aaaaaaaaaaaaaaaaaaaa', 'hr_bbbbbbbbbbbbbbbbbbbb'];
  db.prepare(`INSERT INTO hermes_bindings(user_id,status,generation,account_ref,target_fingerprint,peer_fingerprint,active_activation_id_hash,updated_at)
    VALUES (1,'active',1,?,?,?,?,'2026-08-09 09:00:00'),(2,'active',1,?,?,?,?,'2026-08-09 09:00:00')`).run(refs[0], 'a'.repeat(64), 'b'.repeat(64), 'e'.repeat(64), refs[1], 'c'.repeat(64), 'd'.repeat(64), 'f'.repeat(64));
  const app = Fastify(); await app.register(hermesBindingRoutes); await app.ready();
  const a = await signToken({ id: 1 }); const b = await signToken({ id: 2 }); const c = await signToken({ id: 3 });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/hermes-binding' })).statusCode, 401);
  const response = await app.inject({ method: 'DELETE', url: '/api/hermes-binding', headers: { authorization: `Bearer ${a}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { status: 'unbound' });
  assert.deepEqual(Object.keys(response.json().data), ['status']);
  assert.equal(JSON.stringify(response.json()).includes(refs[0]), false);
  assert.equal((db.prepare('SELECT status FROM hermes_bindings WHERE user_id=1').get() as { status: string }).status, 'unbound');
  const repeated = await app.inject({ method: 'DELETE', url: '/api/hermes-binding', headers: { authorization: `Bearer ${a}` } });
  assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.json().data, { status: 'unbound' });
  db.prepare("UPDATE hermes_bindings SET status='disabled' WHERE user_id=2").run(); const disabledBefore = db.prepare('SELECT * FROM hermes_bindings WHERE user_id=2').get();
  const disabled = await app.inject({ method: 'DELETE', url: '/api/hermes-binding', headers: { authorization: `Bearer ${b}` } });
  assert.equal(disabled.statusCode, 409); assert.deepEqual(db.prepare('SELECT * FROM hermes_bindings WHERE user_id=2').get(), disabledBefore); assert.equal((db.prepare('SELECT status FROM hermes_bindings WHERE user_id=2').get() as { status: string }).status, 'disabled');
  assert.equal((await app.inject({ method: 'GET', url: '/api/hermes-binding', headers: { authorization: `Bearer ${b}` } })).json().data.status, 'disabled');
  const absent = await app.inject({ method: 'DELETE', url: '/api/hermes-binding', headers: { authorization: `Bearer ${c}` } });
  assert.equal(absent.statusCode, 200); assert.deepEqual(absent.json().data, { status: 'unbound' }); assert.equal((db.prepare('SELECT COUNT(*) AS count FROM hermes_bindings WHERE user_id=3').get() as { count: number }).count, 0);
  await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true });
});
