import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-hermes-live-callback-'));
const internalSecret = 'i'.repeat(32); const managerSecret = 'm'.repeat(32);
const internalFile = path.join(directory, 'internal.secret'); const managerFile = path.join(directory, 'manager.secret');
writeFileSync(internalFile, `${internalSecret}\n`, { mode: 0o600 }); writeFileSync(managerFile, `${managerSecret}\n`, { mode: 0o600 }); chmodSync(internalFile, 0o600); chmodSync(managerFile, 0o600);
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'hermes-live-callback-route-secret-at-least-32'; process.env.DB_PATH = path.join(directory, 'route.sqlite');
process.env.HERMES_BINDING_ENABLED = 'true'; process.env.HERMES_INTERNAL_SECRET_FILE = internalFile; process.env.HERMES_ACCOUNT_MANAGER_URL = 'http://127.0.0.1:38999'; process.env.HERMES_ACCOUNT_MANAGER_SECRET_FILE = managerFile;

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { hermesBindingRoutes } = await import('../src/routes/hermes-bindings.js');
const { createHermesQrAttempt, fingerprint, markHermesQrAwaitingContext, removeOwnedHermesBinding } = await import('../src/services/hermes-binding.js');

test('内部 activate callback 对 post-TTL active 精确三元组返回 200，错误与解绑后返回 409', { concurrency: false }, async () => {
  initDb(); const db = getDb(); db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('live-callback','回调用户','x')").run();
  const attempt = createHermesQrAttempt(db, 1, '2099-08-09 09:00:00'); markHermesQrAwaitingContext(db, attempt.id, '2099-08-09 09:00:01');
  const body = { id: attempt.id, accountRef: attempt.account_ref, targetFingerprint: fingerprint('live-callback-target'), activationId: '12345678-1234-4234-a234-123456789012' };
  const app = Fastify(); await app.register(hermesBindingRoutes); await app.ready(); let number = 0;
  const callback = async (payload = body) => {
    const raw = JSON.stringify(payload); const timestamp = String(Date.now()); const nonce = `n${String(++number).padStart(23, '0')}`;
    const signature = createHmac('sha256', internalSecret).update(['POST', '/internal/hermes-accounts/activate', timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
    return app.inject({ method: 'POST', url: '/internal/hermes-accounts/activate', payload: raw, headers: { 'content-type': 'application/json', 'x-hermes-timestamp': timestamp, 'x-hermes-nonce': nonce, 'x-hermes-signature': signature } });
  };
  assert.equal((await callback()).statusCode, 200);
  db.prepare("UPDATE hermes_login_attempts SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(attempt.id);
  const before = JSON.stringify({ binding: db.prepare('SELECT * FROM hermes_bindings WHERE user_id=1').get(), attempt: db.prepare('SELECT * FROM hermes_login_attempts WHERE id=?').get(attempt.id) });
  assert.equal((await callback()).statusCode, 200);
  assert.equal(JSON.stringify({ binding: db.prepare('SELECT * FROM hermes_bindings WHERE user_id=1').get(), attempt: db.prepare('SELECT * FROM hermes_login_attempts WHERE id=?').get(attempt.id) }), before);
  assert.equal((await callback({ ...body, activationId: '00000000-0000-4000-8000-000000000099' })).statusCode, 409);
  removeOwnedHermesBinding(db, 1, '2026-08-09 09:02:00');
  assert.equal((await callback()).statusCode, 409);
  await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true });
});
