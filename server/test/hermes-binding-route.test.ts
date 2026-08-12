import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-hermes-remove-route-'));
const internalFile = path.join(directory, 'internal.secret'); const managerFile = path.join(directory, 'manager.secret');
writeFileSync(internalFile, `${'i'.repeat(32)}\n`, { mode: 0o600 }); writeFileSync(managerFile, `${'m'.repeat(32)}\n`, { mode: 0o600 }); chmodSync(internalFile, 0o600); chmodSync(managerFile, 0o600);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'hermes-remove-route-test-secret-at-least-32';
process.env.DB_PATH = path.join(directory, 'route.sqlite');
process.env.HERMES_BINDING_ENABLED = 'true';
process.env.HERMES_INTERNAL_SECRET_FILE = internalFile;
process.env.HERMES_ACCOUNT_MANAGER_URL = 'http://127.0.0.1:38999';
process.env.HERMES_ACCOUNT_MANAGER_SECRET_FILE = managerFile;

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { hermesBindingRoutes } = await import('../src/routes/hermes-bindings.js');
const { signToken } = await import('../src/utils/jwt.js');

test('DELETE /api/hermes-binding 仅解绑 JWT 本人，管理器失败不回滚已提交数据库；关闭态先于 DB/manager fail-closed', { concurrency: false }, async () => {
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
  assert.equal((await app.inject({ method: 'GET', url: '/api/hermes-binding', headers: { authorization: `Bearer ${b}` } })).json().data.enabled, true);

  process.env.HERMES_BINDING_ENABLED = 'false';
  const beforeDisabled = JSON.stringify({ bindings: db.prepare('SELECT * FROM hermes_bindings ORDER BY user_id').all(), attempts: db.prepare('SELECT * FROM hermes_login_attempts ORDER BY id').all() });
  const disabledGet = await app.inject({ method: 'GET', url: '/api/hermes-binding', headers: { authorization: `Bearer ${b}` } });
  assert.deepEqual(disabledGet.json().data, { status: 'disabled', generation: 0, mode: 'per_user_qr', enabled: false });
  assert.equal(disabledGet.headers['cache-control'], 'no-store');
  for (const request of [
    { method: 'POST' as const, url: '/api/hermes-binding/code' },
    { method: 'DELETE' as const, url: '/api/hermes-binding' },
    { method: 'POST' as const, url: '/api/hermes-binding/qr-attempts' },
    { method: 'GET' as const, url: '/api/hermes-binding/qr-attempts/not-a-uuid' },
    { method: 'DELETE' as const, url: '/api/hermes-binding/qr-attempts/not-a-uuid' },
  ]) assert.equal((await app.inject({ ...request, headers: { authorization: `Bearer ${b}` } })).statusCode, 409);
  assert.equal(JSON.stringify({ bindings: db.prepare('SELECT * FROM hermes_bindings ORDER BY user_id').all(), attempts: db.prepare('SELECT * FROM hermes_login_attempts ORDER BY id').all() }), beforeDisabled);
  await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true });
});
