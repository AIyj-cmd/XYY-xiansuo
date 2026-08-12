import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, configureConnection, getDb, runMigrations } from '../src/db.js';
import { resolveAiConfig } from '../src/config.js';
import { overdueLeads, getActiveRecipient } from '../src/ai/permission-query.js';
import { DeepSeekProvider } from '../src/ai/providers/deepseek-provider.js';
import { FakeAiProvider } from '../src/ai/providers/fake-provider.js';
import { scheduledFollowOutputSchema } from '../src/ai/output-schemas.js';
import { createOrGetAiLog } from '../src/ai/audit-store.js';
import { runScheduledFollow } from '../src/scheduler/jobs/scheduled-follow-overdue.js';

function open(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  configureConnection(db);
  runMigrations(db, undefined, { log() {} });
  return db;
}

test('独立配置门禁：启用 DeepSeek 时空 Base URL 必须拒绝启动', () => {
  assert.throws(
    () => resolveAiConfig({
      DEEPSEEK_ENABLED: 'true',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
      DEEPSEEK_BASE_URL: '',
    }),
    /DEEPSEEK_BASE_URL/,
  );
});

test('独立权限验证：到期提醒对 admin 也只能查询本人当前负责线索', () => {
  const db = open();
  db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('admin','管理员','hash','admin'),('member','成员','hash','member')").run();
  db.prepare("INSERT INTO leads(contact_name,source,lead_date,status,owner_id,next_follow_at) VALUES ('管理员线索','官网','2026-01-01','跟进中',1,'2026-01-02 08:00:00'),('成员线索','官网','2026-01-01','跟进中',2,'2026-01-02 08:00:00')").run();
  const admin = getActiveRecipient(db, 1)!;
  const candidates = overdueLeads(db, admin, '2026-01-03');
  assert.equal(candidates.total, 1);
  assert.deepEqual(candidates.leads.map((lead) => lead.id), [1]);
  db.close();
});

test('独立 Provider 验证：仅 429、500、503 允许 HTTP 自动重试', async () => {
  const fetch502: typeof fetch = async () => new Response('{}', { status: 502 });
  const provider = new DeepSeekProvider({ apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' }, fetch502);
  await assert.rejects(
    () => provider.generateStructured({
      feature: 'scheduled_follow_overdue',
      systemPrompt: 'fixed',
      context: { untrusted_business_data: { items: [] } },
      outputSchema: scheduledFollowOutputSchema,
      timeoutMs: 1000,
      requestId: 'test',
      signal: new AbortController().signal,
    }),
    (error: any) => error?.code === 'AI_PROVIDER_UNAVAILABLE' && error?.retryable === false,
  );
});

test('独立 Provider 验证：严格 JSON schema 仍在 mock 响应上执行', async () => {
  const fetchOk: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'x', summary: 'x', items: [], closing: 'x', extra: true }) } }] }), { status: 200 });
  const provider = new DeepSeekProvider({ apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' }, fetchOk);
  await assert.rejects(() => provider.generateStructured({ feature: 'scheduled_follow_overdue', systemPrompt: 'fixed', context: {}, outputSchema: scheduledFollowOutputSchema, timeoutMs: 1000, requestId: 'test', signal: new AbortController().signal }), (error: any) => error?.code === 'AI_OUTPUT_REJECTED');
});

test('独立恢复验证：租约恢复后的全部已发 Provider 请求必须继续计入日额度', async () => {
  const beforeCapture = process.env.NOTIFICATION_CAPTURE_ENABLED;
  const beforeMock = process.env.NOTIFICATION_MOCK_ENABLED;
  process.env.NOTIFICATION_CAPTURE_ENABLED = 'true';
  process.env.NOTIFICATION_MOCK_ENABLED = 'true';
  const db = open();
  try {
    db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('member','成员','hash','member')").run();
    db.prepare("INSERT INTO leads(contact_name,source,lead_date,status,owner_id,next_follow_at) VALUES ('线索','官网','2026-01-01','跟进中',1,'2026-01-01 08:00:00')").run();
    db.prepare("UPDATE notification_rules SET enabled=1 WHERE event_type='scheduled_follow_overdue'").run();
    const now = '2026-01-02 08:30:00';
    const log = createOrGetAiLog(db, { job: 'scheduled_follow_overdue', recipientUserId: 1, role: 'member', scope: 'self', businessDate: '2026-01-02', now, retentionDays: 90 });
    db.prepare("UPDATE ai_request_logs SET status='generating', attempt_count=1, lease_token='old', lease_owner='old', lease_until='2026-01-02 08:29:00' WHERE id=?").run(log.id);
    const config = resolveAiConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: 'test-model', DEEPSEEK_BASE_URL: 'https://example.invalid', AI_SCHEDULED_FOLLOW_ENABLED: 'true', AI_PILOT_USER_IDS: '1' });
    const provider = new FakeAiProvider(() => ({ title: '提醒', summary: '请处理', items: [{ item_ref: 'L1', reason: '已到期', suggested_focus: '确认进展' }], closing: '以实际为准' }));
    await runScheduledFollow(db, config, provider, getActiveRecipient(db, 1)!, '2026-01-02', now);
    assert.equal((db.prepare('SELECT attempt_count FROM ai_request_logs WHERE id=?').get(log.id) as { attempt_count: number }).attempt_count, 2);
  } finally {
    if (beforeCapture === undefined) delete process.env.NOTIFICATION_CAPTURE_ENABLED; else process.env.NOTIFICATION_CAPTURE_ENABLED = beforeCapture;
    if (beforeMock === undefined) delete process.env.NOTIFICATION_MOCK_ENABLED; else process.env.NOTIFICATION_MOCK_ENABLED = beforeMock;
    db.close();
  }
});

test('独立管理 API 验证：实时 admin、分页筛选且不泄露结果或上下文', { concurrency: false }, async () => {
  const old = { db: process.env.DB_PATH, jwt: process.env.JWT_SECRET, password: process.env.ADMIN_INITIAL_PASSWORD, username: process.env.ADMIN_INITIAL_USERNAME, name: process.env.ADMIN_INITIAL_NAME };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xiansuo-phase4-api-'));
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.JWT_SECRET = 'phase-four-independent-api-secret-at-least-32-bytes';
  process.env.ADMIN_INITIAL_PASSWORD = 'phase-four-initial-password';
  process.env.ADMIN_INITIAL_USERNAME = 'phase4-admin';
  process.env.ADMIN_INITIAL_NAME = '阶段四管理员';
  closeDb();
  let app: any;
  try {
    const { buildApp } = await import('../src/index.js');
    app = await buildApp();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'phase4-admin', password: 'phase-four-initial-password' } });
    const adminToken = login.json().data.token as string;
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { username: 'phase4-member', name: '阶段四成员', password: 'phase-four-member-password', role: 'member' } });
    const memberId = created.json().data.id as number;
    const memberLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'phase4-member', password: 'phase-four-member-password' } });
    const memberToken = memberLogin.json().data.token as string;
    getDb().prepare("INSERT INTO ai_request_logs(request_id,idempotency_key,job_type,recipient_user_id,recipient_role_snapshot,scope,business_date,prompt_version,status,available_at,retain_until,error_code,error_summary) VALUES ('api-request','api-idempotency','daily_report',?,'member','self','2026-01-02','phase4-v1','failed','2026-01-02 18:00:00','2026-04-02 18:00:00','AI_OUTPUT_REJECTED','safe summary')").run(memberId);
    const denied = await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } });
    assert.equal(denied.statusCode, 403);
    const allowed = await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs?status=failed&page=1&pageSize=20', headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(allowed.statusCode, 200);
    const row = allowed.json().data.list[0];
    assert.equal(allowed.json().data.total, 1);
    assert.equal(row.error_code, 'AI_OUTPUT_REJECTED');
    assert.equal(Object.hasOwn(row, 'result_snapshot_json'), false);
    assert.equal(Object.hasOwn(row, 'context'), false);
    getDb().prepare("UPDATE users SET role='admin' WHERE id=?").run(memberId);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } })).statusCode, 200);
    getDb().prepare("UPDATE users SET role='member' WHERE id=?").run(memberId);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } })).statusCode, 403);
  } finally {
    await app?.close();
    closeDb();
    if (old.db === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = old.db;
    if (old.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old.jwt;
    if (old.password === undefined) delete process.env.ADMIN_INITIAL_PASSWORD; else process.env.ADMIN_INITIAL_PASSWORD = old.password;
    if (old.username === undefined) delete process.env.ADMIN_INITIAL_USERNAME; else process.env.ADMIN_INITIAL_USERNAME = old.username;
    if (old.name === undefined) delete process.env.ADMIN_INITIAL_NAME; else process.env.ADMIN_INITIAL_NAME = old.name;
  }
});
