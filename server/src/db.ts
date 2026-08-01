import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  database.exec('PRAGMA busy_timeout = 5000;');
  scalarPragma(database, 'foreign_keys');
}

/**
 * Opens an existing SQLite database with SQLite's read-only flag.  This is
 * deliberately separate from configureConnection(): diagnostic CLIs must not
 * run migrations, set WAL mode, create a parent directory, or alter metadata.
 */
export function openReadOnlyDatabase(databasePath = getDatabasePath()): DatabaseSync {
  const walPath = `${databasePath}-wal`;
  // immutable=1 stops SQLite from creating -wal/-shm sidecars.  A non-empty
  // WAL means the main file is not a stable replica, so refusing it is safer
  // than silently inspecting a stale image.
  if (existsSync(walPath) && statSync(walPath).size > 0) throw new Error('只读联调检查要求稳定数据库副本；检测到未合并 WAL，拒绝运行');
  return new DatabaseSync(`${pathToFileURL(databasePath).href}?mode=ro&immutable=1`, { readOnly: true, enableForeignKeyConstraints: true });
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

/**
 * SQLite cannot alter a CHECK constraint.  Rebuild only notification_logs in
 * one migration transaction, preserving its exact columns, data and indexes.
 * Foreign keys are temporarily disabled by the migration runner because
 * ai_request_logs references this table; integrity is checked before commit.
 */
function allowOpenClawNotificationChannel(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_logs'").get() as { sql?: string } | undefined;
  if (!table?.sql) throw new Error('迁移007缺少 notification_logs，拒绝继续');
  if (table.sql.includes("channel IS NULL OR channel IN ('mock','openclaw')")) return;
  const oldChannelCheck = "channel IS NULL OR channel = 'mock'";
  if (!table.sql.includes(oldChannelCheck)) throw new Error('迁移007发现未知 notification_logs channel 约束，拒绝继续');
  const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='notification_logs' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ sql: string }>;
  const before = (database.prepare('SELECT COUNT(*) AS count FROM notification_logs').get() as { count: number }).count;
  const rebuilt = table.sql
    .replace(/^CREATE TABLE notification_logs/i, 'CREATE TABLE notification_logs_007_new')
    .replace(oldChannelCheck, "channel IS NULL OR channel IN ('mock','openclaw')");
  if (rebuilt === table.sql) throw new Error('迁移007无法生成 notification_logs 新定义');
  database.exec(rebuilt);
  const sourceColumns = (database.prepare("PRAGMA table_info('notification_logs')").all() as Array<{ name: string }>).map((row) => row.name);
  const targetColumns = (database.prepare("PRAGMA table_info('notification_logs_007_new')").all() as Array<{ name: string }>).map((row) => row.name);
  if (sourceColumns.join(',') !== targetColumns.join(',')) throw new Error('迁移007字段定义不一致');
  const columns = sourceColumns.map((name) => `"${name}"`).join(',');
  database.exec(`INSERT INTO notification_logs_007_new (${columns}) SELECT ${columns} FROM notification_logs;`);
  const copied = (database.prepare('SELECT COUNT(*) AS count FROM notification_logs_007_new').get() as { count: number }).count;
  if (before !== copied) throw new Error(`迁移007记录数不一致：${before}/${copied}`);
  database.exec('DROP TABLE notification_logs; ALTER TABLE notification_logs_007_new RENAME TO notification_logs;');
  for (const index of indexes) database.exec(index.sql);
  // This migration never writes notification_rules: fresh databases retain the
  // existing disabled defaults and upgraded databases retain administrators'
  // explicit prior choices without enabling any rule.
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
  {
    version: '004',
    description: 'create notification rules and reliable notification outbox',
    checksum: '61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75',
    up(database) {
      database.exec(`
CREATE TABLE IF NOT EXISTS notification_rules (
  event_type TEXT PRIMARY KEY CHECK (event_type IN ('owner_changed','scheduled_follow_overdue','visit_reminder','status_changed','daily_report','weekly_report','inactive_lead')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  recipient_strategy TEXT NOT NULL CHECK (recipient_strategy IN ('new_owner','reserved')),
  channel_order_json TEXT NOT NULL CHECK (length(channel_order_json) <= 16384 AND json_valid(channel_order_json) AND json_type(channel_order_json) = 'array'),
  config_schema_version INTEGER NOT NULL CHECK (config_schema_version >= 1),
  config_json TEXT NOT NULL CHECK (length(config_json) <= 16384 AND json_valid(config_json) AND json_type(config_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK ((event_type = 'owner_changed' AND recipient_strategy = 'new_owner') OR (event_type != 'owner_changed' AND recipient_strategy = 'reserved'))
);
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('owner_changed','scheduled_follow_overdue','visit_reminder','status_changed','daily_report','weekly_report','inactive_lead')),
  event_source TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE RESTRICT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  old_owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  new_owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  delivery_idempotency_key TEXT UNIQUE,
  rule_version INTEGER NOT NULL,
  rule_snapshot_json TEXT NOT NULL CHECK (length(rule_snapshot_json) <= 16384 AND json_valid(rule_snapshot_json) AND json_type(rule_snapshot_json) = 'object'),
  channel_order_snapshot_json TEXT NOT NULL CHECK (length(channel_order_snapshot_json) <= 16384 AND json_valid(channel_order_snapshot_json) AND json_type(channel_order_snapshot_json) = 'array'),
  channel TEXT CHECK (channel IS NULL OR channel = 'mock'),
  message_snapshot_json TEXT NOT NULL CHECK (length(message_snapshot_json) <= 16384 AND json_valid(message_snapshot_json) AND json_type(message_snapshot_json) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','retry_wait','sent','suppressed','cancelled','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  automatic_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (automatic_attempt_count >= 0),
  manual_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  lease_recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (lease_recovery_count >= 0),
  retry_allowed INTEGER NOT NULL DEFAULT 1 CHECK (retry_allowed IN (0,1)),
  provider_message_id TEXT,
  failure_class TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  suppression_reason TEXT,
  cancellation_reason TEXT,
  management_audit_json TEXT NOT NULL DEFAULT '[]' CHECK (length(management_audit_json) <= 16384 AND json_valid(management_audit_json) AND json_type(management_audit_json) = 'array'),
  expires_at TEXT NOT NULL,
  retain_until TEXT,
  last_attempt_at TEXT,
  sent_at TEXT,
  failed_at TEXT,
  suppressed_at TEXT,
  cancelled_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK ((status != 'sending') OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status != 'sent') OR (sent_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK ((status != 'suppressed') OR suppression_reason IS NOT NULL),
  CHECK ((status != 'cancelled') OR cancellation_reason IS NOT NULL),
  CHECK ((event_type != 'owner_changed') OR (event_source IN ('single_edit','batch_transfer') AND lead_id IS NOT NULL AND actor_user_id IS NOT NULL AND new_owner_id IS NOT NULL AND recipient_user_id = new_owner_id AND (old_owner_id IS NULL OR old_owner_id != new_owner_id) AND actor_user_id != new_owner_id))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_owner_changed_unique ON notification_logs(event_type, operation_id, lead_id, new_owner_id, recipient_user_id) WHERE event_type = 'owner_changed';
CREATE INDEX IF NOT EXISTS idx_notification_ready ON notification_logs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_notification_lease ON notification_logs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_notification_management ON notification_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notification_recipient ON notification_logs(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_event ON notification_logs(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_lead ON notification_logs(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_retention ON notification_logs(retain_until) WHERE status IN ('sent','suppressed','cancelled','failed');
INSERT OR IGNORE INTO notification_rules (event_type, enabled, recipient_strategy, channel_order_json, config_schema_version, config_json)
VALUES
 ('owner_changed',0,'new_owner','["mock"]',1,'{"schema_version":1,"quiet_hours":{"enabled":false,"start":"22:00","end":"08:00","timezone":"Asia/Shanghai"},"max_attempts":5,"ttl_minutes":1440}'),
 ('scheduled_follow_overdue',0,'reserved','[]',1,'{}'),
 ('visit_reminder',0,'reserved','[]',1,'{}'),
 ('status_changed',0,'reserved','[]',1,'{}'),
 ('daily_report',0,'reserved','[]',1,'{}'),
 ('weekly_report',0,'reserved','[]',1,'{}'),
 ('inactive_lead',0,'reserved','[]',1,'{}');
`);
    },
  },
  {
    version: '005',
    description: 'add AI scheduler audit log and initialize approved notification rules',
    checksum: '8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346',
    up(database) {
      const config = JSON.stringify({ schema_version: 1, recipient_mode: 'job_recipient', quiet_hours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }, max_attempts: 5, ttl_minutes: 1440 });
      // schema_migrations-loss recovery is accepted only when both the complete
      // phase-four table contract and the guarded rule initialization are present.
      const existingAiTable = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_request_logs'").get() as { sql: string } | undefined;
      if (existingAiTable) {
        const expectedColumns = ['id','request_id','idempotency_key','job_type','recipient_user_id','recipient_role_snapshot','scope','business_date','prompt_version','provider','model','status','candidate_count','context_hash','input_chars','output_chars','input_tokens','output_tokens','attempt_count','max_attempts','fallback_used','result_snapshot_json','result_hash','error_code','error_summary','available_at','lease_token','lease_owner','lease_until','notification_operation_id','notification_log_id','started_at','completed_at','result_retain_until','retain_until','created_at','updated_at'];
        const actualColumns = (database.prepare("PRAGMA table_info('ai_request_logs')").all() as Array<{ name: string }>).map((column) => column.name);
        const expectedIndexes = new Set(['idx_ai_request_ready','idx_ai_request_lease','idx_ai_request_recipient_date','idx_ai_request_job_date','idx_ai_request_retention']);
        const actualIndexes = new Set((database.prepare("PRAGMA index_list('ai_request_logs')").all() as Array<{ name: string }>).map((index) => index.name));
        const rules = (database.prepare(`SELECT COUNT(*) AS count FROM notification_rules
          WHERE event_type IN ('scheduled_follow_overdue','daily_report') AND enabled=0 AND recipient_strategy='reserved'
            AND channel_order_json='["mock"]' AND config_schema_version=1 AND config_json=? AND version=1 AND updated_by IS NULL`).get(config) as { count: number }).count;
        const requiredSql = ["status IN ('pending','generating','ready','completed','skipped','failed','cancelled')", "json_type(result_snapshot_json)='object'", "status != 'generating'", "status != 'ready'", "status != 'completed'"];
        if (actualColumns.join(',') !== expectedColumns.join(',') || [...expectedIndexes].some((name) => !actualIndexes.has(name))
            || rules !== 2 || requiredSql.some((fragment) => !existingAiTable.sql.includes(fragment))) {
          throw new Error('迁移005恢复状态不完整，拒绝将未知结构标记为已迁移');
        }
        return;
      }
      // 004 deliberately created reserved placeholders.  Refuse to overwrite an
      // administrator's later choice, even when only one of the two rows changed.
      const placeholders = database.prepare(`SELECT COUNT(*) AS count FROM notification_rules
        WHERE event_type IN ('scheduled_follow_overdue','daily_report')
          AND enabled=0 AND recipient_strategy='reserved' AND channel_order_json='[]'
          AND config_schema_version=1 AND config_json='{}' AND version=1 AND updated_by IS NULL`).get() as { count: number };
      if (placeholders.count !== 2) throw new Error('阶段四通知规则不再是迁移004原始占位值，拒绝覆盖人工配置');
      database.exec(`
CREATE TABLE ai_request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  job_type TEXT NOT NULL CHECK (job_type IN ('scheduled_follow_overdue','daily_report','weekly_report')),
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_role_snapshot TEXT NOT NULL CHECK (recipient_role_snapshot IN ('admin','member')),
  scope TEXT NOT NULL CHECK (scope IN ('self','team')),
  business_date TEXT NOT NULL CHECK (length(business_date)=10 AND business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 100),
  provider TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 100),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('pending','generating','ready','completed','skipped','failed','cancelled')),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  context_hash TEXT CHECK (context_hash IS NULL OR length(context_hash)=64),
  input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
  output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 2),
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1)),
  result_snapshot_json TEXT CHECK (result_snapshot_json IS NULL OR (length(result_snapshot_json) <= 16384 AND json_valid(result_snapshot_json) AND json_type(result_snapshot_json)='object')),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash)=64),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  error_summary TEXT CHECK (error_summary IS NULL OR length(error_summary) <= 200),
  available_at TEXT NOT NULL CHECK (length(available_at)=19),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 100),
  lease_until TEXT CHECK (lease_until IS NULL OR length(lease_until)=19),
  notification_operation_id TEXT UNIQUE CHECK (notification_operation_id IS NULL OR length(notification_operation_id) BETWEEN 1 AND 128),
  notification_log_id INTEGER REFERENCES notification_logs(id) ON DELETE SET NULL,
  started_at TEXT,
  completed_at TEXT,
  result_retain_until TEXT,
  retain_until TEXT NOT NULL CHECK (length(retain_until)=19),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK ((status != 'generating') OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status != 'ready') OR (result_snapshot_json IS NOT NULL AND result_hash IS NOT NULL AND result_retain_until IS NOT NULL)),
  CHECK ((status != 'completed') OR (notification_operation_id IS NOT NULL AND notification_log_id IS NOT NULL AND result_snapshot_json IS NULL AND result_hash IS NULL)),
  CHECK ((scope != 'team') OR recipient_role_snapshot='admin')
);
CREATE INDEX IF NOT EXISTS idx_ai_request_ready ON ai_request_logs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_ai_request_lease ON ai_request_logs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_ai_request_recipient_date ON ai_request_logs(recipient_user_id, business_date);
CREATE INDEX IF NOT EXISTS idx_ai_request_job_date ON ai_request_logs(job_type, business_date);
CREATE INDEX IF NOT EXISTS idx_ai_request_retention ON ai_request_logs(retain_until);
`);
      const result = database.prepare(`UPDATE notification_rules SET channel_order_json='["mock"]', config_json=?, updated_at=datetime('now','localtime')
        WHERE event_type IN ('scheduled_follow_overdue','daily_report')
          AND enabled=0 AND recipient_strategy='reserved' AND channel_order_json='[]'
          AND config_schema_version=1 AND config_json='{}' AND version=1 AND updated_by IS NULL`).run(config);
      if (result.changes !== 2) throw new Error('阶段四通知规则初始化不完整，拒绝部分提交');
    },
  },
  {
    version: '006',
    description: 'add provider latency audit to ai request logs',
    checksum: 'b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a',
    up(database) {
      const columns = database.prepare("PRAGMA table_info('ai_request_logs')").all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === 'latency_ms')) {
        const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_request_logs'").get() as { sql: string } | undefined;
        if (!table?.sql.includes('latency_ms INTEGER') || !table.sql.includes("typeof(latency_ms) = 'integer'")) {
          throw new Error('迁移006恢复状态不完整，拒绝将未知结构标记为已迁移');
        }
        return;
      }
      database.exec(`ALTER TABLE ai_request_logs ADD COLUMN latency_ms INTEGER
        CHECK (latency_ms IS NULL OR (typeof(latency_ms) = 'integer' AND latency_ms >= 0));`);
    },
  },
  {
    version: '007',
    description: 'allow experimental OpenClaw notification channel',
    checksum: 'c09175e80d010ea056c3e93e5f4fdfc61c4b2f4c08c885d0a6b4e96b1f5242da',
    requiresForeignKeysOff: true,
    up: allowOpenClawNotificationChannel,
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
