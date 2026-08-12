import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  configureConnection,
  MIGRATIONS,
  runMigrations,
  type Migration,
  type MigrationLogEvent,
  type MigrationLogger,
} from '../src/db.js';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-migrations-'));

function open(name: string): DatabaseSync {
  const database = new DatabaseSync(path.join(testDirectory, name), { enableForeignKeyConstraints: true });
  configureConnection(database);
  return database;
}

function createLegacySchema(database: DatabaseSync): void {
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
  database.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('legacy', '旧用户', 'hash', 'admin')").run();
  database.prepare(`INSERT INTO leads (contact_name, phone, source, status, owner_id, lead_date, created_by)
    VALUES ('旧客户', '13800000000', '官网', '跟进中', 1, '2026-01-01', 1)`).run();
  database.prepare("INSERT INTO follow_ups (lead_id, user_id, content) VALUES (1, 1, '历史跟进')").run();
}

test('空库创建完整版本化 schema，并强制外键', () => {
  const database = open('empty.db');
  runMigrations(database);
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>;
  assert.deepEqual(versions.map((row) => row.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
  const tokenVersion = database.prepare("PRAGMA table_info('users')").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
  const versionColumn = tokenVersion.find((column) => column.name === 'token_version');
  assert.deepEqual(versionColumn && {
    name: versionColumn.name, type: versionColumn.type, notnull: versionColumn.notnull, dflt_value: versionColumn.dflt_value,
  }, {
    name: 'token_version', type: 'INTEGER', notnull: 1, dflt_value: '0',
  });
  assert.throws(() => database.prepare("INSERT INTO users(username,name,password_hash,token_version) VALUES ('bad-version','坏版本','hash',-1)").run(), /CHECK constraint failed/);
  const bindingColumns = database.prepare('PRAGMA table_info(hermes_bindings)').all() as Array<{ name: string }>;
  assert.ok(bindingColumns.some((column) => column.name === 'active_activation_id_hash'));
  assert.equal((database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.throws(() => database.prepare("INSERT INTO follow_ups (lead_id, user_id, content) VALUES (999, 999, 'invalid')").run(), /FOREIGN KEY constraint failed/);
  database.close();
});

test('旧结构可迁移、保留记录、索引和外键，并可重复执行', () => {
  const database = open('legacy.db');
  createLegacySchema(database);
  runMigrations(database);
  runMigrations(database);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM leads').get() as { count: number }).count, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM follow_ups').get() as { count: number }).count, 1);
  const leadInfo = database.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string; notnull: number }>;
  assert.equal(leadInfo.find((column) => column.name === 'phone')?.notnull, 0);
  const followUpInfo = database.prepare('PRAGMA table_info(follow_ups)').all() as Array<{ name: string }>;
  assert.ok(followUpInfo.some((column) => column.name === 'images'));
  assert.ok(followUpInfo.some((column) => column.name === 'amount'));
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_leads_owner'").all();
  assert.equal(indexes.length, 1);
  assert.doesNotThrow(() => database.prepare(`INSERT INTO leads (contact_name, phone, source, status, lead_date)
    VALUES ('可空手机号客户', NULL, '官网', '停止跟进', '2026-01-02')`).run());
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('leads_new', 'leads_old')").all().length, 0);
  database.close();
});

test('007 升级到唯一的 008 时创建 active activation 凭证列且可重复执行', () => {
  const database = open('upgrade-007-to-008.db');
  runMigrations(database, MIGRATIONS.slice(0, 7), { log: () => undefined });
  runMigrations(database, MIGRATIONS, { log: () => undefined });
  runMigrations(database, MIGRATIONS, { log: () => undefined });
  const columns = database.prepare('PRAGMA table_info(hermes_bindings)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'active_activation_id_hash'));
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='008'").get() as { count: number }).count, 1);
  database.close();
});

test('008 活跃共享 Hermes 绑定升级到 009 时完整保留历史与 pending 任务，仅以 account_ref 缺失要求重绑', () => {
  const database = open('upgrade-008-to-009.db');
  runMigrations(database, MIGRATIONS.slice(0, 8), { log: () => undefined });
  database.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('legacy-hermes','旧 Hermes 用户','hash','member')").run();
  database.prepare("INSERT INTO hermes_bindings(user_id,peer_fingerprint,status,generation,active_activation_id_hash,updated_at) VALUES (1,?,'active',1,?,?)").run('a'.repeat(64), 'b'.repeat(64), '2026-08-08 09:00:00');
  database.exec("CREATE TABLE migration_009_trigger_probe (id INTEGER NOT NULL);");
  database.exec("CREATE TRIGGER migration_009_notification_trigger AFTER INSERT ON notification_logs BEGIN INSERT INTO migration_009_trigger_probe(id) VALUES (NEW.id); END;");
  database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,recipient_binding_generation,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
    VALUES ('scheduled_follow_overdue','migration','legacy-task','lead',1,1,1,'2026-08-08 09:00:00','legacy-task','legacy-key',1,'{}','["hermes"]','hermes','{}','pending',1,'2026-08-08 09:00:00','2026-08-09 09:00:00')`).run();
  runMigrations(database, MIGRATIONS, { log: () => undefined });
  const binding = database.prepare('SELECT status,generation,account_ref FROM hermes_bindings WHERE user_id=1').get() as { status: string; generation: number; account_ref: string | null };
  assert.deepEqual({ ...binding }, { status: 'active', generation: 1, account_ref: null });
  assert.equal((database.prepare("SELECT status FROM notification_logs WHERE dedupe_key='legacy-task'").get() as { status: string }).status, 'pending');
  database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
    VALUES ('scheduled_follow_overdue','migration','trigger-task','lead',2,1,'2026-08-08 09:00:00','trigger-task','trigger-key',1,'{}','["mock"]','mock','{}','pending',1,'2026-08-08 09:00:00','2026-08-09 09:00:00')`).run();
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM migration_009_trigger_probe').get() as { count: number }).count, 2);
  const columns = database.prepare('PRAGMA table_info(notification_logs)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'recipient_account_ref'));
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='009'").get() as { count: number }).count, 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('009 升级至 010、重复执行、严格恢复与故障回滚均保持 token_version 合约', () => {
  const upgrade = open('upgrade-009-to-010.db');
  runMigrations(upgrade, MIGRATIONS.slice(0, 9), { log: () => undefined });
  upgrade.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('version-upgrade','版本升级','hash','member')").run();
  runMigrations(upgrade, MIGRATIONS, { log: () => undefined });
  runMigrations(upgrade, MIGRATIONS, { log: () => undefined });
  assert.equal((upgrade.prepare("SELECT token_version FROM users WHERE username='version-upgrade'").get() as { token_version: number }).token_version, 0);
  assert.equal((upgrade.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='010'").get() as { count: number }).count, 1);
  assert.throws(
    () => runMigrations(upgrade, [{ ...MIGRATIONS[9], checksum: 'conflicting-010-checksum' }], { log: () => undefined }),
    /校验和不匹配/,
  );
  upgrade.close();

  const recovered = open('recover-existing-010-column.db');
  runMigrations(recovered, MIGRATIONS.slice(0, 9), { log: () => undefined });
  recovered.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(token_version) = 'integer' AND token_version >= 0)");
  runMigrations(recovered, [MIGRATIONS[9]], { log: () => undefined });
  assert.equal((recovered.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='010'").get() as { count: number }).count, 1);
  recovered.close();

  const malformed = open('reject-existing-malformed-010-column.db');
  runMigrations(malformed, MIGRATIONS.slice(0, 9), { log: () => undefined });
  malformed.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  assert.throws(() => runMigrations(malformed, [MIGRATIONS[9]], { log: () => undefined }), /迁移010恢复状态不完整/);
  assert.equal((malformed.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='010'").get() as { count: number }).count, 0);
  malformed.close();

  const rollback = open('rollback-010.db');
  runMigrations(rollback, MIGRATIONS.slice(0, 9), { log: () => undefined });
  const failing010: Migration = {
    ...MIGRATIONS[9],
    up(database) {
      MIGRATIONS[9].up(database);
      throw new Error('010 rollback injection');
    },
  };
  assert.throws(() => runMigrations(rollback, [failing010], { log: () => undefined }), /010 rollback injection/);
  assert.equal((rollback.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='010'").get() as { count: number }).count, 0);
  assert.equal((rollback.prepare("PRAGMA table_info('users')").all() as Array<{ name: string }>).some((column) => column.name === 'token_version'), false);
  rollback.close();
});

test('迁移校验和冲突或迁移失败时拒绝继续且不写完成记录', () => {
  const database = open('failures.db');
  runMigrations(database);
  const changedChecksum: Migration = { ...MIGRATIONS[0], checksum: 'different-checksum' };
  assert.throws(() => runMigrations(database, [changedChecksum]), /校验和不匹配/);
  const failingMigration: Migration = {
    version: '999', description: 'must fail', checksum: 'failing-checksum',
    up: () => { throw new Error('expected migration failure'); },
  };
  assert.throws(() => runMigrations(database, [failingMigration]), /expected migration failure/);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '999'").get() as { count: number }).count, 0);
  database.close();
});

test('006 旧版本升级到全部当前迁移时保留通知历史且所有规则关闭', () => {
  const database = open('upgrade-006-to-current.db');
  runMigrations(database, MIGRATIONS.slice(0, 6), { log: () => undefined });
  database.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('upgrade-user', '升级用户', 'hash', 'admin')").run();
  database.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('upgrade-owner', '升级负责人', 'hash', 'member')").run();
  database.prepare("INSERT INTO leads (contact_name, source, owner_id, created_by, lead_date) VALUES ('历史客户', '升级演练', 2, 1, '2026-08-02')").run();
  database.prepare(`INSERT INTO notification_logs (
    event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,new_owner_id,recipient_user_id,
    occurred_at,dedupe_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,
    status,max_attempts,available_at,expires_at
  ) VALUES (
    'owner_changed','single_edit','upgrade-operation','lead',1,1,1,2,2,
    '2026-08-02 00:00:00','upgrade-dedupe',1,'{}','["mock"]','mock','{}',
    'failed',1,'2026-08-02 00:00:00','2026-08-03 00:00:00'
  )`).run();

  runMigrations(database, MIGRATIONS, { log: () => undefined });
  const migrations = database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: string; checksum: string }>;
  assert.deepEqual(migrations.map((row) => ({ ...row })), MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
  assert.equal((database.prepare('SELECT channel FROM notification_logs WHERE dedupe_key=?').get('upgrade-dedupe') as { channel: string }).channel, 'mock');
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM notification_rules WHERE enabled != 0').get() as { count: number }).count, 0);
  assert.equal(Object.values(database.prepare('PRAGMA integrity_check').get() as Record<string, string>)[0], 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('迁移 logger 在事务成功提交后记录 applied', () => {
  const database = open('log-applied.db');
  const events: MigrationLogEvent[] = [];
  runMigrations(database, [MIGRATIONS[0]], { log: (event) => events.push(event) });
  assert.deepEqual(events, [{
    version: '001',
    description: 'create baseline schema',
    result: 'applied',
  }]);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '001'").get() as { count: number }).count,
    1,
  );
  database.close();
});

test('迁移 logger 对校验和匹配的已执行版本记录 skipped', () => {
  const database = open('log-skipped.db');
  runMigrations(database, [MIGRATIONS[0]], { log: () => undefined });
  const events: MigrationLogEvent[] = [];
  runMigrations(database, [MIGRATIONS[0]], { log: (event) => events.push(event) });
  assert.deepEqual(events, [{
    version: '001',
    description: 'create baseline schema',
    result: 'skipped',
  }]);
  database.close();
});

test('迁移 logger 安全记录 failed，且 logger 异常不掩盖原迁移异常', () => {
  const database = open('log-failed.db');
  const secret = '客户张三 password=NeverLog hash=NeverLogHash';
  const failingMigration: Migration = {
    version: 'log-failed',
    description: 'verify safe migration failure logging',
    checksum: 'log-failed-v1',
    up() {
      throw new Error(`original migration failure: ${secret}`);
    },
  };
  const events: MigrationLogEvent[] = [];
  assert.throws(
    () => runMigrations(database, [failingMigration], { log: (event) => events.push(event) }),
    (error: unknown) => error instanceof Error && error.message === `original migration failure: ${secret}`,
  );
  assert.deepEqual(events, [{
    version: 'log-failed',
    description: 'verify safe migration failure logging',
    result: 'failed',
    errorSummary: 'Error',
  }]);
  assert.ok(!JSON.stringify(events).includes(secret));

  const loggerFailure: MigrationLogger = {
    log() {
      throw new Error('logger unavailable');
    },
  };
  assert.throws(
    () => runMigrations(database, [failingMigration], loggerFailure),
    (error: unknown) => error instanceof Error && error.message === `original migration failure: ${secret}`,
  );
  database.close();
});

test.after(() => rmSync(testDirectory, { recursive: true, force: true }));
