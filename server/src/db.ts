import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
  }
  return db;
}

const DDL = `
PRAGMA journal_mode = WAL;

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
);

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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone  ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_next   ON leads(next_follow_at);
CREATE INDEX IF NOT EXISTS idx_leads_owner  ON leads(owner_id);

CREATE TABLE IF NOT EXISTS follow_ups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id        INTEGER NOT NULL REFERENCES leads(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  type           TEXT NOT NULL DEFAULT '电话' CHECK (type IN ('电话','微信','拜访','其他')),
  content        TEXT NOT NULL,
  result         TEXT,
  next_follow_at TEXT,
  images         TEXT,                    -- JSON 数组，存图片相对路径
  amount         REAL,                    -- 报价金额（元），可为空
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fu_lead ON follow_ups(lead_id);

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
CREATE INDEX IF NOT EXISTS idx_lt_lead ON lead_tags(lead_id);
CREATE INDEX IF NOT EXISTS idx_lt_tag  ON lead_tags(tag_id);

CREATE TABLE IF NOT EXISTS memos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_memos_user ON memos(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,           -- 'create' | 'update' | 'transfer' | 'delete' | 'restore'
  field      TEXT,                    -- 变更字段名
  old_val    TEXT,
  new_val    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_al_lead ON audit_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_al_transfer_new ON audit_logs(action, new_val);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_lead ON favorites(lead_id);
`;

export function initDb(): void {
  const database = getDb();
  database.exec(DDL);
  // 迁移：补加新列
  const cols = database.prepare("PRAGMA table_info(follow_ups)").all() as any[];
  if (!cols.find(c => c.name === 'images')) {
    database.exec("ALTER TABLE follow_ups ADD COLUMN images TEXT");
  }
  if (!cols.find(c => c.name === 'amount')) {
    database.exec("ALTER TABLE follow_ups ADD COLUMN amount REAL");
  }
  migrateLeadsTable(database);
}

// 迁移：老表 phone 是 NOT NULL，status 枚举没有"停止跟进"。
// SQLite 不支持直接 ALTER 掉 NOT NULL / CHECK 约束，只能重建表。
function migrateLeadsTable(database: DatabaseSync): void {
  const leadsCols = database.prepare("PRAGMA table_info(leads)").all() as any[];
  const phoneCol = leadsCols.find(c => c.name === 'phone');
  const schemaRow = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leads'").get() as any;
  const needsMigration = (phoneCol && phoneCol.notnull === 1) || (schemaRow && !schemaRow.sql.includes('停止跟进'));
  if (!needsMigration) return;

  // follow_ups/lead_tags/audit_logs/favorites 都有外键指向 leads，
  // 重建表期间必须先关掉外键检查，否则 DROP TABLE leads 会被拒绝。
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec(`
    CREATE TABLE leads_new (
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
    );
    INSERT INTO leads_new SELECT * FROM leads;
    DROP TABLE leads;
    ALTER TABLE leads_new RENAME TO leads;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone  ON leads(phone);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_next   ON leads(next_follow_at);
    CREATE INDEX IF NOT EXISTS idx_leads_owner  ON leads(owner_id);
  `);
  database.exec('PRAGMA foreign_keys = ON;');
}
