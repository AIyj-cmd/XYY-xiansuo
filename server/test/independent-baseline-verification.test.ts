import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-independent-'));
const jwtSecret = 'independent-test-secret-that-is-at-least-32-bytes';
process.env.JWT_SECRET = jwtSecret;
process.env.NODE_ENV = 'test';
process.env.ADMIN_INITIAL_PASSWORD = 'independent-admin-password';
process.env.DB_PATH = path.join(testDirectory, 'initial.db');

const { closeDb, configureConnection, getDatabasePath, getDb, initDb, MIGRATIONS, runMigrations } = await import('../src/db.js');
type Migration = import('../src/db.js').Migration;
const { authRoutes } = await import('../src/routes/auth.js');
const { userRoutes } = await import('../src/routes/users.js');
const { buildApp } = await import('../src/index.js');
const { initializeAdmin } = await import('../src/bootstrap.js');
const { verifyPassword } = await import('../src/utils/password.js');

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signHistoricalToken(id: number, username: string, name: string, role: 'admin' | 'member'): Promise<string> {
  return new SignJWT({ id, username, name, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(jwtSecret));
}

test('真实历史 JWT 载荷只作为身份凭证，实时数据库字段覆盖旧 username/name/role', { concurrency: false }, async () => {
  const databasePath = path.join(testDirectory, 'historical-token.db');
  process.env.DB_PATH = databasePath;
  closeDb();
  initDb();
  const database = getDb();
  database.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('real-member', '数据库姓名', 'hash', 'member')").run();
  const user = database.prepare("SELECT id FROM users WHERE username = 'real-member'").get() as { id: number };

  const app = Fastify();
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.ready();
  const oldToken = await signHistoricalToken(user.id, '已删除旧用户名', '已删除旧姓名', 'admin');

  const memberResponse = await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(oldToken) });
  assert.equal(memberResponse.statusCode, 200);
  assert.deepEqual(memberResponse.json().data, {
    id: user.id, username: 'real-member', name: '数据库姓名', phone: null, role: 'member', is_active: 1,
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(oldToken) })).statusCode, 403);

  database.prepare("UPDATE users SET role = 'admin', username = 'renamed-user', name = '实时管理员' WHERE id = ?").run(user.id);
  const upgraded = await app.inject({ method: 'GET', url: '/api/users', headers: bearer(oldToken) });
  assert.equal(upgraded.statusCode, 200);
  const renamed = await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(oldToken) });
  assert.equal(renamed.json().data.username, 'renamed-user');
  assert.equal(renamed.json().data.name, '实时管理员');

  database.prepare("UPDATE users SET role = 'member', is_active = 0 WHERE id = ?").run(user.id);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(oldToken) })).statusCode, 401);
  database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(oldToken) })).statusCode, 401);
  await app.close();
  closeDb();
});

test('DB_PATH 默认值、绝对/相对解析、导入后动态读取、独立连接关闭及不可用路径失败', { concurrency: false }, () => {
  assert.equal(getDatabasePath(), path.join(testDirectory, 'historical-token.db'));
  const previousPath = process.env.DB_PATH;
  delete process.env.DB_PATH;
  assert.equal(getDatabasePath(), path.join(process.cwd(), 'data', 'app.db'));
  process.env.DB_PATH = previousPath;
  assert.equal(getDatabasePath('relative-file.db'), path.resolve(process.cwd(), 'relative-file.db'));
  assert.equal(getDatabasePath('/tmp/independent-absolute.db'), '/tmp/independent-absolute.db');

  const first = path.join(testDirectory, 'dynamic', 'first.db');
  const second = path.join(testDirectory, 'dynamic', 'second.db');
  process.env.DB_PATH = first;
  closeDb();
  initDb();
  assert.equal(getDatabasePath(), first);
  assert.equal((getDb().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  closeDb();
  process.env.DB_PATH = second;
  initDb();
  assert.equal(getDatabasePath(), second);
  closeDb();

  process.env.DB_PATH = '/dev/null/independent.db';
  assert.throws(() => getDb());
  closeDb();
  process.env.DB_PATH = path.join(testDirectory, 'dynamic', 'second.db');
});

test('管理员初始化在所有环境空库缺密码时阻断启动，显式密码绝不输出或记录哈希', { concurrency: false }, async () => {
  const previous = { nodeEnv: process.env.NODE_ENV, password: process.env.ADMIN_INITIAL_PASSWORD, dbPath: process.env.DB_PATH };
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_INITIAL_PASSWORD;
  process.env.DB_PATH = path.join(testDirectory, 'production-missing-password.db');
  closeDb();
  await assert.rejects(buildApp(), /必须设置/);
  closeDb();

  process.env.NODE_ENV = 'test';
  process.env.ADMIN_INITIAL_PASSWORD = 'test-explicit-initial-password';
  const database = new DatabaseSync(':memory:');
  configureConnection(database);
  // Exercise the frozen 005 recovery contract before applying 006; a current
  // database with an erased migration ledger must not reinterpret 006 as 005.
  runMigrations(database, MIGRATIONS.slice(0, 5));
  const logs: string[] = [];
  assert.equal(await initializeAdmin(database, { log: (message: string) => logs.push(message) }), true);
  assert.ok(logs.some((message) => message.includes('已创建管理员账号')));
  assert.equal(logs.some((message) => message.includes('test-explicit-initial-password')), false);
  const hash = (database.prepare('SELECT password_hash FROM users').get() as { password_hash: string }).password_hash;
  assert.equal(await verifyPassword('test-explicit-initial-password', hash), true);
  assert.ok(!logs.some((message) => message.includes(hash)));
  logs.length = 0;
  assert.equal(await initializeAdmin(database, { log: (message: string) => logs.push(message) }), false);
  assert.deepEqual(logs, []);
  database.close();
  process.env.NODE_ENV = previous.nodeEnv;
  process.env.ADMIN_INITIAL_PASSWORD = previous.password;
  process.env.DB_PATH = previous.dbPath;
});

test('迁移兼容当前无记录库、遗留约束、外键、索引和事务回滚', { concurrency: false }, () => {
  const database = new DatabaseSync(path.join(testDirectory, 'migration-proof.db'));
  configureConnection(database);
  // 005 is frozen. Verify its ledger-loss recovery against its own schema,
  // then apply the forward-only 006 audit extension normally.
  runMigrations(database, MIGRATIONS.slice(0, 5));
  database.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('keep-user', '保留用户', 'hash', 'admin')").run();
  database.prepare("INSERT INTO leads (contact_name, source, status, owner_id, lead_date, created_by) VALUES ('保留客户', '官网', '跟进中', 1, '2026-01-01', 1)").run();
  database.exec('DROP TABLE schema_migrations;');
  runMigrations(database, MIGRATIONS.slice(0, 5));
  runMigrations(database);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM leads').get() as { count: number }).count, 1);
  assert.deepEqual((database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>).map((row) => row.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(tables.has('memos'));
  assert.ok(tables.has('favorites'));

  assert.throws(() => database.prepare("INSERT INTO follow_ups (lead_id, user_id, content) VALUES (999, 999, 'bad')").run(), /FOREIGN KEY constraint failed/);
  assert.doesNotThrow(() => database.prepare("INSERT INTO follow_ups (lead_id, user_id, content) VALUES (1, 1, 'good')").run());
  const expectedIndexes = [
    'idx_leads_phone', 'idx_leads_status', 'idx_leads_next', 'idx_leads_owner', 'idx_fu_lead',
    'idx_lt_lead', 'idx_lt_tag', 'idx_memos_user', 'idx_al_lead', 'idx_al_transfer_new', 'idx_fav_lead',
  ];
  const actualIndexes = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const index of expectedIndexes) assert.ok(actualIndexes.has(index), `missing ${index}`);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('leads_new', 'leads_old')").get() as { count: number }).count,
    0,
  );

  const rollback: Migration = {
    version: 'verify-rollback', description: 'independent transaction rollback', checksum: 'independent-rollback-v1',
    up(db) { db.exec('CREATE TABLE rolled_back_probe (id INTEGER); INSERT INTO rolled_back_probe VALUES (1);'); throw new Error('intentional failure'); },
  };
  assert.throws(() => runMigrations(database, [rollback]), /intentional failure/);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'rolled_back_probe'").get() as { count: number }).count, 0);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 'verify-rollback'").get() as { count: number }).count, 0);
  assert.doesNotThrow(() => runMigrations(database, MIGRATIONS));
  database.close();
});

test('遗留库缺少 memos/favorites、follow_ups 列且 leads 约束过旧时完整升级并保留主键与关系', { concurrency: false }, () => {
  const database = new DatabaseSync(path.join(testDirectory, 'legacy-missing-tables.db'));
  configureConnection(database);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', is_active INTEGER NOT NULL DEFAULT 1,
      wx_openid TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT, contact_name TEXT NOT NULL,
      phone TEXT NOT NULL, wechat TEXT, industry TEXT, source TEXT NOT NULL, source_note TEXT, demand_note TEXT,
      intent_level TEXT NOT NULL DEFAULT '未知', status TEXT NOT NULL DEFAULT '新线索'
      CHECK (status IN ('新线索','跟进中','已报价','已成交','已流失','暂搁置')),
      owner_id INTEGER REFERENCES users(id), lead_date TEXT NOT NULL, next_follow_at TEXT, last_follow_at TEXT,
      created_by INTEGER REFERENCES users(id), is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE follow_ups (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL REFERENCES leads(id),
      user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL DEFAULT '电话', content TEXT NOT NULL,
      result TEXT, next_follow_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
  `);
  database.prepare("INSERT INTO users (username, name, password_hash) VALUES ('legacy-user', '旧用户', 'hash')").run();
  database.prepare("INSERT INTO leads (contact_name, phone, source, owner_id, lead_date, created_by) VALUES ('旧客户', '13800000000', '官网', 1, '2026-01-01', 1)").run();
  database.prepare("INSERT INTO follow_ups (lead_id, user_id, content) VALUES (1, 1, '旧跟进')").run();
  runMigrations(database);
  assert.equal((database.prepare('SELECT id FROM leads').get() as { id: number }).id, 1);
  assert.equal((database.prepare('SELECT lead_id FROM follow_ups').get() as { lead_id: number }).lead_id, 1);
  const leadColumns = database.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string; notnull: number }>;
  assert.equal(leadColumns.find((column) => column.name === 'phone')?.notnull, 0);
  const followUpColumns = database.prepare('PRAGMA table_info(follow_ups)').all() as Array<{ name: string }>;
  assert.ok(followUpColumns.some((column) => column.name === 'images'));
  assert.ok(followUpColumns.some((column) => column.name === 'amount'));
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(tables.has('memos'));
  assert.ok(tables.has('favorites'));
  assert.doesNotThrow(() => database.prepare("INSERT INTO leads (contact_name, source, status, lead_date) VALUES ('无手机号', '官网', '停止跟进', '2026-01-02')").run());
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('leads_new', 'leads_old')").get() as { count: number }).count, 0);
  database.close();
});

test('完整 Fastify 应用保留登录、用户、线索和跟进 API 包络，并立即实施角色与停用变更', { concurrency: false }, async () => {
  process.env.DB_PATH = path.join(testDirectory, 'api-regression.db');
  process.env.ADMIN_INITIAL_USERNAME = 'integration-admin';
  process.env.ADMIN_INITIAL_NAME = '集成管理员';
  process.env.ADMIN_INITIAL_PASSWORD = 'integration-admin-password';
  closeDb();
  const app = await buildApp();
  const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'integration-admin', password: 'integration-admin-password' } });
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(adminLogin.json().code, 0);
  const adminToken = adminLogin.json().data.token as string;

  const createMember = await app.inject({ method: 'POST', url: '/api/users', headers: bearer(adminToken), payload: {
    username: 'integration-member', name: '集成成员', password: 'integration-member-password', role: 'member',
  } });
  assert.equal(createMember.statusCode, 200);
  assert.equal(createMember.json().code, 0);
  const memberId = Number(createMember.json().data.id);
  const memberLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'integration-member', password: 'integration-member-password' } });
  const memberToken = memberLogin.json().data.token as string;
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(memberToken) })).json().code, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(adminToken) })).json().code, 0);

  const lead = await app.inject({ method: 'POST', url: '/api/leads', headers: bearer(memberToken), payload: {
    contact_name: '回归客户', phone: '13812345678', source: '官网', lead_date: '2026-07-30', status: '新线索',
  } });
  assert.equal(lead.statusCode, 200);
  assert.equal(lead.json().code, 0);
  const leadId = Number(lead.json().data.id);
  assert.equal((await app.inject({ method: 'GET', url: '/api/leads', headers: bearer(memberToken) })).json().code, 0);
  const followUp = await app.inject({ method: 'POST', url: `/api/leads/${leadId}/follow-ups`, headers: bearer(memberToken), payload: {
    content: '回归跟进', status: '跟进中', type: '电话', next_follow_at: '2026-08-01',
  } });
  assert.equal(followUp.statusCode, 200);
  assert.equal(followUp.json().code, 0);

  const upgrade = await app.inject({ method: 'PATCH', url: `/api/users/${memberId}`, headers: bearer(adminToken), payload: { role: 'admin' } });
  assert.equal(upgrade.json().code, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(memberToken) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${memberId}`, headers: bearer(adminToken), payload: { role: 'member' } })).json().code, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: bearer(memberToken) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${memberId}`, headers: bearer(adminToken), payload: { is_active: 0 } })).json().code, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(memberToken) })).statusCode, 401);
  await app.close();
  closeDb();
});

test.after(() => {
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
