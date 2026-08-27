import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-brand-domain-'));
process.env.JWT_SECRET = 'brand-domain-test-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.NODE_ENV = 'test';
process.env.POOL_IDLE_DAYS = '7';

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { ensureBrandSchema, BRAND_SCHEMA_VERSION } = await import('../src/brand-schema.js');
const { brandDomainRoutes } = await import('../src/routes/brand-domain.js');
const { signToken } = await import('../src/utils/jwt.js');

initDb();
const db = getDb();
ensureBrandSchema(db);

db.prepare(`
  INSERT INTO users (username, name, password_hash, role, is_active) VALUES
  ('admin', '管理员', 'hash', 'admin', 1),
  ('member', '业务员甲', 'hash', 'member', 1),
  ('member2', '业务员乙', 'hash', 'member', 1)
`).run();
const users = Object.fromEntries((db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>)
  .map((row) => [row.username, row.id])) as Record<string, number>;
const adminToken = await signToken({ id: users.admin });
const memberToken = await signToken({ id: users.member });
const member2Token = await signToken({ id: users.member2 });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const app = Fastify();
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
await app.register(brandDomainRoutes);
await app.ready();

function body(response: Awaited<ReturnType<typeof app.inject>>) {
  return response.json() as { code: number; msg: string; data: any };
}

test('品牌域模式持久化并保持外键完整', () => {
  const version = db.prepare('SELECT version FROM brand_schema_meta WHERE version=?').get(BRAND_SCHEMA_VERSION) as { version: number };
  assert.equal(version.version, BRAND_SCHEMA_VERSION);
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of [
    'brands', 'companies', 'brand_types', 'brand_type_relations', 'brand_company_relations',
    'resource_links', 'brand_resource_relations', 'company_resource_relations',
    'lead_brand_relations', 'lead_company_relations', 'brand_audit_logs',
  ]) assert.ok(tables.has(table), `missing table ${table}`);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('业务员可完整增删改查品牌、工商主体、分类和网址', async () => {
  const typeRoot = await app.inject({
    method: 'POST', url: '/api/brand-types', headers: bearer(memberToken),
    payload: { name: '消费品', sort_order: 1 },
  });
  assert.equal(typeRoot.statusCode, 200);
  const rootId = body(typeRoot).data.id as number;
  const typeLeaf = await app.inject({
    method: 'POST', url: '/api/brand-types', headers: bearer(memberToken),
    payload: { name: '女装', parent_id: rootId, sort_order: 1 },
  });
  assert.equal(typeLeaf.statusCode, 200);
  const leafId = body(typeLeaf).data.id as number;

  const company = await app.inject({
    method: 'POST', url: '/api/companies', headers: bearer(memberToken),
    payload: {
      name: '杭州森屿服饰有限公司',
      unified_social_credit_code: '91330100TEST000001',
      legal_representative: '林晓',
      registered_capital: '500万元人民币',
      registered_address: '浙江省杭州市余杭区文一西路88号',
      business_status: '存续',
      established_at: '2020-06-18',
      business_scope: '服装服饰零售；互联网销售。',
      first_collected_at: '2026-08-12',
      resources: [{
        resource_type: 'business_info', platform: '国家企业信用信息公示系统',
        title: '工商信息', url: 'https://example.test/company/senyu', first_collected_at: '2026-08-12',
      }],
    },
  });
  assert.equal(company.statusCode, 200);
  const companyId = body(company).data.id as number;

  const brand = await app.inject({
    method: 'POST', url: '/api/brands', headers: bearer(memberToken),
    payload: {
      name: '森屿女装', english_name: 'SENYU', alias: '森屿', status: 'active',
      first_collected_at: '2026-08-12', type_ids: [leafId],
      company_relations: [{ company_id: companyId, relation_type: '实际运营方' }],
      resources: [
        { resource_type: 'official_website', platform: '官网', title: '森屿官网', url: 'https://www.senyu.example', first_collected_at: '2026-08-12' },
        { resource_type: 'recruitment', platform: 'BOSS直聘', title: '森屿招聘', url: 'https://jobs.example/senyu', first_collected_at: '2026-08-12' },
        { resource_type: 'ecommerce_shop', platform: '天猫', title: '森屿旗舰店', url: 'https://shop.example/senyu', first_collected_at: '2026-08-12' },
      ],
    },
  });
  assert.equal(brand.statusCode, 200);
  const brandId = body(brand).data.id as number;

  const detail = await app.inject({ method: 'GET', url: `/api/brands/${brandId}`, headers: bearer(memberToken) });
  assert.equal(detail.statusCode, 200);
  assert.equal(body(detail).data.name, '森屿女装');
  assert.equal(body(detail).data.companies[0].legal_representative, '林晓');
  assert.equal(body(detail).data.companies[0].registered_capital, '500万元人民币');
  assert.equal(body(detail).data.companies[0].registered_address, '浙江省杭州市余杭区文一西路88号');
  assert.equal(body(detail).data.types[0].id, leafId);
  assert.equal(body(detail).data.resources.length, 3);

  const update = await app.inject({
    method: 'PATCH', url: `/api/brands/${brandId}`, headers: bearer(memberToken),
    payload: { description: '由业务员维护的品牌资料', status: 'inactive' },
  });
  assert.equal(update.statusCode, 200);
  assert.equal((db.prepare('SELECT status FROM brands WHERE id=?').get(brandId) as { status: string }).status, 'inactive');

  const remove = await app.inject({ method: 'DELETE', url: `/api/brands/${brandId}`, headers: bearer(memberToken) });
  assert.equal(remove.statusCode, 200);
  assert.equal((db.prepare('SELECT is_deleted FROM brands WHERE id=?').get(brandId) as { is_deleted: number }).is_deleted, 1);
  const restore = await app.inject({ method: 'POST', url: `/api/brands/${brandId}/restore`, headers: bearer(memberToken) });
  assert.equal(restore.statusCode, 200);
  assert.equal((db.prepare('SELECT is_deleted FROM brands WHERE id=?').get(brandId) as { is_deleted: number }).is_deleted, 0);
});

test('品牌、工商主体、线索均支持多对多且线索写权限不被放宽', async () => {
  const companyTwo = await app.inject({
    method: 'POST', url: '/api/companies', headers: bearer(memberToken),
    payload: { name: '杭州森屿电子商务有限公司', legal_representative: '周宁', registered_capital: '100万元人民币', registered_address: '杭州市滨江区', first_collected_at: '2026-08-13' },
  });
  const companyTwoId = body(companyTwo).data.id as number;
  const brand = db.prepare("SELECT id FROM brands WHERE name='森屿女装' AND is_deleted=0").get() as { id: number };
  const originalCompany = db.prepare("SELECT id FROM companies WHERE name='杭州森屿服饰有限公司' AND is_deleted=0").get() as { id: number };

  const updateBrand = await app.inject({
    method: 'PATCH', url: `/api/brands/${brand.id}`, headers: bearer(member2Token),
    payload: { company_relations: [
      { company_id: originalCompany.id, relation_type: '品牌所有方' },
      { company_id: companyTwoId, relation_type: '电商店铺主体' },
    ] },
  });
  assert.equal(updateBrand.statusCode, 200);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM brand_company_relations WHERE brand_id=?').get(brand.id) as { count: number }).count, 2);

  const leadOne = Number(db.prepare(`
    INSERT INTO leads (company_name,contact_name,wechat,source,status,owner_id,lead_date,created_by)
    VALUES ('森屿旧文本','张三','wx_senyu_1','小红书','新线索',?,'2026-08-14',?)
  `).run(users.member, users.member).lastInsertRowid);
  const leadTwo = Number(db.prepare(`
    INSERT INTO leads (company_name,contact_name,wechat,source,status,owner_id,lead_date,created_by)
    VALUES ('森屿另一联系人','李四','wx_senyu_2','官网','跟进中',?,'2026-08-14',?)
  `).run(users.member, users.member).lastInsertRowid);

  for (const leadId of [leadOne, leadTwo]) {
    const relation = await app.inject({
      method: 'PUT', url: `/api/leads/${leadId}/brand-relations`, headers: bearer(memberToken),
      payload: { brand_ids: [brand.id], company_ids: [originalCompany.id, companyTwoId], sync_company_name: leadId === leadOne },
    });
    assert.equal(relation.statusCode, 200);
  }
  assert.equal((db.prepare('SELECT COUNT(*) count FROM lead_brand_relations WHERE brand_id=?').get(brand.id) as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM lead_company_relations WHERE lead_id=?').get(leadOne) as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT company_name FROM leads WHERE id=?').get(leadOne) as { company_name: string }).company_name, '森屿女装');

  const forbidden = await app.inject({
    method: 'PUT', url: `/api/leads/${leadOne}/brand-relations`, headers: bearer(member2Token),
    payload: { brand_ids: [], company_ids: [] },
  });
  assert.equal(forbidden.statusCode, 403);

  const adminAllowed = await app.inject({
    method: 'PUT', url: `/api/leads/${leadOne}/brand-relations`, headers: bearer(adminToken),
    payload: { brand_ids: [brand.id], company_ids: [companyTwoId] },
  });
  assert.equal(adminAllowed.statusCode, 200);
});

test('取消某品牌的网址关联不会删除共享网址或其他品牌关系', async () => {
  const sharedUrl = 'https://shared.example/store';
  const first = await app.inject({
    method: 'POST', url: '/api/brands', headers: bearer(memberToken),
    payload: { name: '共享链接品牌甲', first_collected_at: '2026-08-15', resources: [
      { resource_type: 'ecommerce_shop', platform: '天猫', title: '共享店铺', url: sharedUrl, first_collected_at: '2026-08-15' },
    ] },
  });
  const second = await app.inject({
    method: 'POST', url: '/api/brands', headers: bearer(memberToken),
    payload: { name: '共享链接品牌乙', first_collected_at: '2026-08-15', resources: [
      { resource_type: 'ecommerce_shop', platform: '天猫', title: '共享店铺', url: sharedUrl, first_collected_at: '2026-08-15' },
    ] },
  });
  const firstId = body(first).data.id as number;
  const secondId = body(second).data.id as number;
  const resource = db.prepare('SELECT id FROM resource_links WHERE url=?').get(sharedUrl) as { id: number };
  assert.equal((db.prepare('SELECT COUNT(*) count FROM brand_resource_relations WHERE resource_id=?').get(resource.id) as { count: number }).count, 2);

  const unlink = await app.inject({
    method: 'PATCH', url: `/api/brands/${firstId}`, headers: bearer(memberToken), payload: { resources: [] },
  });
  assert.equal(unlink.statusCode, 200);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM brand_resource_relations WHERE resource_id=?').get(resource.id) as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT is_deleted FROM resource_links WHERE id=?').get(resource.id) as { is_deleted: number }).is_deleted, 0);
  assert.ok(db.prepare('SELECT 1 FROM brand_resource_relations WHERE brand_id=? AND resource_id=?').get(secondId, resource.id));
});

test('品牌分类拒绝循环层级', async () => {
  const root = await app.inject({ method: 'POST', url: '/api/brand-types', headers: bearer(memberToken), payload: { name: '循环根节点' } });
  const rootId = body(root).data.id as number;
  const child = await app.inject({ method: 'POST', url: '/api/brand-types', headers: bearer(memberToken), payload: { name: '循环子节点', parent_id: rootId } });
  const childId = body(child).data.id as number;
  const cycle = await app.inject({ method: 'PATCH', url: `/api/brand-types/${rootId}`, headers: bearer(memberToken), payload: { parent_id: childId } });
  assert.equal(cycle.statusCode, 400);
  assert.match(body(cycle).msg, /循环/);
});

test('列表、汇总和 Excel 导出可用', async () => {
  const summary = await app.inject({ method: 'GET', url: '/api/brand-domain/summary', headers: bearer(memberToken) });
  assert.equal(summary.statusCode, 200);
  assert.ok(body(summary).data.brands >= 3);
  assert.ok(body(summary).data.companies >= 2);

  const list = await app.inject({ method: 'GET', url: '/api/brands?page=1&pageSize=10&tab=linked_leads', headers: bearer(memberToken) });
  assert.equal(list.statusCode, 200);
  assert.ok(body(list).data.total >= 1);

  const exported = await app.inject({ method: 'GET', url: '/api/brand-domain/export', headers: bearer(memberToken) });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers['content-type']), /spreadsheetml/);
  assert.ok(exported.rawPayload.length > 1000);
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
