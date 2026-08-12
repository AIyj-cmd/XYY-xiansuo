import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeAdmin } from '../src/bootstrap.js';
import { configureConnection, runMigrations } from '../src/db.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('空数据库使用合法环境变量创建一次管理员，已有用户时不再读取或输出密码', async () => {
  const previous = Object.fromEntries(['NODE_ENV', 'ADMIN_INITIAL_USERNAME', 'ADMIN_INITIAL_NAME', 'ADMIN_INITIAL_PASSWORD']
    .map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_INITIAL_USERNAME = 'first-admin';
  process.env.ADMIN_INITIAL_NAME = '首位管理员';
  process.env.ADMIN_INITIAL_PASSWORD = 'safe-initial-password';
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  configureConnection(database);
  runMigrations(database);
  const logs: string[] = [];
  const logger = { log: (message: string) => logs.push(message) };

  assert.equal(await initializeAdmin(database, logger), true);
  assert.equal((database.prepare('SELECT username, name, role FROM users').get() as { username: string; name: string; role: string }).username, 'first-admin');
  assert.ok(logs.some((line) => line.includes('first-admin')));
  assert.equal(logs.some((line) => line.includes('safe-initial-password')), false);

  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_INITIAL_PASSWORD;
  logs.length = 0;
  assert.equal(await initializeAdmin(database, logger), false);
  assert.deepEqual(logs, []);
  database.close();
  for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
});
