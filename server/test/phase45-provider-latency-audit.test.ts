import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { addProviderLatency, claimAiLog, createOrGetAiLog, failAiLog, reserveProviderAttempt, saveAiReady } from '../src/ai/audit-store.js';
import { generateScheduled } from '../src/ai/service.js';
import type { AiProvider } from '../src/ai/providers/provider.js';
import { resolveAiConfig } from '../src/config.js';
import { closeDb, configureConnection, getDb, MIGRATIONS, runMigrations, type Migration } from '../src/db.js';

const now = '2026-08-01 08:30:00';
const item = { item_ref: 'L1', lead_id: 1, name: '线索', status: '跟进中', source: '官网', intent_level: '高', demand: '', last_follow_at: null, next_follow_at: '2026-08-01 08:00:00', follow_ups: [] };
const output = { title: '提醒', summary: '请处理', items: [{ item_ref: 'L1', reason: '已到期', suggested_focus: '确认进展' }], closing: '以实际为准' };

function open(migrations: readonly Migration[] = MIGRATIONS): DatabaseSync {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  configureConnection(database); runMigrations(database, migrations, { log() {} }); return database;
}

function config(fallbackEnabled = true) {
  return resolveAiConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'test-only-key', DEEPSEEK_MODEL: 'fake', DEEPSEEK_BASE_URL: 'https://example.invalid', AI_FALLBACK_ENABLED: fallbackEnabled ? 'true' : 'false' });
}

function claimed(database: DatabaseSync, date = '2026-08-01') {
  database.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('member','成员','hash','member')").run();
  const log = createOrGetAiLog(database, { job: 'scheduled_follow_overdue', recipientUserId: 1, role: 'member', scope: 'self', businessDate: date, now, retentionDays: 90 });
  return claimAiLog(database, log.id, 'latency-test', now)!;
}

function provider(attempts: Array<{ latencyMs: number; retryable?: boolean; code?: string }>): AiProvider {
  let index = 0;
  return {
    async generateStructured(options: any): Promise<any> {
      const attempt = attempts[index++];
      if (attempt.code) throw Object.assign(new Error('safe provider error'), { code: attempt.code, retryable: attempt.retryable === true, latencyMs: attempt.latencyMs });
      return { data: options.outputSchema.parse(output), provider: 'fake', model: 'fake', latencyMs: attempt.latencyMs };
    },
  };
}

async function generateAndPersist(database: DatabaseSync, log: any, fake: AiProvider, fallbackEnabled = true) {
  return generateScheduled(config(fallbackEnabled), fake, log.request_id, {}, [item],
    () => reserveProviderAttempt(database, log.id, 1, '2026-08-01', 200, 4, now),
    (latencyMs) => { assert.equal(addProviderLatency(database, log.id, latencyMs, now), true); });
}

test('006 只追加 latency_ms：空库、005 升级、重复、约束、checksum 与事务回滚', () => {
  assert.deepEqual(MIGRATIONS.map((migration) => migration.version), ['001', '002', '003', '004', '005', '006']);
  assert.equal(MIGRATIONS[5].checksum, 'b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a');
  assert.deepEqual(MIGRATIONS.slice(0, 5).map((migration) => migration.checksum), [
    'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0',
    'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9',
    'e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704',
    '61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75',
    '8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346',
  ]);
  const database = open();
  assert.ok((database.prepare("PRAGMA table_info('ai_request_logs')").all() as Array<{ name: string }>).some((column) => column.name === 'latency_ms'));
  database.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('m','成员','hash','member')").run();
  const insert = database.prepare(`INSERT INTO ai_request_logs(request_id,idempotency_key,job_type,recipient_user_id,recipient_role_snapshot,scope,business_date,prompt_version,status,available_at,retain_until,latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const values = ['r-null', 'i-null', 'daily_report', 1, 'member', 'self', '2026-08-01', 'v', 'pending', now, '2026-11-01 08:30:00'];
  assert.doesNotThrow(() => insert.run(...values, null));
  assert.doesNotThrow(() => insert.run('r-int', 'i-int', ...values.slice(2), 321));
  assert.throws(() => insert.run('r-negative', 'i-negative', ...values.slice(2), -1));
  assert.throws(() => insert.run('r-float', 'i-float', ...values.slice(2), 1.5));
  assert.throws(() => insert.run('r-text', 'i-text', ...values.slice(2), 'not-a-number'));
  runMigrations(database, undefined, { log() {} });
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual((database.prepare('PRAGMA integrity_check').all() as Array<object>).map((row) => ({ ...row })), [{ integrity_check: 'ok' }]);
  assert.throws(() => runMigrations(database, [{ ...MIGRATIONS[5], checksum: 'conflicting-006-checksum' }], { log() {} }), /校验和不匹配/);
  database.close();

  const upgrade = open(MIGRATIONS.slice(0, 5));
  upgrade.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('old','历史','hash','member')").run();
  const old = createOrGetAiLog(upgrade, { job: 'daily_report', recipientUserId: 1, role: 'member', scope: 'self', businessDate: '2026-07-31', now, retentionDays: 90 });
  const before = upgrade.prepare('SELECT id,request_id FROM ai_request_logs WHERE id=?').get(old.id);
  runMigrations(upgrade, [MIGRATIONS[5]], { log() {} });
  assert.deepEqual({ ...(upgrade.prepare('SELECT id,request_id,latency_ms FROM ai_request_logs WHERE id=?').get(old.id) as any) }, { ...before, latency_ms: null });
  assert.throws(() => runMigrations(upgrade, [{ version: '007', description: 'rollback check', checksum: 'rollback-check', up(db) { db.exec('CREATE TABLE must_not_survive(id INTEGER)'); throw new Error('rollback'); } }], { log() {} }), /rollback/);
  assert.equal((upgrade.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='must_not_survive'").get() as any).count, 0);
  upgrade.close();
});

test('Provider 成功、重试、fallback、非重试、恢复和状态变化均累计且保留 latency_ms', async () => {
  const single = open(); const singleLog = claimed(single);
  const singleResult = await generateAndPersist(single, singleLog, provider([{ latencyMs: 321 }]));
  assert.equal(singleResult.providerLatencyMsTotal, 321);
  assert.equal(saveAiReady(single, singleLog, { valid: true }, { inputChars: 1, outputChars: 1, fallbackUsed: false, attempts: 1 }, now, 7), true);
  assert.equal((single.prepare('SELECT latency_ms FROM ai_request_logs WHERE id=?').get(singleLog.id) as any).latency_ms, 321);
  single.close();

  const retried = open(); const retriedLog = claimed(retried);
  const retriedResult = await generateAndPersist(retried, retriedLog, provider([{ latencyMs: 150, code: 'AI_PROVIDER_TIMEOUT', retryable: true }, { latencyMs: 240 }]));
  assert.deepEqual({ attempts: retriedResult.attempts, total: retriedResult.providerLatencyMsTotal }, { attempts: 2, total: 390 });
  assert.equal((retried.prepare('SELECT attempt_count,latency_ms FROM ai_request_logs WHERE id=?').get(retriedLog.id) as any).latency_ms, 390);
  retried.close();

  const fallback = open(); const fallbackLog = claimed(fallback);
  const fallbackResult = await generateAndPersist(fallback, fallbackLog, provider([{ latencyMs: 120, code: 'AI_PROVIDER_TIMEOUT', retryable: true }, { latencyMs: 180, code: 'AI_PROVIDER_UNAVAILABLE', retryable: true }]));
  assert.equal(fallbackResult.fallback, true); assert.equal(fallbackResult.providerLatencyMsTotal, 300);
  assert.equal(saveAiReady(fallback, fallbackLog, { valid: true }, { inputChars: 1, outputChars: 1, fallbackUsed: true, attempts: 2, errorCode: fallbackResult.errorCode }, now, 7), true);
  assert.deepEqual({ ...(fallback.prepare('SELECT fallback_used,latency_ms FROM ai_request_logs WHERE id=?').get(fallbackLog.id) as any) }, { fallback_used: 1, latency_ms: 300 });
  fallback.close();

  const rejected = open(); const rejectedLog = claimed(rejected);
  const rejectedResult = await generateAndPersist(rejected, rejectedLog, provider([{ latencyMs: 90, code: 'AI_PROVIDER_AUTH_FAILED' }]));
  assert.equal(rejectedResult.attempts, 1); assert.equal((rejected.prepare('SELECT attempt_count,latency_ms FROM ai_request_logs WHERE id=?').get(rejectedLog.id) as any).latency_ms, 90);
  failAiLog(rejected, rejectedLog.id, rejectedResult.errorCode!, now);
  assert.deepEqual({ ...(rejected.prepare('SELECT status,latency_ms FROM ai_request_logs WHERE id=?').get(rejectedLog.id) as any) }, { status: 'failed', latency_ms: 90 });
  rejected.close();

  const recovered = open(); const recoveredLog = claimed(recovered);
  recovered.prepare("UPDATE ai_request_logs SET attempt_count=1,latency_ms=110,lease_until='2026-08-01 08:29:00' WHERE id=?").run(recoveredLog.id);
  const again = claimAiLog(recovered, recoveredLog.id, 'recovery', now)!;
  const recoveredResult = await generateAndPersist(recovered, again, provider([{ latencyMs: 210 }]));
  assert.equal(recoveredResult.providerLatencyMsTotal, 210);
  assert.equal((recovered.prepare('SELECT latency_ms FROM ai_request_logs WHERE id=?').get(again.id) as any).latency_ms, 320);
  assert.equal(saveAiReady(recovered, again, { valid: true }, { inputChars: 1, outputChars: 1, fallbackUsed: false, attempts: 2 }, now, 7), true);
  assert.equal((recovered.prepare('SELECT latency_ms FROM ai_request_logs WHERE id=?').get(again.id) as any).latency_ms, 320);
  recovered.close();
});

test('未实际调用 Provider 保持 NULL，且调用前额度阻止不会伪造 0', async () => {
  const database = open(); const log = claimed(database);
  const disabled = await generateScheduled(resolveAiConfig({ DEEPSEEK_ENABLED: 'false', AI_FALLBACK_ENABLED: 'true' }), undefined, log.request_id, {}, [item]);
  assert.equal(disabled.attempts, 0);
  assert.equal((database.prepare('SELECT latency_ms FROM ai_request_logs WHERE id=?').get(log.id) as any).latency_ms, null);
  const limited = await generateScheduled(config(), provider([{ latencyMs: 999 }]), log.request_id, {}, [item], () => false, (latencyMs) => addProviderLatency(database, log.id, latencyMs, now));
  assert.equal(limited.errorCode, 'AI_DAILY_LIMIT_EXCEEDED');
  assert.equal((database.prepare('SELECT latency_ms FROM ai_request_logs WHERE id=?').get(log.id) as any).latency_ms, null);
  database.close();
});

test('admin AI 日志仅投影 latency_ms，不泄露结果，并保持实时权限', { concurrency: false }, async () => {
  const previous = { DB_PATH: process.env.DB_PATH, JWT_SECRET: process.env.JWT_SECRET, ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD, ADMIN_INITIAL_USERNAME: process.env.ADMIN_INITIAL_USERNAME, ADMIN_INITIAL_NAME: process.env.ADMIN_INITIAL_NAME };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xiansuo-phase45-latency-api-'));
  process.env.DB_PATH = path.join(directory, 'test.db'); process.env.JWT_SECRET = 'phase45-provider-latency-api-secret-at-least-32'; process.env.ADMIN_INITIAL_PASSWORD = 'phase45-provider-latency-password'; process.env.ADMIN_INITIAL_USERNAME = 'phase45-latency-admin'; process.env.ADMIN_INITIAL_NAME = '延迟审计管理员';
  closeDb(); let app: any;
  try {
    const { buildApp } = await import('../src/index.js'); app = await buildApp();
    const adminToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'phase45-latency-admin', password: 'phase45-provider-latency-password' } })).json().data.token;
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { username: 'latency-member', name: '成员', password: 'phase45-latency-member-password', role: 'member' } });
    const memberId = created.json().data.id; const memberToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'latency-member', password: 'phase45-latency-member-password' } })).json().data.token;
    getDb().prepare("INSERT INTO ai_request_logs(request_id,idempotency_key,job_type,recipient_user_id,recipient_role_snapshot,scope,business_date,prompt_version,status,available_at,retain_until,latency_ms,result_snapshot_json) VALUES ('latency-request','latency-key','daily_report',?,'member','self','2026-08-01','v','pending',?,'2026-11-01 08:30:00',428,'{\"secret\":true}')").run(memberId, now);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } })).statusCode, 403);
    const response = await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs?page=1&pageSize=20', headers: { authorization: `Bearer ${adminToken}` } });
    const row = response.json().data.list[0]; assert.equal(row.latency_ms, 428); assert.equal(Object.hasOwn(row, 'result_snapshot_json'), false); assert.equal(Object.hasOwn(row, 'context'), false);
    getDb().prepare('UPDATE users SET role=\'admin\' WHERE id=?').run(memberId); assert.equal((await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } })).statusCode, 200);
    getDb().prepare('UPDATE users SET role=\'member\' WHERE id=?').run(memberId); assert.equal((await app.inject({ method: 'GET', url: '/api/admin/ai/request-logs', headers: { authorization: `Bearer ${memberToken}` } })).statusCode, 403);
  } finally {
    await app?.close(); closeDb();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
