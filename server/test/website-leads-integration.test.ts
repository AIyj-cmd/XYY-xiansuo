import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from 'fastify';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-website-leads-'));
const integrationToken = randomBytes(32).toString('base64url');
process.env.JWT_SECRET = randomBytes(32).toString('base64url');
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.NODE_ENV = 'test';
process.env.WEBSITE_LEAD_INGEST_TOKEN = integrationToken;

const { closeDb, getDb, initDb } = await import('../src/db.js');
const { signToken } = await import('../src/utils/jwt.js');
const { websiteLeadIntegrationRoutes } = await import('../src/routes/website-leads.js');
const { leadRoutes } = await import('../src/routes/leads.js');

initDb();
const db = getDb();
db.prepare("INSERT INTO users (username, name, password_hash, role, is_active) VALUES ('website-owner', '官网负责人', 'hash', 'member', 1)").run();
const ownerId = Number((db.prepare("SELECT id FROM users WHERE username = 'website-owner'").get() as { id: number }).id);
process.env.WEBSITE_LEAD_OWNER_ID = String(ownerId);

const app = Fastify();
await app.register(websiteLeadIntegrationRoutes);
await app.register(leadRoutes);
await app.ready();

const integrationHeaders = () => ({ authorization: `Bearer ${integrationToken}` });
const validLead = (overrides: Record<string, unknown> = {}) => ({
  name: '官网客户',
  phone: '13800138000',
  company: '官网测试公司',
  email: 'contact@example.test',
  service: '仓配服务',
  message: '请联系我了解仓配方案',
  ...overrides,
});

test('网站集成只接受独立 Bearer Token，且健康检查不泄露配置', async () => {
  const employeeToken = await signToken({ id: ownerId });
  for (const headers of [{}, { authorization: 'Basic x' }, { authorization: 'Bearer wrong-value' }, { authorization: `Bearer ${employeeToken}` }]) {
    const response = await app.inject({ method: 'POST', url: '/api/integrations/website-leads', headers, payload: validLead() });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().data, null);
  }
  const healthy = await app.inject({ method: 'GET', url: '/api/integrations/website-leads/health', headers: integrationHeaders() });
  assert.equal(healthy.statusCode, 200);
  assert.deepEqual(healthy.json(), { code: 0, msg: 'ok', data: { status: 'ok' } });
  assert.equal(healthy.body.includes(integrationToken), false);
});

test('短或空白 Integration Token 配置失败关闭，且 owner 配置在 health 与写入前校验', async () => {
  const originalToken = process.env.WEBSITE_LEAD_INGEST_TOKEN;
  const originalOwner = process.env.WEBSITE_LEAD_OWNER_ID;
  try {
    process.env.WEBSITE_LEAD_INGEST_TOKEN = ' too-short ';
    const weakToken = await app.inject({
      method: 'POST', url: '/api/integrations/website-leads',
      headers: { authorization: 'Bearer too-short' }, payload: validLead(),
    });
    assert.equal(weakToken.statusCode, 401);

    process.env.WEBSITE_LEAD_INGEST_TOKEN = originalToken;
    for (const ownerValue of ['', 'not-an-id']) {
      process.env.WEBSITE_LEAD_OWNER_ID = ownerValue;
      const health = await app.inject({
        method: 'GET', url: '/api/integrations/website-leads/health', headers: integrationHeaders(),
      });
      const create = await app.inject({
        method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(), payload: validLead(),
      });
      assert.equal(health.statusCode, 503);
      assert.equal(create.statusCode, 503);
    }
  } finally {
    process.env.WEBSITE_LEAD_INGEST_TOKEN = originalToken;
    process.env.WEBSITE_LEAD_OWNER_ID = originalOwner;
  }
});

test('网站集成完整映射、服务器负责人控制与审计来源', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/integrations/website-leads',
    headers: integrationHeaders(),
    payload: validLead({ owner_id: 999, created_by: 999 }),
  });
  assert.equal(response.statusCode, 400);

  const created = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(), payload: validLead(),
  });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json().data.duplicate, false);
  const lead = db.prepare(`
    SELECT contact_name, phone, company_name, source, source_note, demand_note, intent_level, status, owner_id, created_by, lead_date
    FROM leads WHERE id = ?
  `).get(created.json().data.id) as Record<string, unknown>;
  assert.deepEqual({ ...lead }, {
    contact_name: '官网客户', phone: '13800138000', company_name: '官网测试公司', source: '官网留言',
    source_note: '咨询服务：仓配服务\n邮箱：contact@example.test', demand_note: '请联系我了解仓配方案',
    intent_level: '未知', status: '新线索', owner_id: ownerId, created_by: ownerId,
    lead_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
  });
  const audit = db.prepare('SELECT user_id, action, source FROM audit_logs WHERE lead_id = ?').get(created.json().data.id) as Record<string, unknown>;
  assert.deepEqual({ ...audit }, { user_id: ownerId, action: 'create', source: 'website_integration' });
});

test('网站合法手机号和座机被接受且规范化，空可选字段不生成占位文本', async () => {
  const mobile = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(),
    payload: validLead({ phone: '13900139000', company: null, email: null, service: null }),
  });
  assert.equal(mobile.statusCode, 200);
  const landline = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(),
    payload: validLead({ phone: '020-12345678', email: null, service: null }),
  });
  assert.equal(landline.statusCode, 200);
  const row = db.prepare('SELECT company_name, source_note FROM leads WHERE id = ?').get(mobile.json().data.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { company_name: null, source_note: null });
  assert.equal(
    (db.prepare('SELECT phone FROM leads WHERE id = ?').get(landline.json().data.id) as { phone: string }).phone,
    '02012345678',
  );
});

test('非法或超范围 payload 稳定拒绝，重复手机号不产生第二条 lead', async () => {
  for (const payload of [
    validLead({ name: '' }), validLead({ phone: 'not-a-phone' }), validLead({ message: '' }),
    validLead({ name: '甲'.repeat(81) }), validLead({ company: 1 }), validLead({ email: 'not-an-email' }),
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(), payload });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 1);
  }
  const first = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(), payload: validLead({ phone: '13700137000' }),
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(), payload: validLead({ phone: '13700137000', message: '不覆盖旧记录' }),
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { code: 0, msg: '线索已存在', data: { duplicate: true } });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM leads WHERE phone = ?').get('13700137000') as { count: number }).count, 1);
  const formattedDuplicate = await app.inject({
    method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(),
    payload: validLead({ phone: '137 0013-7000' }),
  });
  assert.equal(formattedDuplicate.statusCode, 200);
  assert.deepEqual(formattedDuplicate.json(), { code: 0, msg: '线索已存在', data: { duplicate: true } });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM leads WHERE phone = ?').get('13700137000') as { count: number }).count, 1);
});

test('audit insert 失败时回滚 lead，并隐藏 SQLite 错误细节', async () => {
  db.exec(`
    CREATE TRIGGER website_lead_audit_failure
    BEFORE INSERT ON audit_logs
    WHEN NEW.source = 'website_integration'
    BEGIN SELECT RAISE(ABORT, 'secret-detail'); END;
  `);
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/integrations/website-leads', headers: integrationHeaders(),
      payload: validLead({ phone: '13600136000' }),
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { code: 1, msg: '线索接收失败', data: null });
    assert.equal(response.body.includes('SQLITE'), false);
    assert.equal(response.body.includes('secret-detail'), false);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM leads WHERE phone = ?').get('13600136000') as { count: number }).count, 0);
  } finally {
    db.exec('DROP TRIGGER website_lead_audit_failure');
  }
});

test('网站集成没有改变员工 JWT 线索鉴权语义', async () => {
  const employeeToken = await signToken({ id: ownerId });
  const forbidden = await app.inject({ method: 'GET', url: '/api/leads', headers: integrationHeaders() });
  assert.equal(forbidden.statusCode, 401);
  const allowed = await app.inject({ method: 'GET', url: '/api/leads', headers: { authorization: `Bearer ${employeeToken}` } });
  assert.equal(allowed.statusCode, 200);
});

test.after(async () => {
  await app.close();
  closeDb();
  rmSync(testDirectory, { recursive: true, force: true });
});
