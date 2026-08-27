import type { DatabaseSync } from 'node:sqlite';

/**
 * 品牌域独立版本表。
 *
 * 现有主库迁移 001-010 已发布并带固定校验和，不能改写。品牌域先以幂等、
 * 启动前执行的附加模式落地，后续变更按 brand_schema_meta 递增版本。
 */
export const BRAND_SCHEMA_VERSION = 1;

const BRAND_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brand_schema_meta (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS brands (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  english_name       TEXT CHECK (english_name IS NULL OR length(english_name) <= 160),
  alias              TEXT CHECK (alias IS NULL OR length(alias) <= 300),
  description        TEXT CHECK (description IS NULL OR length(description) <= 4000),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  first_collected_at TEXT NOT NULL CHECK (length(first_collected_at) = 10),
  created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_name_active
  ON brands(lower(trim(name))) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_brands_status ON brands(status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_brands_collected ON brands(first_collected_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS companies (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  name                         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  unified_social_credit_code   TEXT CHECK (unified_social_credit_code IS NULL OR length(unified_social_credit_code) <= 40),
  legal_representative         TEXT CHECK (legal_representative IS NULL OR length(legal_representative) <= 100),
  registered_capital           TEXT CHECK (registered_capital IS NULL OR length(registered_capital) <= 100),
  registered_address           TEXT CHECK (registered_address IS NULL OR length(registered_address) <= 600),
  business_status              TEXT CHECK (business_status IS NULL OR length(business_status) <= 100),
  established_at               TEXT CHECK (established_at IS NULL OR length(established_at) = 10),
  business_scope               TEXT CHECK (business_scope IS NULL OR length(business_scope) <= 8000),
  description                  TEXT CHECK (description IS NULL OR length(description) <= 4000),
  first_collected_at           TEXT NOT NULL CHECK (length(first_collected_at) = 10),
  created_by                   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by                   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_deleted                   INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_active
  ON companies(lower(trim(name))) WHERE is_deleted = 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_credit_active
  ON companies(lower(trim(unified_social_credit_code)))
  WHERE unified_social_credit_code IS NOT NULL AND trim(unified_social_credit_code) <> '' AND is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(business_status, is_deleted);

CREATE TABLE IF NOT EXISTS brand_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES brand_types(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_types_sibling_name
  ON brand_types(COALESCE(parent_id, 0), lower(trim(name))) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_brand_types_parent ON brand_types(parent_id, sort_order, id);

CREATE TABLE IF NOT EXISTS brand_type_relations (
  brand_id   INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  type_id    INTEGER NOT NULL REFERENCES brand_types(id) ON DELETE RESTRICT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (brand_id, type_id)
);
CREATE INDEX IF NOT EXISTS idx_brand_type_rel_type ON brand_type_relations(type_id, brand_id);

CREATE TABLE IF NOT EXISTS brand_company_relations (
  brand_id     INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT '其他'
    CHECK (relation_type IN ('品牌所有方','实际运营方','招聘主体','电商店铺主体','经销代理方','其他')),
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (brand_id, company_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_brand_company_company ON brand_company_relations(company_id, brand_id);

CREATE TABLE IF NOT EXISTS resource_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type      TEXT NOT NULL
    CHECK (resource_type IN ('official_website','recruitment','business_info','ecommerce_shop','other')),
  platform           TEXT CHECK (platform IS NULL OR length(platform) <= 100),
  title              TEXT CHECK (title IS NULL OR length(title) <= 240),
  url                TEXT NOT NULL CHECK (length(trim(url)) BETWEEN 1 AND 2048),
  first_collected_at TEXT NOT NULL CHECK (length(first_collected_at) = 10),
  note               TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_links_url_active
  ON resource_links(lower(trim(url))) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_resource_links_type ON resource_links(resource_type, platform, is_deleted);

CREATE TABLE IF NOT EXISTS brand_resource_relations (
  brand_id    INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resource_links(id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (brand_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_brand_resource_resource ON brand_resource_relations(resource_id, brand_id);

CREATE TABLE IF NOT EXISTS company_resource_relations (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resource_links(id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (company_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_company_resource_resource ON company_resource_relations(resource_id, company_id);

CREATE TABLE IF NOT EXISTS lead_brand_relations (
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  brand_id   INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (lead_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_brand_brand ON lead_brand_relations(brand_id, lead_id);

CREATE TABLE IF NOT EXISTS lead_company_relations (
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (lead_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_company_company ON lead_company_relations(company_id, lead_id);

CREATE TABLE IF NOT EXISTS brand_audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('brand','company','brand_type','resource','relation')),
  entity_id     INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('create','update','delete','restore','relate','unrelate','import')),
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object' AND length(snapshot_json) <= 32768)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_brand_audit_entity ON brand_audit_logs(entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_brand_audit_user ON brand_audit_logs(user_id, created_at DESC, id DESC);
`;

export function ensureBrandSchema(database: DatabaseSync): void {
  try {
    database.exec('BEGIN IMMEDIATE;');
    database.exec(BRAND_SCHEMA_SQL);
    database.prepare(`
      INSERT OR IGNORE INTO brand_schema_meta (version, description)
      VALUES (?, ?)
    `).run(BRAND_SCHEMA_VERSION, 'create brand, company, resource and lead relation domain');
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* no open transaction */ }
    throw error;
  }
}
