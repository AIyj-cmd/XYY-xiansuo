import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

export type Migration = {
  version: string;
  description: string;
  checksum: string;
  requiresForeignKeysOff?: boolean;
  up: (database: DatabaseSync) => void;
};

export type MigrationResult = 'applied' | 'skipped' | 'failed';

export type MigrationLogEvent = {
  version: string;
  description: string;
  result: MigrationResult;
  errorSummary?: string;
};

export interface MigrationLogger {
  log(event: MigrationLogEvent): void;
}

export const defaultMigrationLogger: MigrationLogger = {
  log(event) {
    const line = `[database-migration] ${JSON.stringify(event)}`;
    if (event.result === 'failed') {
      console.error(line);
      return;
    }
    console.log(line);
  },
};

let db: DatabaseSync | undefined;

/** DB_PATH 相对路径以进程工作目录为准；默认值始终是 server/data/app.db。 */
export function getDatabasePath(value = process.env.DB_PATH): string {
  return value ? path.resolve(process.cwd(), value) : DEFAULT_DB_PATH;
}

function scalarPragma(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  const value = row && Object.values(row)[0];
  if (value !== 1) throw new Error(`SQLite ${pragma} 未能启用，拒绝启动`);
  return value;
}

export function configureConnection(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  scalarPragma(database, 'foreign_keys');
}

export function getDb(): DatabaseSync {
  if (!db) {
    const databasePath = getDatabasePath();
    mkdirSync(path.dirname(databasePath), { recursive: true });
    try {
      db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      configureConnection(db);
    } catch (error) {
      try { db?.close(); } catch { /* ignore close failure after connection error */ }
      db = undefined;
      throw new Error(`无法打开数据库 ${databasePath}: ${(error as Error).message}`);
    }
  }
  return db;
}

/** 仅供测试或受控关闭流程使用，避免临时数据库文件仍被进程占用。 */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = undefined;
}

const USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  wx_openid     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

const LEADS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS leads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name   TEXT,
  contact_name   TEXT NOT NULL,
  phone          TEXT,
  wechat         TEXT,
  industry       TEXT,
  source         TEXT NOT NULL,
  source_note    TEXT,
  demand_note    TEXT,
  intent_level   TEXT NOT NULL DEFAULT '未知' CHECK (intent_level IN ('高','中','低','未知')),
  status         TEXT NOT NULL DEFAULT '新线索'
                 CHECK (status IN ('新线索','跟进中','已报价','已成交','已流失','暂搁置','停止跟进')),
  owner_id       INTEGER REFERENCES users(id),
  lead_date      TEXT NOT NULL,
  next_follow_at TEXT,
  last_follow_at TEXT,
  created_by     INTEGER REFERENCES users(id),
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

const FOLLOW_UPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS follow_ups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id        INTEGER NOT NULL REFERENCES leads(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  type           TEXT NOT NULL DEFAULT '电话' CHECK (type IN ('电话','微信','拜访','其他')),
  content        TEXT NOT NULL,
  result         TEXT,
  next_follow_at TEXT,
  images         TEXT,
  amount         REAL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

const OTHER_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#718096',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  tag_id     INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (lead_id, tag_id)
);
CREATE TABLE IF NOT EXISTS memos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  field      TEXT,
  old_val    TEXT,
  new_val    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, lead_id)
);`;

const INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_next ON leads(next_follow_at);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_fu_lead ON follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_lt_lead ON lead_tags(lead_id);
CREATE INDEX IF NOT EXISTS idx_lt_tag ON lead_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_memos_user ON memos(user_id);
CREATE INDEX IF NOT EXISTS idx_al_lead ON audit_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_al_transfer_new ON audit_logs(action, new_val);
CREATE INDEX IF NOT EXISTS idx_fav_lead ON favorites(lead_id);`;

const LEAD_COLUMNS = [
  'id', 'company_name', 'contact_name', 'phone', 'wechat', 'industry', 'source',
  'source_note', 'demand_note', 'intent_level', 'status', 'owner_id', 'lead_date',
  'next_follow_at', 'last_follow_at', 'created_by', 'is_deleted', 'created_at', 'updated_at',
].join(', ');

function reconcileExistingSchema(database: DatabaseSync): void {
  const followUpColumns = database.prepare('PRAGMA table_info(follow_ups)').all() as Array<{ name: string }>;
  if (!followUpColumns.some((column) => column.name === 'images')) {
    database.exec('ALTER TABLE follow_ups ADD COLUMN images TEXT;');
  }
  if (!followUpColumns.some((column) => column.name === 'amount')) {
    database.exec('ALTER TABLE follow_ups ADD COLUMN amount REAL;');
  }

  const leadColumns = database.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string; notnull: number }>;
  const phone = leadColumns.find((column) => column.name === 'phone');
  const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'")
    .get() as { sql: string } | undefined;
  const needsRebuild = phone?.notnull === 1 || !schema?.sql.includes('停止跟进');
  if (!needsRebuild) return;

  const sourceCount = (database.prepare('SELECT COUNT(*) AS count FROM leads').get() as { count: number }).count;
  database.exec(LEADS_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS leads', 'CREATE TABLE leads_new'));
  database.exec(`INSERT INTO leads_new (${LEAD_COLUMNS}) SELECT ${LEAD_COLUMNS} FROM leads;`);
  const targetCount = (database.prepare('SELECT COUNT(*) AS count FROM leads_new').get() as { count: number }).count;
  if (targetCount !== sourceCount) {
    throw new Error(`leads 表迁移记录数校验失败：迁移前 ${sourceCount}，迁移后 ${targetCount}`);
  }
  database.exec('DROP TABLE leads; ALTER TABLE leads_new RENAME TO leads;');
  database.exec(INDEXES_SQL);
}

/**
 * 阶段二只追加此迁移；001、002 的定义和校验和必须保持不变。
 * 方案 B：不存在跟进时，派生的 last/next_follow_at 均为 NULL，不保留旧人工日期。
 */
function addBusinessConsistencyMetadata(database: DatabaseSync): void {
  const auditColumns = new Set((database.prepare('PRAGMA table_info(audit_logs)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  const leadColumns = new Set((database.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  // schema_migrations 丢失后的受控恢复也必须可重跑，不因已存在列破坏数据。
  if (!auditColumns.has('source')) database.exec('ALTER TABLE audit_logs ADD COLUMN source TEXT;');
  if (!auditColumns.has('operation_id')) database.exec('ALTER TABLE audit_logs ADD COLUMN operation_id TEXT;');
  if (!leadColumns.has('next_follow_at_source')) {
    database.exec("ALTER TABLE leads ADD COLUMN next_follow_at_source TEXT CHECK (next_follow_at_source IN ('manual', 'follow_up')); ");
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_al_operation ON audit_logs(operation_id);');

  // 已有跟进记录的线索按统一规则回填；同一 created_at 时以较大的 id 为最新。
  database.exec(`
    UPDATE leads
    SET last_follow_at = (
          SELECT f.created_at FROM follow_ups f
          WHERE f.lead_id = leads.id
          ORDER BY f.created_at DESC, f.id DESC LIMIT 1
        ),
        next_follow_at = (
          SELECT f.next_follow_at FROM follow_ups f
          WHERE f.lead_id = leads.id
          ORDER BY f.created_at DESC, f.id DESC LIMIT 1
        ),
        next_follow_at_source = 'follow_up'
    WHERE EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = leads.id);

    UPDATE leads
    SET next_follow_at_source = 'manual'
    WHERE NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = leads.id)
      AND next_follow_at IS NOT NULL;
  `);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: '001',
    description: 'create baseline schema',
    checksum: 'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0',
    up(database) {
      database.exec(`${USERS_TABLE_SQL}\n${LEADS_TABLE_SQL}\n${FOLLOW_UPS_TABLE_SQL}\n${OTHER_TABLES_SQL}\n${INDEXES_SQL}`);
    },
  },
  {
    version: '002',
    description: 'reconcile legacy lead and follow-up schema',
    checksum: 'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9',
    requiresForeignKeysOff: true,
    up: reconcileExistingSchema,
  },
  {
    version: '003',
    description: 'add owner transfer audit metadata and follow-up derivation source',
    checksum: 'e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704',
    up: addBusinessConsistencyMetadata,
  },
];

function checkDatabase(database: DatabaseSync): void {
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>;
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
    throw new Error('SQLite integrity_check 失败，拒绝启动');
  }
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(`SQLite foreign_key_check 发现 ${foreignKeyViolations.length} 条异常，拒绝启动`);
  }
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);
}

function setForeignKeys(database: DatabaseSync, enabled: boolean): void {
  database.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'};`);
  const row = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (row.foreign_keys !== (enabled ? 1 : 0)) {
    throw new Error(`SQLite foreign_keys 无法${enabled ? '开启' : '临时关闭'}，拒绝迁移`);
  }
}

function summarizeMigrationError(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? `${error.name || 'Error'} (${code})`
    : error.name || 'Error';
}

function emitMigrationLog(logger: MigrationLogger, event: MigrationLogEvent): void {
  try {
    logger.log(event);
  } catch {
    // 日志设施不能改变迁移结果，更不能掩盖原始迁移异常。
  }
}

export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  logger: MigrationLogger = defaultMigrationLogger,
): void {
  ensureMigrationTable(database);
  const applied = new Map(
    (database.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: string; checksum: string }>)
      .map((row) => [row.version, row.checksum]),
  );

  for (const migration of migrations) {
    try {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`迁移 ${migration.version} 的校验和不匹配，拒绝继续启动`);
        }
        emitMigrationLog(logger, {
          version: migration.version,
          description: migration.description,
          result: 'skipped',
        });
        continue;
      }

      if (migration.requiresForeignKeysOff) setForeignKeys(database, false);
      let started = false;
      try {
        database.exec('BEGIN IMMEDIATE;');
        started = true;
        migration.up(database);
        checkDatabase(database);
        database.prepare(
          'INSERT INTO schema_migrations (version, description, checksum) VALUES (?,?,?)',
        ).run(migration.version, migration.description, migration.checksum);
        database.exec('COMMIT;');
        started = false;
      } catch (error) {
        if (started) database.exec('ROLLBACK;');
        throw error;
      } finally {
        if (migration.requiresForeignKeysOff) setForeignKeys(database, true);
      }
      emitMigrationLog(logger, {
        version: migration.version,
        description: migration.description,
        result: 'applied',
      });
    } catch (error) {
      emitMigrationLog(logger, {
        version: migration.version,
        description: migration.description,
        result: 'failed',
        errorSummary: summarizeMigrationError(error),
      });
      throw error;
    }
  }
  scalarPragma(database, 'foreign_keys');
  checkDatabase(database);
}

export function initDb(): void {
  const database = getDb();
  runMigrations(database);
}
