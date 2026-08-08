import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { SignJWT } from 'jose';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-auth-'));
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-bytes-long';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.NODE_ENV = 'test';

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { signToken } = await import('../src/utils/jwt.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { userRoutes } = await import('../src/routes/users.js');
const { hashPassword } = await import('../src/utils/password.js');

initDb();
const db = getDb();
const passwordHash = await hashPassword('valid-password-for-auth-tests');
db.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES
  ('admin1', '管理员一', ?, 'admin'),
  ('member1', '业务员一', ?, 'member'),
  ('member2', '业务员二', ?, 'member')`).run(passwordHash, passwordHash, passwordHash);
const ids = Object.fromEntries((db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>)
  .map((user) => [user.username, user.id])) as Record<string, number>;

const app = Fastify();
await app.register(authRoutes);
await app.register(userRoutes);
await app.ready();

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('正常 member token 可访问已登录接口，正常 admin token 可访问管理员接口', async () => {
  const memberToken = await signToken({ id: ids.member1, username: '过期名称', role: 'admin' });
  const adminToken = await signToken({ id: ids.admin1 });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
    username: 'member1', password: 'valid-password-for-auth-tests',
  } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().code, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(memberToken) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(adminToken) })).statusCode, 200);
});

test('管理员降级后旧 token 立刻失去管理员权限', async () => {
  db.prepare("UPDATE users SET role = 'admin', is_active = 1 WHERE id = ?").run(ids.member2);
  const oldAdminToken = await signToken({ id: ids.member2, role: 'admin' });
  db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(ids.member2);
  const response = await app.inject({ method: 'GET', url: '/api/users', headers: bearer(oldAdminToken) });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, 1);
});

test('业务员升级后旧 token 立即使用数据库中的管理员角色', async () => {
  const oldMemberToken = await signToken({ id: ids.member1, role: 'member' });
  db.prepare("UPDATE users SET role = 'admin', name = '已升级管理员' WHERE id = ?").run(ids.member1);
  const response = await app.inject({ method: 'GET', url: '/api/users', headers: bearer(oldMemberToken) });
  assert.equal(response.statusCode, 200);
  db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(ids.member1);
});

test('停用或删除用户后旧 token 立即失效', async () => {
  const disabledToken = await signToken({ id: ids.member1 });
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ids.member1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(disabledToken) })).statusCode, 401);
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(ids.member1);

  const deletedToken = await signToken({ id: ids.member2 });
  db.prepare('DELETE FROM users WHERE id = ?').run(ids.member2);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(deletedToken) })).statusCode, 401);
});

test('缺少、错误、过期 token 均为 401，普通用户访问管理员接口为 403', async () => {
  const memberToken = await signToken({ id: ids.member1 });
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer('not-a-jwt') })).statusCode, 401);
  const expiredToken = await new SignJWT({ id: ids.member1 })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('0s')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(expiredToken) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(memberToken) })).statusCode, 403);
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
