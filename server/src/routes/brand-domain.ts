import type { FastifyInstance } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { nowDatetime, todayDate } from '../utils/datetime.js';

const RESOURCE_TYPES = ['official_website', 'recruitment', 'business_info', 'ecommerce_shop', 'other'] as const;
const BRAND_RELATION_TYPES = ['品牌所有方', '实际运营方', '招聘主体', '电商店铺主体', '经销代理方', '其他'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const optionalText = (max: number) => z.string().max(max).transform((value) => value.trim()).optional().nullable()
  .transform((value) => value || null);
const optionalDate = z.string().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD').optional().nullable()
  .transform((value) => value || null);
const positiveId = z.coerce.number().int().positive();

const resourceInputSchema = z.object({
  id: positiveId.optional(),
  resource_type: z.enum(RESOURCE_TYPES),
  platform: optionalText(100),
  title: optionalText(240),
  url: z.string().trim().min(1, '网址不能为空').max(2048),
  first_collected_at: z.string().regex(DATE_PATTERN, '首次采集时间格式错误').default(() => todayDate()),
  note: optionalText(2000),
});

const companyRelationSchema = z.object({
  company_id: positiveId,
  relation_type: z.enum(BRAND_RELATION_TYPES).default('其他'),
});

const brandCreateSchema = z.object({
  name: z.string().trim().min(1, '品牌名称不能为空').max(160),
  english_name: optionalText(160),
  alias: optionalText(300),
  description: optionalText(4000),
  status: z.enum(['active', 'inactive']).default('active'),
  first_collected_at: z.string().regex(DATE_PATTERN, '首次采集时间格式错误').default(() => todayDate()),
  type_ids: z.array(positiveId).max(50).optional(),
  company_relations: z.array(companyRelationSchema).max(100).optional(),
  resources: z.array(resourceInputSchema).max(100).optional(),
});
const brandUpdateSchema = brandCreateSchema.partial();

const companyCreateSchema = z.object({
  name: z.string().trim().min(1, '工商主体名称不能为空').max(200),
  unified_social_credit_code: optionalText(40),
  legal_representative: optionalText(100),
  registered_capital: optionalText(100),
  registered_address: optionalText(600),
  business_status: optionalText(100),
  established_at: optionalDate,
  business_scope: optionalText(8000),
  description: optionalText(4000),
  first_collected_at: z.string().regex(DATE_PATTERN, '首次采集时间格式错误').default(() => todayDate()),
  resources: z.array(resourceInputSchema).max(100).optional(),
});
const companyUpdateSchema = companyCreateSchema.partial();

const typeCreateSchema = z.object({
  name: z.string().trim().min(1, '分类名称不能为空').max(80),
  parent_id: positiveId.optional().nullable(),
  sort_order: z.coerce.number().int().min(-99999).max(99999).default(0),
});
const typeUpdateSchema = typeCreateSchema.partial();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(200).optional(),
});

const brandListSchema = paginationSchema.extend({
  status: z.enum(['active', 'inactive']).optional(),
  type_id: positiveId.optional(),
  platform: z.string().trim().max(100).optional(),
  resource_type: z.enum(RESOURCE_TYPES).optional(),
  tab: z.enum(['all', 'linked_leads', 'missing_website', 'missing_company', 'has_recruitment']).default('all'),
  collected_from: z.string().regex(DATE_PATTERN).optional(),
  collected_to: z.string().regex(DATE_PATTERN).optional(),
});

const companyListSchema = paginationSchema.extend({
  business_status: z.string().trim().max(100).optional(),
  collected_from: z.string().regex(DATE_PATTERN).optional(),
  collected_to: z.string().regex(DATE_PATTERN).optional(),
});

function idParam(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const value = work();
    database.exec('COMMIT;');
    return value;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* no open transaction */ }
    throw error;
  }
}

function audit(
  database: DatabaseSync,
  entityType: 'brand' | 'company' | 'brand_type' | 'resource' | 'relation',
  entityId: number,
  userId: number,
  action: 'create' | 'update' | 'delete' | 'restore' | 'relate' | 'unrelate' | 'import',
  snapshot?: Record<string, unknown>,
): void {
  database.prepare(`
    INSERT INTO brand_audit_logs (entity_type, entity_id, user_id, action, snapshot_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, entityId, userId, action, snapshot ? JSON.stringify(snapshot) : null);
}

function activeBrand(database: DatabaseSync, brandId: number) {
  return database.prepare('SELECT * FROM brands WHERE id = ? AND is_deleted = 0').get(brandId) as Record<string, unknown> | undefined;
}

function activeCompany(database: DatabaseSync, companyId: number) {
  return database.prepare('SELECT * FROM companies WHERE id = ? AND is_deleted = 0').get(companyId) as Record<string, unknown> | undefined;
}

function activeResource(database: DatabaseSync, resourceId: number) {
  return database.prepare('SELECT * FROM resource_links WHERE id = ? AND is_deleted = 0').get(resourceId) as Record<string, unknown> | undefined;
}

function uniqueIds(values: number[] | undefined): number[] {
  return [...new Set(values ?? [])];
}

function assertTypeIds(database: DatabaseSync, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const count = (database.prepare(`SELECT COUNT(*) AS count FROM brand_types WHERE id IN (${placeholders}) AND is_deleted = 0`)
    .get(...ids) as { count: number }).count;
  if (count !== ids.length) throw new Error('分类中包含不存在或已删除的数据');
}

function replaceBrandTypes(database: DatabaseSync, brandId: number, ids: number[], userId: number): void {
  const normalized = uniqueIds(ids);
  assertTypeIds(database, normalized);
  database.prepare('DELETE FROM brand_type_relations WHERE brand_id = ?').run(brandId);
  const insert = database.prepare('INSERT INTO brand_type_relations (brand_id, type_id, created_by) VALUES (?, ?, ?)');
  for (const typeId of normalized) insert.run(brandId, typeId, userId);
  audit(database, 'relation', brandId, userId, 'relate', { relation: 'brand_types', type_ids: normalized });
}

function replaceBrandCompanies(
  database: DatabaseSync,
  brandId: number,
  relations: Array<z.infer<typeof companyRelationSchema>>,
  userId: number,
): void {
  const normalized = new Map<string, z.infer<typeof companyRelationSchema>>();
  for (const item of relations) normalized.set(`${item.company_id}:${item.relation_type}`, item);
  for (const item of normalized.values()) {
    if (!activeCompany(database, item.company_id)) throw new Error(`工商主体 ${item.company_id} 不存在或已删除`);
  }
  database.prepare('DELETE FROM brand_company_relations WHERE brand_id = ?').run(brandId);
  const insert = database.prepare(`
    INSERT INTO brand_company_relations (brand_id, company_id, relation_type, created_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const item of normalized.values()) insert.run(brandId, item.company_id, item.relation_type, userId);
  audit(database, 'relation', brandId, userId, 'relate', {
    relation: 'brand_companies',
    companies: [...normalized.values()],
  });
}

function upsertResource(database: DatabaseSync, input: z.infer<typeof resourceInputSchema>, userId: number): number {
  const now = nowDatetime();
  if (input.id) {
    if (!activeResource(database, input.id)) throw new Error(`网址资源 ${input.id} 不存在或已删除`);
    database.prepare(`
      UPDATE resource_links
      SET resource_type = ?, platform = ?, title = ?, url = ?, first_collected_at = ?, note = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND is_deleted = 0
    `).run(
      input.resource_type, input.platform, input.title, input.url, input.first_collected_at,
      input.note, userId, now, input.id,
    );
    audit(database, 'resource', input.id, userId, 'update', input as unknown as Record<string, unknown>);
    return input.id;
  }

  const existing = database.prepare('SELECT id FROM resource_links WHERE lower(trim(url)) = lower(trim(?)) AND is_deleted = 0')
    .get(input.url) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = database.prepare(`
    INSERT INTO resource_links
      (resource_type, platform, title, url, first_collected_at, note, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.resource_type, input.platform, input.title, input.url, input.first_collected_at,
    input.note, userId, userId,
  );
  const resourceId = Number(result.lastInsertRowid);
  audit(database, 'resource', resourceId, userId, 'create', input as unknown as Record<string, unknown>);
  return resourceId;
}

function syncEntityResources(
  database: DatabaseSync,
  entity: 'brand' | 'company',
  entityId: number,
  resources: Array<z.infer<typeof resourceInputSchema>>,
  userId: number,
): void {
  const relationTable = entity === 'brand' ? 'brand_resource_relations' : 'company_resource_relations';
  const entityColumn = entity === 'brand' ? 'brand_id' : 'company_id';
  const ids = resources.map((resource) => upsertResource(database, resource, userId));
  const normalized = uniqueIds(ids);
  database.prepare(`DELETE FROM ${relationTable} WHERE ${entityColumn} = ?`).run(entityId);
  const insert = database.prepare(`
    INSERT INTO ${relationTable} (${entityColumn}, resource_id, created_by) VALUES (?, ?, ?)
  `);
  for (const resourceId of normalized) insert.run(entityId, resourceId, userId);
  audit(database, 'relation', entityId, userId, 'relate', {
    relation: `${entity}_resources`, resource_ids: normalized,
  });
}

function getBrandDetail(database: DatabaseSync, brandId: number) {
  const brand = database.prepare(`
    SELECT b.*, cu.name AS creator_name, uu.name AS updater_name
    FROM brands b
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users uu ON uu.id = b.updated_by
    WHERE b.id = ? AND b.is_deleted = 0
  `).get(brandId) as Record<string, unknown> | undefined;
  if (!brand) return null;

  return {
    ...brand,
    types: database.prepare(`
      SELECT bt.* FROM brand_types bt
      JOIN brand_type_relations btr ON btr.type_id = bt.id
      WHERE btr.brand_id = ? AND bt.is_deleted = 0
      ORDER BY bt.sort_order, bt.name
    `).all(brandId),
    companies: database.prepare(`
      SELECT c.*, bcr.relation_type
      FROM companies c
      JOIN brand_company_relations bcr ON bcr.company_id = c.id
      WHERE bcr.brand_id = ? AND c.is_deleted = 0
      ORDER BY c.name, bcr.relation_type
    `).all(brandId),
    resources: database.prepare(`
      SELECT r.* FROM resource_links r
      JOIN brand_resource_relations brr ON brr.resource_id = r.id
      WHERE brr.brand_id = ? AND r.is_deleted = 0
      ORDER BY CASE r.resource_type
        WHEN 'official_website' THEN 1 WHEN 'business_info' THEN 2
        WHEN 'recruitment' THEN 3 WHEN 'ecommerce_shop' THEN 4 ELSE 5 END,
        r.platform, r.id
    `).all(brandId),
    leads: database.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.phone, l.wechat, l.source, l.status,
             l.intent_level, l.owner_id, l.created_at, l.updated_at, u.name AS owner_name
      FROM leads l
      JOIN lead_brand_relations lbr ON lbr.lead_id = l.id
      LEFT JOIN users u ON u.id = l.owner_id
      WHERE lbr.brand_id = ? AND l.is_deleted = 0
      ORDER BY l.updated_at DESC, l.id DESC
      LIMIT 100
    `).all(brandId),
    audit_logs: database.prepare(`
      SELECT a.*, u.name AS user_name
      FROM brand_audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'brand' AND a.entity_id = ?
      ORDER BY a.created_at DESC, a.id DESC LIMIT 50
    `).all(brandId),
  };
}

function getCompanyDetail(database: DatabaseSync, companyId: number) {
  const company = database.prepare(`
    SELECT c.*, cu.name AS creator_name, uu.name AS updater_name
    FROM companies c
    LEFT JOIN users cu ON cu.id = c.created_by
    LEFT JOIN users uu ON uu.id = c.updated_by
    WHERE c.id = ? AND c.is_deleted = 0
  `).get(companyId) as Record<string, unknown> | undefined;
  if (!company) return null;

  return {
    ...company,
    brands: database.prepare(`
      SELECT b.*, bcr.relation_type
      FROM brands b JOIN brand_company_relations bcr ON bcr.brand_id = b.id
      WHERE bcr.company_id = ? AND b.is_deleted = 0
      ORDER BY b.name, bcr.relation_type
    `).all(companyId),
    resources: database.prepare(`
      SELECT r.* FROM resource_links r
      JOIN company_resource_relations crr ON crr.resource_id = r.id
      WHERE crr.company_id = ? AND r.is_deleted = 0
      ORDER BY r.resource_type, r.platform, r.id
    `).all(companyId),
    leads: database.prepare(`
      SELECT l.id, l.company_name, l.contact_name, l.phone, l.wechat, l.source, l.status,
             l.intent_level, l.owner_id, l.created_at, l.updated_at, u.name AS owner_name
      FROM leads l JOIN lead_company_relations lcr ON lcr.lead_id = l.id
      LEFT JOIN users u ON u.id = l.owner_id
      WHERE lcr.company_id = ? AND l.is_deleted = 0
      ORDER BY l.updated_at DESC, l.id DESC LIMIT 100
    `).all(companyId),
    audit_logs: database.prepare(`
      SELECT a.*, u.name AS user_name
      FROM brand_audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'company' AND a.entity_id = ?
      ORDER BY a.created_at DESC, a.id DESC LIMIT 50
    `).all(companyId),
  };
}

function duplicateMessage(error: unknown): string | null {
  if (!(error instanceof Error) || !/UNIQUE constraint failed/.test(error.message)) return null;
  if (/brands/.test(error.message) || /idx_brands_name_active/.test(error.message)) return '品牌名称已存在';
  if (/idx_companies_credit_active/.test(error.message)) return '统一社会信用代码已存在';
  if (/companies/.test(error.message) || /idx_companies_name_active/.test(error.message)) return '工商主体名称已存在';
  if (/resource_links/.test(error.message) || /idx_resource_links_url_active/.test(error.message)) return '该网址已经录入';
  if (/brand_types/.test(error.message)) return '同级分类名称已存在';
  return '数据已存在';
}

function typeTree(rows: Array<Record<string, unknown>>) {
  const map = new Map<number, Record<string, unknown> & { children: unknown[] }>();
  for (const row of rows) map.set(Number(row.id), { ...row, children: [] });
  const roots: Array<Record<string, unknown> & { children: unknown[] }> = [];
  for (const node of map.values()) {
    const parentId = node.parent_id == null ? null : Number(node.parent_id);
    const parent = parentId == null ? undefined : map.get(parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function wouldCreateTypeCycle(database: DatabaseSync, typeId: number, parentId: number | null): boolean {
  if (parentId == null) return false;
  if (parentId === typeId) return true;
  const descendants = database.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM brand_types WHERE parent_id = ? AND is_deleted = 0
      UNION ALL
      SELECT bt.id FROM brand_types bt JOIN descendants d ON bt.parent_id = d.id
      WHERE bt.is_deleted = 0
    ) SELECT id FROM descendants
  `).all(typeId) as Array<{ id: number }>;
  return descendants.some((row) => row.id === parentId);
}

function getOrCreateBrand(database: DatabaseSync, name: string, userId: number, collectedAt: string): number {
  const existing = database.prepare('SELECT id FROM brands WHERE lower(trim(name)) = lower(trim(?)) AND is_deleted = 0')
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = database.prepare(`
    INSERT INTO brands (name, first_collected_at, created_by, updated_by) VALUES (?, ?, ?, ?)
  `).run(name, collectedAt, userId, userId);
  const id = Number(result.lastInsertRowid);
  audit(database, 'brand', id, userId, 'import', { name });
  return id;
}

function getOrCreateCompany(database: DatabaseSync, data: {
  name: string;
  credit: string | null;
  legalRepresentative: string | null;
  registeredCapital: string | null;
  registeredAddress: string | null;
  businessStatus: string | null;
  establishedAt: string | null;
  collectedAt: string;
}, userId: number): number {
  const existing = database.prepare('SELECT id FROM companies WHERE lower(trim(name)) = lower(trim(?)) AND is_deleted = 0')
    .get(data.name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = database.prepare(`
    INSERT INTO companies
      (name, unified_social_credit_code, legal_representative, registered_capital,
       registered_address, business_status, established_at, first_collected_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, data.credit, data.legalRepresentative, data.registeredCapital,
    data.registeredAddress, data.businessStatus, data.establishedAt, data.collectedAt, userId, userId,
  );
  const id = Number(result.lastInsertRowid);
  audit(database, 'company', id, userId, 'import', { name: data.name });
  return id;
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && value && 'text' in value) return String((value as { text: unknown }).text ?? '').trim();
  if (typeof value === 'object' && value && 'hyperlink' in value) return String((value as { hyperlink: unknown }).hyperlink ?? '').trim();
  return String(value).trim();
}

export async function brandDomainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/brand-domain/summary', { preHandler: authenticate }, async (_request, reply) => {
    const database = getDb();
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM brands WHERE is_deleted = 0) AS brands,
        (SELECT COUNT(*) FROM companies WHERE is_deleted = 0) AS companies,
        (SELECT COUNT(*) FROM resource_links WHERE resource_type = 'official_website' AND is_deleted = 0) AS websites,
        (SELECT COUNT(*) FROM resource_links WHERE resource_type = 'ecommerce_shop' AND is_deleted = 0) AS ecommerce,
        (SELECT COUNT(*) FROM resource_links WHERE resource_type = 'recruitment' AND is_deleted = 0) AS recruitment,
        (SELECT COUNT(*) FROM lead_brand_relations lbr JOIN leads l ON l.id=lbr.lead_id WHERE l.is_deleted=0) AS linked_leads
    `).get();
    return reply.send({ code: 0, msg: 'ok', data: counts });
  });

  app.get('/api/brands', { preHandler: authenticate }, async (request, reply) => {
    const parsed = brandListSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const query = parsed.data;
    const database = getDb();
    const conditions = ['b.is_deleted = 0'];
    const params: SQLInputValue[] = [];
    if (query.keyword) {
      const keyword = `%${query.keyword}%`;
      conditions.push(`(
        b.name LIKE ? OR b.english_name LIKE ? OR b.alias LIKE ?
        OR EXISTS (SELECT 1 FROM brand_company_relations x JOIN companies c ON c.id=x.company_id
          WHERE x.brand_id=b.id AND c.is_deleted=0 AND c.name LIKE ?)
        OR EXISTS (SELECT 1 FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
          WHERE x.brand_id=b.id AND r.is_deleted=0 AND (r.url LIKE ? OR r.title LIKE ?))
      )`);
      params.push(keyword, keyword, keyword, keyword, keyword, keyword);
    }
    if (query.status) { conditions.push('b.status = ?'); params.push(query.status); }
    if (query.type_id) {
      conditions.push('EXISTS (SELECT 1 FROM brand_type_relations x WHERE x.brand_id=b.id AND x.type_id=?)');
      params.push(query.type_id);
    }
    if (query.platform) {
      conditions.push(`EXISTS (SELECT 1 FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
        WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.platform=?)`);
      params.push(query.platform);
    }
    if (query.resource_type) {
      conditions.push(`EXISTS (SELECT 1 FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
        WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type=?)`);
      params.push(query.resource_type);
    }
    if (query.collected_from) { conditions.push('b.first_collected_at >= ?'); params.push(query.collected_from); }
    if (query.collected_to) { conditions.push('b.first_collected_at <= ?'); params.push(query.collected_to); }
    if (query.tab === 'linked_leads') conditions.push('EXISTS (SELECT 1 FROM lead_brand_relations x JOIN leads l ON l.id=x.lead_id WHERE x.brand_id=b.id AND l.is_deleted=0)');
    if (query.tab === 'missing_website') conditions.push(`NOT EXISTS (SELECT 1 FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
      WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='official_website')`);
    if (query.tab === 'missing_company') conditions.push('NOT EXISTS (SELECT 1 FROM brand_company_relations x JOIN companies c ON c.id=x.company_id WHERE x.brand_id=b.id AND c.is_deleted=0)');
    if (query.tab === 'has_recruitment') conditions.push(`EXISTS (SELECT 1 FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
      WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='recruitment')`);

    const where = conditions.join(' AND ');
    const total = (database.prepare(`SELECT COUNT(*) AS count FROM brands b WHERE ${where}`).get(...params) as { count: number }).count;
    const offset = (query.page - 1) * query.pageSize;
    const list = database.prepare(`
      SELECT b.*, u.name AS creator_name,
        (SELECT GROUP_CONCAT(bt.name, ' / ') FROM brand_type_relations x JOIN brand_types bt ON bt.id=x.type_id
          WHERE x.brand_id=b.id AND bt.is_deleted=0) AS type_names,
        (SELECT GROUP_CONCAT(c.name, '；') FROM brand_company_relations x JOIN companies c ON c.id=x.company_id
          WHERE x.brand_id=b.id AND c.is_deleted=0) AS company_names,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
          WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='official_website') AS website_count,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
          WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='recruitment') AS recruitment_count,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id
          WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='ecommerce_shop') AS ecommerce_count,
        (SELECT COUNT(*) FROM lead_brand_relations x JOIN leads l ON l.id=x.lead_id
          WHERE x.brand_id=b.id AND l.is_deleted=0) AS lead_count
      FROM brands b LEFT JOIN users u ON u.id=b.created_by
      WHERE ${where}
      ORDER BY b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?
    `).all(...params, query.pageSize, offset);
    return reply.send({ code: 0, msg: 'ok', data: { total, page: query.page, pageSize: query.pageSize, list } });
  });

  app.post('/api/brands', { preHandler: authenticate }, async (request, reply) => {
    const parsed = brandCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const data = parsed.data;
    const database = getDb();
    try {
      const brandId = transaction(database, () => {
        const result = database.prepare(`
          INSERT INTO brands (name, english_name, alias, description, status, first_collected_at, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          data.name, data.english_name, data.alias, data.description, data.status,
          data.first_collected_at, request.user.id, request.user.id,
        );
        const id = Number(result.lastInsertRowid);
        if (data.type_ids) replaceBrandTypes(database, id, data.type_ids, request.user.id);
        if (data.company_relations) replaceBrandCompanies(database, id, data.company_relations, request.user.id);
        if (data.resources) syncEntityResources(database, 'brand', id, data.resources, request.user.id);
        audit(database, 'brand', id, request.user.id, 'create', data as unknown as Record<string, unknown>);
        return id;
      });
      return reply.send({ code: 0, msg: '品牌创建成功', data: { id: brandId } });
    } catch (error) {
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      if (error instanceof Error && /不存在|已删除|分类/.test(error.message)) return reply.code(400).send({ code: 1, msg: error.message, data: null });
      throw error;
    }
  });

  app.get('/api/brands/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '品牌ID不合法', data: null });
    const detail = getBrandDetail(getDb(), id);
    if (!detail) return reply.code(404).send({ code: 1, msg: '品牌不存在', data: null });
    return reply.send({ code: 0, msg: 'ok', data: detail });
  });

  app.patch('/api/brands/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '品牌ID不合法', data: null });
    const parsed = brandUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ code: 1, msg: '没有要更新的字段', data: null });
    const database = getDb();
    if (!activeBrand(database, id)) return reply.code(404).send({ code: 1, msg: '品牌不存在', data: null });
    try {
      transaction(database, () => {
        const scalarFields = ['name', 'english_name', 'alias', 'description', 'status', 'first_collected_at'] as const;
        const fields: string[] = [];
        const values: SQLInputValue[] = [];
        for (const field of scalarFields) {
          if (field in parsed.data) { fields.push(`${field} = ?`); values.push(parsed.data[field] ?? null); }
        }
        if (fields.length) {
          values.push(request.user.id, nowDatetime(), id);
          database.prepare(`UPDATE brands SET ${fields.join(', ')}, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0`).run(...values);
        }
        if (parsed.data.type_ids) replaceBrandTypes(database, id, parsed.data.type_ids, request.user.id);
        if (parsed.data.company_relations) replaceBrandCompanies(database, id, parsed.data.company_relations, request.user.id);
        if (parsed.data.resources) syncEntityResources(database, 'brand', id, parsed.data.resources, request.user.id);
        audit(database, 'brand', id, request.user.id, 'update', parsed.data as unknown as Record<string, unknown>);
      });
      return reply.send({ code: 0, msg: '品牌更新成功', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      if (error instanceof Error && /不存在|已删除|分类/.test(error.message)) return reply.code(400).send({ code: 1, msg: error.message, data: null });
      throw error;
    }
  });

  app.delete('/api/brands/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '品牌ID不合法', data: null });
    const database = getDb();
    const result = database.prepare('UPDATE brands SET is_deleted=1, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0')
      .run(request.user.id, nowDatetime(), id);
    if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '品牌不存在', data: null });
    audit(database, 'brand', id, request.user.id, 'delete');
    return reply.send({ code: 0, msg: '品牌已移入回收状态', data: null });
  });

  app.post('/api/brands/:id/restore', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '品牌ID不合法', data: null });
    const database = getDb();
    try {
      const result = database.prepare('UPDATE brands SET is_deleted=0, updated_by=?, updated_at=? WHERE id=? AND is_deleted=1')
        .run(request.user.id, nowDatetime(), id);
      if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '没有可恢复的品牌', data: null });
      audit(database, 'brand', id, request.user.id, 'restore');
      return reply.send({ code: 0, msg: '品牌已恢复', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      return reply.code(409).send({ code: 1, msg: msg || '存在同名品牌，无法恢复', data: null });
    }
  });

  app.get('/api/companies', { preHandler: authenticate }, async (request, reply) => {
    const parsed = companyListSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const query = parsed.data;
    const database = getDb();
    const conditions = ['c.is_deleted=0'];
    const params: SQLInputValue[] = [];
    if (query.keyword) {
      const keyword = `%${query.keyword}%`;
      conditions.push(`(c.name LIKE ? OR c.unified_social_credit_code LIKE ? OR c.legal_representative LIKE ? OR c.registered_address LIKE ?)`);
      params.push(keyword, keyword, keyword, keyword);
    }
    if (query.business_status) { conditions.push('c.business_status=?'); params.push(query.business_status); }
    if (query.collected_from) { conditions.push('c.first_collected_at>=?'); params.push(query.collected_from); }
    if (query.collected_to) { conditions.push('c.first_collected_at<=?'); params.push(query.collected_to); }
    const where = conditions.join(' AND ');
    const total = (database.prepare(`SELECT COUNT(*) AS count FROM companies c WHERE ${where}`).get(...params) as { count: number }).count;
    const offset = (query.page - 1) * query.pageSize;
    const list = database.prepare(`
      SELECT c.*, u.name AS creator_name,
        (SELECT GROUP_CONCAT(b.name, '；') FROM brand_company_relations x JOIN brands b ON b.id=x.brand_id
          WHERE x.company_id=c.id AND b.is_deleted=0) AS brand_names,
        (SELECT COUNT(*) FROM lead_company_relations x JOIN leads l ON l.id=x.lead_id
          WHERE x.company_id=c.id AND l.is_deleted=0) AS lead_count,
        (SELECT COUNT(*) FROM company_resource_relations x JOIN resource_links r ON r.id=x.resource_id
          WHERE x.company_id=c.id AND r.is_deleted=0) AS resource_count
      FROM companies c LEFT JOIN users u ON u.id=c.created_by
      WHERE ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?
    `).all(...params, query.pageSize, offset);
    return reply.send({ code: 0, msg: 'ok', data: { total, page: query.page, pageSize: query.pageSize, list } });
  });

  app.post('/api/companies', { preHandler: authenticate }, async (request, reply) => {
    const parsed = companyCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const data = parsed.data;
    const database = getDb();
    try {
      const companyId = transaction(database, () => {
        const result = database.prepare(`
          INSERT INTO companies
            (name, unified_social_credit_code, legal_representative, registered_capital,
             registered_address, business_status, established_at, business_scope, description,
             first_collected_at, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          data.name, data.unified_social_credit_code, data.legal_representative, data.registered_capital,
          data.registered_address, data.business_status, data.established_at, data.business_scope,
          data.description, data.first_collected_at, request.user.id, request.user.id,
        );
        const id = Number(result.lastInsertRowid);
        if (data.resources) syncEntityResources(database, 'company', id, data.resources, request.user.id);
        audit(database, 'company', id, request.user.id, 'create', data as unknown as Record<string, unknown>);
        return id;
      });
      return reply.send({ code: 0, msg: '工商主体创建成功', data: { id: companyId } });
    } catch (error) {
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      throw error;
    }
  });

  app.get('/api/companies/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '工商主体ID不合法', data: null });
    const detail = getCompanyDetail(getDb(), id);
    if (!detail) return reply.code(404).send({ code: 1, msg: '工商主体不存在', data: null });
    return reply.send({ code: 0, msg: 'ok', data: detail });
  });

  app.patch('/api/companies/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '工商主体ID不合法', data: null });
    const parsed = companyUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ code: 1, msg: '没有要更新的字段', data: null });
    const database = getDb();
    if (!activeCompany(database, id)) return reply.code(404).send({ code: 1, msg: '工商主体不存在', data: null });
    try {
      transaction(database, () => {
        const scalarFields = [
          'name', 'unified_social_credit_code', 'legal_representative', 'registered_capital',
          'registered_address', 'business_status', 'established_at', 'business_scope',
          'description', 'first_collected_at',
        ] as const;
        const fields: string[] = [];
        const values: SQLInputValue[] = [];
        for (const field of scalarFields) {
          if (field in parsed.data) { fields.push(`${field}=?`); values.push(parsed.data[field] ?? null); }
        }
        if (fields.length) {
          values.push(request.user.id, nowDatetime(), id);
          database.prepare(`UPDATE companies SET ${fields.join(', ')}, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0`).run(...values);
        }
        if (parsed.data.resources) syncEntityResources(database, 'company', id, parsed.data.resources, request.user.id);
        audit(database, 'company', id, request.user.id, 'update', parsed.data as unknown as Record<string, unknown>);
      });
      return reply.send({ code: 0, msg: '工商主体更新成功', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      throw error;
    }
  });

  app.delete('/api/companies/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '工商主体ID不合法', data: null });
    const database = getDb();
    const result = database.prepare('UPDATE companies SET is_deleted=1, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0')
      .run(request.user.id, nowDatetime(), id);
    if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '工商主体不存在', data: null });
    audit(database, 'company', id, request.user.id, 'delete');
    return reply.send({ code: 0, msg: '工商主体已移入回收状态', data: null });
  });

  app.post('/api/companies/:id/restore', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '工商主体ID不合法', data: null });
    const database = getDb();
    try {
      const result = database.prepare('UPDATE companies SET is_deleted=0, updated_by=?, updated_at=? WHERE id=? AND is_deleted=1')
        .run(request.user.id, nowDatetime(), id);
      if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '没有可恢复的工商主体', data: null });
      audit(database, 'company', id, request.user.id, 'restore');
      return reply.send({ code: 0, msg: '工商主体已恢复', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      return reply.code(409).send({ code: 1, msg: msg || '存在同名工商主体，无法恢复', data: null });
    }
  });

  app.get('/api/brand-types', { preHandler: authenticate }, async (_request, reply) => {
    const rows = getDb().prepare(`
      SELECT bt.*,
        (SELECT COUNT(*) FROM brand_type_relations x JOIN brands b ON b.id=x.brand_id
          WHERE x.type_id=bt.id AND b.is_deleted=0) AS brand_count
      FROM brand_types bt WHERE bt.is_deleted=0 ORDER BY bt.sort_order, bt.name, bt.id
    `).all() as Array<Record<string, unknown>>;
    return reply.send({ code: 0, msg: 'ok', data: { list: rows, tree: typeTree(rows) } });
  });

  app.post('/api/brand-types', { preHandler: authenticate }, async (request, reply) => {
    const parsed = typeCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const database = getDb();
    if (parsed.data.parent_id && !database.prepare('SELECT id FROM brand_types WHERE id=? AND is_deleted=0').get(parsed.data.parent_id)) {
      return reply.code(400).send({ code: 1, msg: '父级分类不存在', data: null });
    }
    try {
      const result = database.prepare(`
        INSERT INTO brand_types (parent_id, name, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?)
      `).run(parsed.data.parent_id ?? null, parsed.data.name, parsed.data.sort_order, request.user.id, request.user.id);
      const id = Number(result.lastInsertRowid);
      audit(database, 'brand_type', id, request.user.id, 'create', parsed.data as unknown as Record<string, unknown>);
      return reply.send({ code: 0, msg: '分类创建成功', data: { id } });
    } catch (error) {
      const msg = duplicateMessage(error);
      return reply.code(409).send({ code: 1, msg: msg || '分类创建失败', data: null });
    }
  });

  app.patch('/api/brand-types/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '分类ID不合法', data: null });
    const parsed = typeUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const database = getDb();
    if (!database.prepare('SELECT id FROM brand_types WHERE id=? AND is_deleted=0').get(id)) return reply.code(404).send({ code: 1, msg: '分类不存在', data: null });
    const parentId = 'parent_id' in parsed.data ? parsed.data.parent_id ?? null : undefined;
    if (parentId !== undefined) {
      if (parentId && !database.prepare('SELECT id FROM brand_types WHERE id=? AND is_deleted=0').get(parentId)) return reply.code(400).send({ code: 1, msg: '父级分类不存在', data: null });
      if (wouldCreateTypeCycle(database, id, parentId)) return reply.code(400).send({ code: 1, msg: '分类层级不能形成循环', data: null });
    }
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    for (const field of ['name', 'parent_id', 'sort_order'] as const) {
      if (field in parsed.data) { fields.push(`${field}=?`); values.push(parsed.data[field] ?? null); }
    }
    if (!fields.length) return reply.code(400).send({ code: 1, msg: '没有要更新的字段', data: null });
    values.push(request.user.id, nowDatetime(), id);
    try {
      database.prepare(`UPDATE brand_types SET ${fields.join(', ')}, updated_by=?, updated_at=? WHERE id=?`).run(...values);
      audit(database, 'brand_type', id, request.user.id, 'update', parsed.data as unknown as Record<string, unknown>);
      return reply.send({ code: 0, msg: '分类更新成功', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      return reply.code(409).send({ code: 1, msg: msg || '分类更新失败', data: null });
    }
  });

  app.delete('/api/brand-types/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '分类ID不合法', data: null });
    const database = getDb();
    const children = database.prepare('SELECT id FROM brand_types WHERE parent_id=? AND is_deleted=0 LIMIT 1').get(id);
    if (children) return reply.code(409).send({ code: 1, msg: '请先处理子分类', data: null });
    const related = database.prepare(`SELECT 1 FROM brand_type_relations x JOIN brands b ON b.id=x.brand_id
      WHERE x.type_id=? AND b.is_deleted=0 LIMIT 1`).get(id);
    if (related) return reply.code(409).send({ code: 1, msg: '该分类仍被品牌使用，不能删除', data: null });
    const result = database.prepare('UPDATE brand_types SET is_deleted=1, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0')
      .run(request.user.id, nowDatetime(), id);
    if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '分类不存在', data: null });
    audit(database, 'brand_type', id, request.user.id, 'delete');
    return reply.send({ code: 0, msg: '分类已删除', data: null });
  });

  app.post('/api/resource-links', { preHandler: authenticate }, async (request, reply) => {
    const schema = resourceInputSchema.extend({
      brand_ids: z.array(positiveId).max(100).optional(),
      company_ids: z.array(positiveId).max(100).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const database = getDb();
    try {
      const id = transaction(database, () => {
        const resourceId = upsertResource(database, parsed.data, request.user.id);
        const brandIds = uniqueIds(parsed.data.brand_ids);
        const companyIds = uniqueIds(parsed.data.company_ids);
        for (const brandId of brandIds) {
          if (!activeBrand(database, brandId)) throw new Error(`品牌 ${brandId} 不存在或已删除`);
          database.prepare('INSERT OR IGNORE INTO brand_resource_relations (brand_id, resource_id, created_by) VALUES (?, ?, ?)')
            .run(brandId, resourceId, request.user.id);
        }
        for (const companyId of companyIds) {
          if (!activeCompany(database, companyId)) throw new Error(`工商主体 ${companyId} 不存在或已删除`);
          database.prepare('INSERT OR IGNORE INTO company_resource_relations (company_id, resource_id, created_by) VALUES (?, ?, ?)')
            .run(companyId, resourceId, request.user.id);
        }
        return resourceId;
      });
      return reply.send({ code: 0, msg: '网址资源保存成功', data: { id } });
    } catch (error) {
      if (error instanceof Error && /不存在|已删除/.test(error.message)) return reply.code(400).send({ code: 1, msg: error.message, data: null });
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      throw error;
    }
  });

  app.patch('/api/resource-links/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '网址资源ID不合法', data: null });
    const parsed = resourceInputSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ code: 1, msg: '没有要更新的字段', data: null });
    const database = getDb();
    if (!activeResource(database, id)) return reply.code(404).send({ code: 1, msg: '网址资源不存在', data: null });
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    for (const field of ['resource_type', 'platform', 'title', 'url', 'first_collected_at', 'note'] as const) {
      if (field in parsed.data) { fields.push(`${field}=?`); values.push(parsed.data[field] ?? null); }
    }
    values.push(request.user.id, nowDatetime(), id);
    try {
      database.prepare(`UPDATE resource_links SET ${fields.join(', ')}, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0`).run(...values);
      audit(database, 'resource', id, request.user.id, 'update', parsed.data as unknown as Record<string, unknown>);
      return reply.send({ code: 0, msg: '网址资源更新成功', data: null });
    } catch (error) {
      const msg = duplicateMessage(error);
      if (msg) return reply.code(409).send({ code: 1, msg, data: null });
      throw error;
    }
  });

  app.delete('/api/resource-links/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = idParam((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ code: 1, msg: '网址资源ID不合法', data: null });
    const database = getDb();
    const result = database.prepare('UPDATE resource_links SET is_deleted=1, updated_by=?, updated_at=? WHERE id=? AND is_deleted=0')
      .run(request.user.id, nowDatetime(), id);
    if (result.changes !== 1) return reply.code(404).send({ code: 1, msg: '网址资源不存在', data: null });
    audit(database, 'resource', id, request.user.id, 'delete');
    return reply.send({ code: 0, msg: '网址资源已删除', data: null });
  });

  app.get('/api/leads/:id/brand-relations', { preHandler: authenticate }, async (request, reply) => {
    const leadId = idParam((request.params as { id: string }).id);
    if (!leadId) return reply.code(400).send({ code: 1, msg: '线索ID不合法', data: null });
    const database = getDb();
    if (!database.prepare('SELECT id FROM leads WHERE id=? AND is_deleted=0').get(leadId)) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    const brands = database.prepare(`SELECT b.* FROM brands b JOIN lead_brand_relations x ON x.brand_id=b.id
      WHERE x.lead_id=? AND b.is_deleted=0 ORDER BY b.name`).all(leadId);
    const companies = database.prepare(`SELECT c.* FROM companies c JOIN lead_company_relations x ON x.company_id=c.id
      WHERE x.lead_id=? AND c.is_deleted=0 ORDER BY c.name`).all(leadId);
    return reply.send({ code: 0, msg: 'ok', data: { brands, companies } });
  });

  app.put('/api/leads/:id/brand-relations', { preHandler: authenticate }, async (request, reply) => {
    const leadId = idParam((request.params as { id: string }).id);
    if (!leadId) return reply.code(400).send({ code: 1, msg: '线索ID不合法', data: null });
    const schema = z.object({
      brand_ids: z.array(positiveId).max(100).default([]),
      company_ids: z.array(positiveId).max(100).default([]),
      sync_company_name: z.boolean().default(false),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const database = getDb();
    const lead = database.prepare('SELECT id, owner_id FROM leads WHERE id=? AND is_deleted=0').get(leadId) as { id: number; owner_id: number | null } | undefined;
    if (!lead) return reply.code(404).send({ code: 1, msg: '线索不存在', data: null });
    if (request.user.role !== 'admin' && lead.owner_id !== request.user.id) return reply.code(403).send({ code: 1, msg: '无权限修改他人线索关联', data: null });
    const brandIds = uniqueIds(parsed.data.brand_ids);
    const companyIds = uniqueIds(parsed.data.company_ids);
    try {
      transaction(database, () => {
        for (const brandId of brandIds) if (!activeBrand(database, brandId)) throw new Error(`品牌 ${brandId} 不存在或已删除`);
        for (const companyId of companyIds) if (!activeCompany(database, companyId)) throw new Error(`工商主体 ${companyId} 不存在或已删除`);
        database.prepare('DELETE FROM lead_brand_relations WHERE lead_id=?').run(leadId);
        database.prepare('DELETE FROM lead_company_relations WHERE lead_id=?').run(leadId);
        const insertBrand = database.prepare('INSERT INTO lead_brand_relations (lead_id, brand_id, created_by) VALUES (?, ?, ?)');
        const insertCompany = database.prepare('INSERT INTO lead_company_relations (lead_id, company_id, created_by) VALUES (?, ?, ?)');
        for (const brandId of brandIds) insertBrand.run(leadId, brandId, request.user.id);
        for (const companyId of companyIds) insertCompany.run(leadId, companyId, request.user.id);
        if (parsed.data.sync_company_name) {
          const display = brandIds.length
            ? (database.prepare('SELECT name FROM brands WHERE id=?').get(brandIds[0]) as { name: string }).name
            : companyIds.length
              ? (database.prepare('SELECT name FROM companies WHERE id=?').get(companyIds[0]) as { name: string }).name
              : null;
          database.prepare('UPDATE leads SET company_name=?, updated_at=? WHERE id=?').run(display, nowDatetime(), leadId);
        }
        audit(database, 'relation', leadId, request.user.id, 'relate', {
          relation: 'lead_brand_domain', brand_ids: brandIds, company_ids: companyIds,
        });
      });
      return reply.send({ code: 0, msg: '线索关联已更新', data: null });
    } catch (error) {
      if (error instanceof Error && /不存在|已删除/.test(error.message)) return reply.code(400).send({ code: 1, msg: error.message, data: null });
      throw error;
    }
  });

  app.get('/api/brand-domain/lookup', { preHandler: authenticate }, async (request, reply) => {
    const parsed = z.object({ keyword: z.string().trim().max(200).default('') }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    const keyword = `%${parsed.data.keyword}%`;
    const database = getDb();
    const brands = database.prepare('SELECT id, name, english_name FROM brands WHERE is_deleted=0 AND name LIKE ? ORDER BY name LIMIT 30').all(keyword);
    const companies = database.prepare('SELECT id, name, unified_social_credit_code FROM companies WHERE is_deleted=0 AND name LIKE ? ORDER BY name LIMIT 30').all(keyword);
    const leads = database.prepare(`SELECT l.id, l.company_name, l.contact_name, l.phone, l.status, u.name AS owner_name
      FROM leads l LEFT JOIN users u ON u.id=l.owner_id
      WHERE l.is_deleted=0 AND (l.company_name LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ?)
      ORDER BY l.updated_at DESC LIMIT 30`).all(keyword, keyword, keyword);
    return reply.send({ code: 0, msg: 'ok', data: { brands, companies, leads } });
  });

  app.get('/api/brand-domain/import-template', { preHandler: authenticate }, async (_request, reply) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('品牌数据导入模板');
    sheet.columns = [
      '品牌名称', '英文名', '别名', '品牌分类', '工商主体', '关系类型', '统一社会信用代码',
      '法定代表人', '注册资本', '注册地址', '经营状态', '成立日期', '官网', '招聘网址',
      '工商信息网址', '电商店铺', '电商平台', '首次采集时间',
    ].map((header) => ({ header, width: 20 }));
    sheet.addRow([
      '森屿女装', 'SENYU', '森屿', '消费品/服装/女装', '杭州森屿服饰有限公司', '实际运营方',
      '91330100XXXXXXXXXX', '林晓', '500万元人民币', '浙江省杭州市余杭区文一西路88号',
      '存续', '2020-06-18', 'https://www.example.com', 'https://www.example.com/jobs',
      'https://www.gsxt.gov.cn/example', 'https://shop.example.com', '天猫', todayDate(),
    ]);
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="brand_domain_import_template.xlsx"');
    return reply.send(Buffer.from(buffer));
  });

  app.post('/api/brand-domain/import', { preHandler: authenticate }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ code: 1, msg: '请上传文件', data: null });
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);
    const workbook = new ExcelJS.Workbook();
    if (file.filename.toLowerCase().endsWith('.csv')) await workbook.csv.read(Readable.from(buffer));
    else await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return reply.code(400).send({ code: 1, msg: '文件内容为空', data: null });
    const headerMap = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, col) => headerMap.set(cellText(cell.value), col));
    if (!headerMap.has('品牌名称')) return reply.code(400).send({ code: 1, msg: '缺少“品牌名称”列', data: null });

    const database = getDb();
    const errors: Array<{ row: number; reason: string }> = [];
    let success = 0;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const value = (name: string) => cellText(row.getCell(headerMap.get(name) ?? 0).value);
      const brandName = value('品牌名称');
      if (!brandName) continue;
      const collectedAt = DATE_PATTERN.test(value('首次采集时间')) ? value('首次采集时间') : todayDate();
      try {
        transaction(database, () => {
          const brandId = getOrCreateBrand(database, brandName, request.user.id, collectedAt);
          const englishName = value('英文名');
          const alias = value('别名');
          if (englishName || alias) database.prepare('UPDATE brands SET english_name=COALESCE(NULLIF(?,\'\'),english_name), alias=COALESCE(NULLIF(?,\'\'),alias), updated_by=?, updated_at=? WHERE id=?')
            .run(englishName, alias, request.user.id, nowDatetime(), brandId);

          const companyName = value('工商主体');
          let companyId: number | null = null;
          if (companyName) {
            companyId = getOrCreateCompany(database, {
              name: companyName,
              credit: value('统一社会信用代码') || null,
              legalRepresentative: value('法定代表人') || null,
              registeredCapital: value('注册资本') || null,
              registeredAddress: value('注册地址') || null,
              businessStatus: value('经营状态') || null,
              establishedAt: DATE_PATTERN.test(value('成立日期')) ? value('成立日期') : null,
              collectedAt,
            }, request.user.id);
            const relation = BRAND_RELATION_TYPES.includes(value('关系类型') as typeof BRAND_RELATION_TYPES[number])
              ? value('关系类型') as typeof BRAND_RELATION_TYPES[number] : '其他';
            database.prepare(`INSERT OR IGNORE INTO brand_company_relations
              (brand_id,company_id,relation_type,created_by) VALUES (?,?,?,?)`)
              .run(brandId, companyId, relation, request.user.id);
          }

          const categoryPath = value('品牌分类').split('/').map((part) => part.trim()).filter(Boolean);
          let parentId: number | null = null;
          for (const category of categoryPath) {
            let type = database.prepare('SELECT id FROM brand_types WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND lower(trim(name))=lower(trim(?)) AND is_deleted=0')
              .get(parentId, category) as { id: number } | undefined;
            if (!type) {
              const result = database.prepare('INSERT INTO brand_types (parent_id,name,created_by,updated_by) VALUES (?,?,?,?)')
                .run(parentId, category, request.user.id, request.user.id);
              type = { id: Number(result.lastInsertRowid) };
            }
            parentId = type.id;
          }
          if (parentId) database.prepare('INSERT OR IGNORE INTO brand_type_relations (brand_id,type_id,created_by) VALUES (?,?,?)')
            .run(brandId, parentId, request.user.id);

          const links: Array<{ type: typeof RESOURCE_TYPES[number]; url: string; platform: string | null; title: string }> = [
            { type: 'official_website', url: value('官网'), platform: '官网', title: `${brandName}官网` },
            { type: 'recruitment', url: value('招聘网址'), platform: null, title: `${brandName}招聘` },
            { type: 'business_info', url: value('工商信息网址'), platform: null, title: `${companyName || brandName}工商信息` },
            { type: 'ecommerce_shop', url: value('电商店铺'), platform: value('电商平台') || null, title: `${brandName}${value('电商平台') || '电商'}店铺` },
          ];
          for (const link of links) {
            if (!link.url) continue;
            const resourceId = upsertResource(database, {
              resource_type: link.type, url: link.url, platform: link.platform, title: link.title,
              first_collected_at: collectedAt, note: null,
            }, request.user.id);
            database.prepare('INSERT OR IGNORE INTO brand_resource_relations (brand_id,resource_id,created_by) VALUES (?,?,?)')
              .run(brandId, resourceId, request.user.id);
            if (companyId && link.type === 'business_info') database.prepare('INSERT OR IGNORE INTO company_resource_relations (company_id,resource_id,created_by) VALUES (?,?,?)')
              .run(companyId, resourceId, request.user.id);
          }
        });
        success += 1;
      } catch (error) {
        errors.push({ row: rowNumber, reason: error instanceof Error ? (duplicateMessage(error) || error.message) : '未知错误' });
      }
    }
    return reply.send({ code: 0, msg: '导入完成', data: { success, failed: errors.length, errors } });
  });

  app.get('/api/brand-domain/export', { preHandler: authenticate }, async (_request, reply) => {
    const database = getDb();
    const workbook = new ExcelJS.Workbook();
    const brandSheet = workbook.addWorksheet('品牌');
    brandSheet.columns = [
      'ID', '品牌名称', '英文名', '别名', '状态', '分类', '关联工商主体', '官网数', '招聘链接数',
      '电商店铺数', '关联线索数', '首次采集时间', '创建人', '创建时间', '更新时间',
    ].map((header) => ({ header, width: 20 }));
    const brands = database.prepare(`
      SELECT b.*,u.name creator_name,
        (SELECT GROUP_CONCAT(bt.name,' / ') FROM brand_type_relations x JOIN brand_types bt ON bt.id=x.type_id WHERE x.brand_id=b.id AND bt.is_deleted=0) types,
        (SELECT GROUP_CONCAT(c.name,'；') FROM brand_company_relations x JOIN companies c ON c.id=x.company_id WHERE x.brand_id=b.id AND c.is_deleted=0) companies,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='official_website') websites,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='recruitment') recruitment,
        (SELECT COUNT(*) FROM brand_resource_relations x JOIN resource_links r ON r.id=x.resource_id WHERE x.brand_id=b.id AND r.is_deleted=0 AND r.resource_type='ecommerce_shop') ecommerce,
        (SELECT COUNT(*) FROM lead_brand_relations x JOIN leads l ON l.id=x.lead_id WHERE x.brand_id=b.id AND l.is_deleted=0) leads
      FROM brands b LEFT JOIN users u ON u.id=b.created_by WHERE b.is_deleted=0 ORDER BY b.id
    `).all() as Array<Record<string, unknown>>;
    for (const b of brands) brandSheet.addRow([
      b.id,b.name,b.english_name,b.alias,b.status,b.types,b.companies,b.websites,b.recruitment,b.ecommerce,b.leads,
      b.first_collected_at,b.creator_name,b.created_at,b.updated_at,
    ]);
    brandSheet.getRow(1).font = { bold: true };

    const companySheet = workbook.addWorksheet('工商主体');
    companySheet.columns = [
      'ID','企业名称','统一社会信用代码','法定代表人','注册资本','注册地址','经营状态','成立日期','经营范围',
      '首次采集时间','创建时间','更新时间',
    ].map((header) => ({ header, width: 22 }));
    const companies = database.prepare('SELECT * FROM companies WHERE is_deleted=0 ORDER BY id').all() as Array<Record<string, unknown>>;
    for (const c of companies) companySheet.addRow([
      c.id,c.name,c.unified_social_credit_code,c.legal_representative,c.registered_capital,c.registered_address,
      c.business_status,c.established_at,c.business_scope,c.first_collected_at,c.created_at,c.updated_at,
    ]);
    companySheet.getRow(1).font = { bold: true };

    const resourceSheet = workbook.addWorksheet('网址资源');
    resourceSheet.columns = ['ID','资源类型','平台','标题','网址','首次采集时间','备注','关联品牌','关联工商主体']
      .map((header) => ({ header, width: 24 }));
    const resources = database.prepare(`
      SELECT r.*,
        (SELECT GROUP_CONCAT(b.name,'；') FROM brand_resource_relations x JOIN brands b ON b.id=x.brand_id WHERE x.resource_id=r.id AND b.is_deleted=0) brands,
        (SELECT GROUP_CONCAT(c.name,'；') FROM company_resource_relations x JOIN companies c ON c.id=x.company_id WHERE x.resource_id=r.id AND c.is_deleted=0) companies
      FROM resource_links r WHERE r.is_deleted=0 ORDER BY r.id
    `).all() as Array<Record<string, unknown>>;
    for (const r of resources) resourceSheet.addRow([
      r.id,r.resource_type,r.platform,r.title,r.url,r.first_collected_at,r.note,r.brands,r.companies,
    ]);
    resourceSheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    const date = todayDate();
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="brand_domain_${date}.xlsx"`);
    return reply.send(Buffer.from(buffer));
  });
}
