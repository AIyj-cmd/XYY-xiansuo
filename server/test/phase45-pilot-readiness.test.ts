import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DeepSeekProvider } from '../src/ai/providers/deepseek-provider.js';
import { systemPrompt } from '../src/ai/prompt.js';
import { dailyReportOutputSchema, scheduledFollowOutputSchema } from '../src/ai/output-schemas.js';
import { resolveAiConfig, resolveAiDryRunConfig } from '../src/config.js';
import { configureConnection, openReadOnlyDatabase, runMigrations } from '../src/db.js';
import { buildAiDryRunReport, runAiDryRunCli } from '../src/cli/ai-dry-run.js';
import { aiIdempotencyKey } from '../src/ai/audit-store.js';
import { inspectPilotQueue } from '../src/pilot-queue-check.js';
import { generateScheduled } from '../src/ai/service.js';
import { todayDate } from '../src/utils/datetime.js';

function open(): DatabaseSync { const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true }); configureConnection(db); runMigrations(db, undefined, { log() {} }); return db; }
const scheduled = { title: '提醒', summary: '请处理', items: [{ item_ref: 'L1', reason: '已到期', suggested_focus: '确认进展' }], closing: '以实际为准' };
const daily = { title: '日报', summary: '摘要', highlights: ['重点'], actions: ['处理'], closing: '以实际为准' };
const sha = (filename: string) => existsSync(filename) ? createHash('sha256').update(readFileSync(filename)).digest('hex') : null;
const stamp = (filename: string) => existsSync(filename) ? { hash: sha(filename), size: statSync(filename).size, mtimeMs: statSync(filename).mtimeMs } : null;
function fixedExample(prompt: string): unknown {
  const marker = '固定安全示例（虚构值，仅说明格式）：\n'; const start = prompt.indexOf(marker);
  assert.notEqual(start, -1); return JSON.parse(prompt.slice(start + marker.length));
}

test('阶段4.5：两类 Provider 请求固定 JSON 契约，显式禁用思考和工具', async () => {
  for (const [feature, schema, valid, pii] of [
    ['scheduled_follow_overdue', scheduledFollowOutputSchema, scheduled, '13800000000'],
    ['daily_report', dailyReportOutputSchema, daily, 'wxid_private'],
  ] as const) {
    let body: any;
    const provider = new DeepSeekProvider({ apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'configured-model', maxOutputTokens: 1024 }, async (_url, init) => {
      body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] }));
    });
    await provider.generateStructured({ feature, systemPrompt: systemPrompt(feature), context: { private: pii, items: [{ item_ref: 'L1' }] }, outputSchema: schema, timeoutMs: 1000, requestId: 'request', signal: new AbortController().signal });
    assert.deepEqual(body.response_format, { type: 'json_object' }); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.stream, false); assert.equal(body.max_tokens, 1024);
    assert.equal('tools' in body, false); assert.equal('tool_choice' in body, false); assert.ok(body.messages[0].content.includes('JSON')); assert.ok(body.messages[0].content.includes('固定安全示例')); assert.equal(body.messages[0].content.includes(pii), false);
    assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)), ['untrusted_business_data']);
    const example = schema.parse(fixedExample(systemPrompt(feature))) as Record<string, unknown>;
    assert.deepEqual(Object.keys(example).sort(), feature === 'scheduled_follow_overdue' ? ['closing', 'items', 'summary', 'title'] : ['actions', 'closing', 'highlights', 'summary', 'title']);
    if (feature === 'scheduled_follow_overdue') assert.deepEqual(Object.keys((example.items as Array<Record<string, unknown>>)[0]).sort(), ['item_ref', 'reason', 'suggested_focus']);
  }
  assert.ok(systemPrompt('scheduled_follow_overdue').includes('只能引用本次输入'));
  assert.ok(systemPrompt('daily_report').includes('不得生成、修改、重写或推断确定性 metrics'));
});

test('阶段4.5：AI_MAX_OUTPUT_TOKENS 严格范围，异常 Provider 输出一律拒绝', async (t) => {
  assert.equal(resolveAiConfig({}).maxOutputTokens, 2048);
  for (const raw of ['', '1.5', '255', '4097', 'abc']) assert.throws(() => resolveAiConfig({ AI_MAX_OUTPUT_TOKENS: raw }), /AI_MAX_OUTPUT_TOKENS/);
  assert.deepEqual(resolveAiDryRunConfig({ AI_MAX_OUTPUT_TOKENS: 'invalid-but-provider-only' }), { maxContextChars: 12000, maxFollowUpRecords: 3 });
  const invalid = [
    { choices: [] }, { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: '   ' } }] },
    { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(daily) } }] }, { choices: [{ finish_reason: 'content_filter', message: { content: JSON.stringify(daily) } }] },
    { choices: [{ finish_reason: 'insufficient_system_resource', message: { content: JSON.stringify(daily) } }] }, { choices: [{ message: { content: JSON.stringify(daily), tool_calls: [{}] } }] },
    { choices: [{ message: { content: '```json\n{}\n```' } }] }, { choices: [{ message: { content: JSON.stringify({ ...daily, extra: true }) } }] },
  ];
  for (const [index, response] of invalid.entries()) await t.test(`拒绝异常输出 ${index}`, async () => {
    const provider = new DeepSeekProvider({ apiKey: 'key', baseUrl: 'https://example.invalid', model: 'model' }, async () => new Response(JSON.stringify(response)));
    await assert.rejects(() => provider.generateStructured({ feature: 'daily_report', systemPrompt: systemPrompt('daily_report'), context: {}, outputSchema: dailyReportOutputSchema, timeoutMs: 1000, requestId: 'r', signal: new AbortController().signal }), (error: any) => ['AI_RESPONSE_INVALID', 'AI_OUTPUT_REJECTED'].includes(error?.code));
  });
});

test('阶段4.5：Schema 通过后仍拒绝未知或重复 item_ref 以及敏感内容', async () => {
  const config = resolveAiConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'key', DEEPSEEK_MODEL: 'model', DEEPSEEK_BASE_URL: 'https://example.invalid', AI_FALLBACK_ENABLED: 'false' });
  const item = { item_ref: 'L1', lead_id: 1, name: '脱敏名称', status: '跟进中', source: '官网', intent_level: '高', demand: '', last_follow_at: null, next_follow_at: '2026-08-01 08:00:00', follow_ups: [] };
  for (const output of [
    { ...scheduled, items: [{ ...scheduled.items[0], item_ref: 'L2' }] },
    { ...scheduled, items: [scheduled.items[0], scheduled.items[0]] },
    { ...scheduled, summary: 'api_1234567890123456' },
  ]) {
    const provider = { async generateStructured() { return { data: output, provider: 'fake' as const, model: 'fake', latencyMs: 1 }; } };
    await assert.rejects(() => generateScheduled(config, provider, 'request', {}, [item]), (error: any) => error?.code === 'AI_OUTPUT_REJECTED');
  }
});

test('阶段4.5：dry-run 使用 SQLite 真只读连接，不产生 WAL/SHM/迁移或业务写入，并给出实际排序证据', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xiansuo-phase45-readonly-')); const filename = path.join(directory, 'pilot.db');
  const writable = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(writable); runMigrations(writable, undefined, { log() {} });
  writable.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('member','成员','hash','member')").run();
  writable.prepare("INSERT INTO leads(contact_name,phone,wechat,source,demand_note,lead_date,status,owner_id,intent_level,next_follow_at,last_follow_at) VALUES ('晚','13800000000','wxid_private','官网','私密全文','2026-01-01','跟进中',1,'低','2026-08-01 09:00:00','2026-07-30 10:00:00'),('早','13900000000','wxid_other','官网','另一私密全文','2026-01-01','跟进中',1,'高','2026-08-01 08:00:00','2026-07-31 10:00:00')").run();
  writable.close();
  const before = [filename, `${filename}-wal`, `${filename}-shm`].map(stamp);
  const check = openReadOnlyDatabase(filename); const tableCountBefore = check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table'").get(); const migrationBefore = check.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(); const aiBefore = check.prepare('SELECT COUNT(*) AS count FROM ai_request_logs').get(); const notificationBefore = check.prepare('SELECT COUNT(*) AS count FROM notification_logs').get();
  const report = buildAiDryRunReport(check, { job: 'scheduled_follow_overdue', userId: 1, businessDate: '2026-08-01', maxContextChars: 12000, maxFollowUpRecords: 3 }) as any;
  assert.deepEqual(report.sorted_candidates.map((item: any) => item.internal_lead_id), [2, 1]); assert.equal(report.sorted_candidates[0].rank, 1); assert.equal(report.sorted_candidates[0].item_ref, 'L1'); assert.equal(JSON.stringify(report).includes('13800000000'), false); assert.equal(JSON.stringify(report).includes('wxid'), false); assert.throws(() => check.prepare("INSERT INTO users(username,name,password_hash) VALUES ('no','no','no')").run()); assert.throws(() => check.prepare('UPDATE users SET name=\'x\'').run());
  assert.deepEqual(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table'").get(), tableCountBefore); assert.deepEqual(check.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(), migrationBefore); assert.deepEqual(check.prepare('SELECT COUNT(*) AS count FROM ai_request_logs').get(), aiBefore); assert.deepEqual(check.prepare('SELECT COUNT(*) AS count FROM notification_logs').get(), notificationBefore); check.close();
  assert.deepEqual([filename, `${filename}-wal`, `${filename}-shm`].map(stamp), before);
});

test('阶段4.5：dry-run CLI 缺省业务日期安全回退今日，缺少必填参数仍拒绝', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xiansuo-phase45-cli-date-')); const filename = path.join(directory, 'pilot.db'); const date = todayDate();
  const writable = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(writable); runMigrations(writable, undefined, { log() {} });
  writable.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('member','成员','hash','member')").run();
  writable.prepare("INSERT INTO leads(contact_name,source,lead_date,status,owner_id,next_follow_at) VALUES ('线索','官网',?,'跟进中',1,?)").run(date, `${date} 08:00:00`); writable.close();
  const output: string[] = []; const log = console.log; console.log = (value: unknown) => { output.push(String(value)); };
  try {
    runAiDryRunCli(['node', 'ai-dry-run.ts', '--job', 'scheduled_follow_overdue', '--user-id', '1'], filename);
  } finally { console.log = log; }
  assert.equal(JSON.parse(output[0]).business_date, date);
  assert.throws(() => runAiDryRunCli(['node', 'ai-dry-run.ts', '--user-id', '1'], filename), /用法/);
  assert.throws(() => runAiDryRunCli(['node', 'ai-dry-run.ts', '--job', 'scheduled_follow_overdue'], filename), /用法/);
  assert.throws(() => runAiDryRunCli(['node', 'ai-dry-run.ts', '--job', 'scheduled_follow_overdue', '--user-id', '1', '--business-date'], filename), /用法/);
});

function insertTask(db: DatabaseSync, input: { eventType?: string; source?: string; operationId?: string; recipient?: number; status?: string; availableAt?: string; expiresAt?: string; leaseUntil?: string; snapshot?: object; dedupe?: string }): void {
  const recipient = input.recipient ?? 1; const eventType = input.eventType ?? 'scheduled_follow_overdue'; const snapshot = input.snapshot ?? { schema_version: 1, ...scheduled, subject_lead_ids: [1], business_date: '2026-08-01', fallback_used: true, detail_path: '/pages/notify/index' };
  const status = input.status ?? 'pending';
  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,lease_token,lease_owner,lease_until,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventType, input.source ?? 'ai_scheduler', input.operationId ?? `ai:${aiIdempotencyKey('scheduled_follow_overdue', recipient, '2026-08-01', 'self')}`, 'recipient_digest', recipient, recipient, '2026-08-01 08:30:00', input.dedupe ?? `d-${Math.random()}`, `k-${Math.random()}`, 1, '{}', '["mock"]', 'mock', JSON.stringify(snapshot), status, 3, input.availableAt ?? '2026-08-01 08:00:00', status === 'sending' ? 'lease' : null, status === 'sending' ? 'worker' : null, input.leaseUntil ?? (status === 'sending' ? '2026-08-01 08:00:00' : null), input.expiresAt ?? '2026-08-02 08:30:00');
}

test('阶段4.5：pilot 队列预检使用 Worker 同一可领取语义，覆盖 SAFE/UNSAFE 矩阵且不写库', () => {
  const db = open(); db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('pilot','试点','hash','member'),('other','其他','hash','member')").run(); db.prepare("INSERT INTO leads(contact_name,source,lead_date,status,owner_id) VALUES ('线索','官网','2026-01-01','跟进中',1)").run();
  const input = { recipientUserId: 1, eventType: 'scheduled_follow_overdue' as const, businessDate: '2026-08-01', now: '2026-08-01 08:30:00', databasePath: '/isolated/pilot.db' };
  insertTask(db, {}); const before = createHash('sha256').update(db.serialize()).digest('hex'); const safe = inspectPilotQueue(db, input) as any; assert.equal(safe.conclusion, 'SAFE'); assert.equal(safe.pilot_task_count, 1); assert.equal(createHash('sha256').update(db.serialize()).digest('hex'), before);
  insertTask(db, { dedupe: 'second-pilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'SAFE');
  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
    VALUES ('owner_changed','single_edit','owner-change','lead',1,1,1,2,2,'2026-08-01 08:00:00','owner-pending','owner-key',1,'{}','["mock"]','mock','{"title":"负责人已变更","detail_path":"/pages/leads/detail?id=1"}','pending',3,'2026-08-01 08:00:00','2026-08-02 08:00:00')`).run();
  assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='owner-pending'").run();
  insertTask(db, { recipient: 2, dedupe: 'other-user' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='other-user'").run();
  insertTask(db, { snapshot: { schema_version: 1, ...scheduled, subject_lead_ids: [1], business_date: '2026-08-02', fallback_used: true, detail_path: '/pages/notify/index' }, dedupe: 'other-day' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='other-day'").run();
  insertTask(db, { status: 'retry_wait', operationId: 'ai:other', dedupe: 'retry-nonpilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='retry-nonpilot'").run();
  insertTask(db, { status: 'sending', operationId: 'ai:other', dedupe: 'sending-nonpilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='sending-nonpilot'").run();
  insertTask(db, { recipient: 2, availableAt: '2026-08-01 09:00:00', dedupe: 'future-nonpilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'SAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='future-nonpilot'").run();
  insertTask(db, { recipient: 2, expiresAt: '2026-08-01 08:00:00', dedupe: 'expired-nonpilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'SAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='expired-nonpilot'").run();
  insertTask(db, { snapshot: {}, dedupe: 'invalid-pilot' }); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare("DELETE FROM notification_logs WHERE dedupe_key='invalid-pilot'").run();
  db.prepare('UPDATE leads SET owner_id=2 WHERE id=1').run(); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.prepare('UPDATE leads SET owner_id=1 WHERE id=1').run();
  db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(); assert.equal((inspectPilotQueue(db, input) as any).conclusion, 'UNSAFE'); db.close();
});
