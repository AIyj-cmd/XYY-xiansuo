import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireJwtSecret,
  resolveInitialAdminIdentity,
  resolveInitialAdminPassword,
  resolvePoolIdleDays,
} from '../src/config.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('JWT 密钥必须存在且至少 32 字节', () => {
  assert.throws(() => requireJwtSecret(''), /未设置/);
  assert.throws(() => requireJwtSecret('too-short'), /至少需要 32 字节/);
  assert.equal(requireJwtSecret('x'.repeat(32)), 'x'.repeat(32));
});

test('首次管理员密码拒绝弱密码并支持安全随机生成', () => {
  assert.throws(() => resolveInitialAdminPassword('123456'), /至少需要 12 位/);
  assert.deepEqual(
    resolveInitialAdminPassword('safe-initial-password'),
    { password: 'safe-initial-password', generated: false },
  );
  assert.deepEqual(
    resolveInitialAdminPassword(undefined, () => 'generated-secure-password'),
    { password: 'generated-secure-password', generated: true },
  );
});

test('生产环境空数据库未设置初始密码时拒绝启动', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => resolveInitialAdminPassword(undefined), /生产环境首次初始化/);
  restoreEnv('NODE_ENV', previous);
});

test('初始管理员身份支持环境变量且拒绝空值', () => {
  const previousUsername = process.env.ADMIN_INITIAL_USERNAME;
  const previousName = process.env.ADMIN_INITIAL_NAME;
  process.env.ADMIN_INITIAL_USERNAME = 'bootstrap-admin';
  process.env.ADMIN_INITIAL_NAME = '初始化管理员';
  assert.deepEqual(resolveInitialAdminIdentity(), { username: 'bootstrap-admin', name: '初始化管理员' });
  process.env.ADMIN_INITIAL_USERNAME = ' ';
  assert.throws(() => resolveInitialAdminIdentity(), /不能为空/);
  restoreEnv('ADMIN_INITIAL_USERNAME', previousUsername);
  restoreEnv('ADMIN_INITIAL_NAME', previousName);
});

test('公海阈值只接受 1 到 365 天', () => {
  assert.equal(resolvePoolIdleDays('15'), 15);
  assert.equal(resolvePoolIdleDays('0'), 7);
  assert.equal(resolvePoolIdleDays('366'), 7);
  assert.equal(resolvePoolIdleDays('invalid'), 7);
});
