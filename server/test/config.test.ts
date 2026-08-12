import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireJwtSecret,
  resolveInitialAdminIdentity,
  resolveInitialAdminPassword,
  resolvePoolIdleDays,
} from '../src/config.js';
import { containsSensitiveText, redactSensitiveText } from '../src/ai/redaction.js';
import { assertSafeAiOutput } from '../src/ai/output-schemas.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('JWT 密钥必须存在且至少 32 字节', () => {
  assert.throws(() => requireJwtSecret(''), /未设置/);
  assert.throws(() => requireJwtSecret('too-short'), /至少需要 32 字节/);
  assert.equal(requireJwtSecret('x'.repeat(32)), 'x'.repeat(32));
});

test('首次管理员密码拒绝弱密码且所有环境均要求显式密码', () => {
  assert.throws(() => resolveInitialAdminPassword('123456'), /至少需要 12 位/);
  assert.deepEqual(
    resolveInitialAdminPassword('safe-initial-password'),
    { password: 'safe-initial-password' },
  );
  assert.throws(() => resolveInitialAdminPassword(undefined), /必须设置/);
});

test('生产环境空数据库未设置初始密码时拒绝启动', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => resolveInitialAdminPassword(undefined), /必须设置/);
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

test('AI 敏感检测统一覆盖邮箱、分隔手机号、凭据、JWT 与高熵 token', () => {
  const cases = ['test@example.com', '+86 138-0013-8000', 'password: hunter2-secret', 'api key=sk_abcdefghijklmnopQRSTUV123456', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-value-long', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'];
  for (const value of cases) {
    assert.equal(containsSensitiveText(value), true);
    assert.equal(redactSensitiveText(value).includes(value), false);
    assert.throws(() => assertSafeAiOutput({ text: value }), /敏感/);
  }
  assert.equal(containsSensitiveText('正常中文业务摘要和订单号202608090001'), false);
});
