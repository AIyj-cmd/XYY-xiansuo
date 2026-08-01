import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, configureConnection } from '../src/db.js';
import { assertSyntheticDatabaseSafety, enqueueOpenClawSyntheticPilot, isSyntheticPilotTask, openClawSyntheticPilotMessage, syntheticSnapshot } from '../src/openclaw-synthetic-pilot.js';
import { inspectPilotQueue } from '../src/pilot-queue-check.js';
import { runPilotQueueCheckCli } from '../src/cli/pilot-queue-check.js';
import { runOnce } from '../src/notification-worker.js';
import { assertSyntheticWorkerBatchSafety } from '../src/openclaw-synthetic-pilot.js';
import { claimNotificationTasks } from '../src/services/notification.js';

const key = 'openclaw-synthetic-pilot-20260801';
function privateDirectory(): string { const directory = mkdtempSync(path.join(os.tmpdir(), 'xiansuo-openclaw-synthetic-')); chmodSync(directory, 0o700); return directory; }
function databasePath(directory: string): string { return path.join(directory, 'openclaw-synthetic-pilot.db'); }
function input(directory: string, userId = 73) { return { databasePath: databasePath(directory), pilotUserId: userId, idempotencyKey: key }; }

test('synthetic 入队仅接受全新仓库外私有临时数据库与显式固定参数', () => {
  const directory = privateDirectory(); const filename = databasePath(directory);
  try {
    assert.throws(() => enqueueOpenClawSyntheticPilot({ ...input(directory), databasePath: 'relative.db' }), /ABSOLUTE/);
    assert.throws(() => enqueueOpenClawSyntheticPilot({ ...input(directory), databasePath: path.resolve('server/data/openclaw-synthetic-pilot.db') }), /REPOSITORY_FORBIDDEN/);
    assert.throws(() => enqueueOpenClawSyntheticPilot({ ...input(directory), databasePath: path.join(directory, 'other.db') }), /BASENAME/);
    chmodSync(directory, 0o755); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /DIRECTORY_PRIVATE/); chmodSync(directory, 0o700);
    writeFileSync(path.join(directory, 'unrelated.txt'), 'x'); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /NOT_FRESH/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('synthetic 入队拒绝数据库符号链接', () => {
  const directory = privateDirectory(); const target = path.join(directory, 'target.db'); const filename = databasePath(directory);
  try { writeFileSync(target, 'not-a-database'); symlinkSync(target, filename); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /ARTIFACT_UNSAFE/); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('synthetic 入队拒绝上级符号链接、hardlink 与 DB/WAL/SHM 非0600', () => {
  const directory = privateDirectory(); const parentLink = path.join(os.tmpdir(), `xiansuo-openclaw-link-${Date.now()}-${Math.random()}`);
  try {
    symlinkSync(directory, parentLink); assert.throws(() => enqueueOpenClawSyntheticPilot({ ...input(directory), databasePath: databasePath(parentLink) }), /SYMLINK_FORBIDDEN/); rmSync(parentLink);
    enqueueOpenClawSyntheticPilot(input(directory)); const filename = databasePath(directory);
    linkSync(filename, path.join(directory, 'hard-link.db')); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /ARTIFACT_UNSAFE/); rmSync(path.join(directory, 'hard-link.db'));
    chmodSync(filename, 0o644); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /ARTIFACT_UNSAFE/); chmodSync(filename, 0o600);
    for (const suffix of ['-wal', '-shm']) { writeFileSync(`${filename}${suffix}`, 'x'); chmodSync(`${filename}${suffix}`, 0o644); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /ARTIFACT_UNSAFE/); rmSync(`${filename}${suffix}`); }
  } finally { try { rmSync(parentLink); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test('synthetic 入队迁移001-007并只创建一个用户和一个严格快照任务，重复键不新增', () => {
  const directory = privateDirectory(); const filename = databasePath(directory);
  try {
    const first = enqueueOpenClawSyntheticPilot(input(directory)); assert.equal(first.result, 'created');
    const database = new DatabaseSync(filename, { readOnly: true, enableForeignKeyConstraints: true });
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row: any) => row.version);
    assert.deepEqual(versions, ['001','002','003','004','005','006','007']);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM notification_logs').get() as { count: number }).count, 1);
    const task = database.prepare(`SELECT event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,dedupe_key,delivery_idempotency_key,channel_order_snapshot_json,channel,message_snapshot_json FROM notification_logs`).get() as any;
    assert.equal(isSyntheticPilotTask(task, 73, key), true);
    assert.deepEqual(JSON.parse(task.message_snapshot_json), syntheticSnapshot(first.businessDate));
    assert.equal(JSON.stringify(task).match(/客户|联系人|手机号|微信号|需求|跟进|prompt|jwt|token|api[_ -]?key/i), null);
    database.close();
    const second = enqueueOpenClawSyntheticPilot(input(directory)); assert.deepEqual({ result: second.result, taskId: second.taskId, businessDate: second.businessDate }, { result: 'deduplicated', taskId: first.taskId, businessDate: first.businessDate });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('synthetic queue-check 连续两次 SAFE，其他可领取任务仍为 UNSAFE', () => {
  const directory = privateDirectory(); const filename = databasePath(directory);
  try {
    const created = enqueueOpenClawSyntheticPilot(input(directory));
    const args = ['node', 'pilot-queue-check.ts', '--recipient-user-id', '73', '--event-type', 'daily_report', '--business-date', created.businessDate, '--synthetic-idempotency-key', key];
    assert.equal((runPilotQueueCheckCli(args, filename) as any).conclusion, 'SAFE');
    assert.equal((runPilotQueueCheckCli(args, filename) as any).conclusion, 'SAFE');
    const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(database);
    const task = database.prepare('SELECT * FROM notification_logs').get() as any;
    database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
      VALUES ('daily_report','ai_scheduler','ai:unrelated','recipient_digest',73,73,?,?,?,1,'{}','["openclaw"]','openclaw',?,'pending',2,?,?)`).run(task.occurred_at, 'other-dedupe', 'other-delivery', task.message_snapshot_json, task.available_at, task.expires_at);
    database.close();
    assert.equal((runPilotQueueCheckCli(args, filename) as any).conclusion, 'UNSAFE');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Worker 从唯一 synthetic outbox 通过 OpenClaw Channel 到伪 Gateway，重复 run 不二发', async () => {
  const directory = privateDirectory(); const filename = databasePath(directory); const secret = path.join(directory, 'gateway.secret');
  const names = ['DB_PATH','NOTIFICATION_WORKER_ENABLED','NOTIFICATION_MOCK_ENABLED','OPENCLAW_CHANNEL_ENABLED','OPENCLAW_PILOT_USER_ID','OPENCLAW_GATEWAY_URL','OPENCLAW_GATEWAY_SECRET_FILE'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]])); const originalFetch = globalThis.fetch; const requests: any[] = [];
  try {
    enqueueOpenClawSyntheticPilot(input(directory)); writeFileSync(secret, 's'.repeat(40)); chmodSync(secret, 0o600);
    Object.assign(process.env, { DB_PATH: filename, NOTIFICATION_WORKER_ENABLED: 'true', NOTIFICATION_MOCK_ENABLED: 'false', OPENCLAW_CHANNEL_ENABLED: 'true', OPENCLAW_PILOT_USER_ID: '73', OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:39001', OPENCLAW_GATEWAY_SECRET_FILE: secret });
    globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ data: { status: 'sent', providerMessageId: 'fake-gateway-receipt' } }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
    closeDb(); await runOnce(); await runOnce(); closeDb();
    assert.equal(requests.length, 1);
    const message = openClawSyntheticPilotMessage();
    assert.deepEqual({ title: requests[0].title, body: requests[0].body, detailUrl: requests[0].detailUrl }, { title: message.title, body: message.body, detailUrl: message.detailPath });
    assert.equal(JSON.stringify(requests[0]).match(/客户|联系人|手机号|微信号|需求|跟进|prompt|jwt|token|api[_ -]?key/i), null);
    const database = new DatabaseSync(filename, { readOnly: true }); const task = database.prepare('SELECT status,attempt_count,provider_message_id FROM notification_logs').get() as any;
    assert.deepEqual({ ...task }, { status: 'sent', attempt_count: 1, provider_message_id: 'fake-gateway-receipt' }); database.close();
  } finally {
    closeDb(); globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synthetic 标记库的污染批次在两种顺序和 pending/retry_wait/可恢复 sending 下均全局阻断 Gateway', async () => {
  const names = ['DB_PATH','NOTIFICATION_WORKER_ENABLED','NOTIFICATION_MOCK_ENABLED','OPENCLAW_CHANNEL_ENABLED','OPENCLAW_PILOT_USER_ID','OPENCLAW_GATEWAY_URL','OPENCLAW_GATEWAY_SECRET_FILE'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]])); const originalFetch = globalThis.fetch;
  try {
    for (const status of ['pending', 'retry_wait', 'sending'] as const) for (const extraFirst of [true, false]) {
      const directory = privateDirectory(); const filename = databasePath(directory); const secret = path.join(directory, 'gateway.secret'); let fetchCalls = 0;
      try {
        const created = enqueueOpenClawSyntheticPilot(input(directory)); const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(db);
        const task = db.prepare('SELECT * FROM notification_logs').get() as any;
        const extraAvailableAt = extraFirst ? '2000-01-01 00:00:00' : task.available_at;
        const values = ['daily_report', 'ai_scheduler', `ai:polluted:${status}:${extraFirst}`, 'recipient_digest', 73, 73, task.occurred_at, `polluted-dedupe:${status}:${extraFirst}`, `polluted-delivery:${status}:${extraFirst}`, 1, '{}', '["openclaw"]', 'openclaw', task.message_snapshot_json, status, 2, extraAvailableAt, task.expires_at, status === 'sending' ? 'stale-lease' : null, status === 'sending' ? 'stale-worker' : null, status === 'sending' ? '2000-01-01 00:00:00' : null];
        db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at,lease_token,lease_owner,lease_until)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
        db.close(); writeFileSync(secret, 's'.repeat(40)); chmodSync(secret, 0o600);
        Object.assign(process.env, { DB_PATH: filename, NOTIFICATION_WORKER_ENABLED: 'true', NOTIFICATION_MOCK_ENABLED: 'false', OPENCLAW_CHANNEL_ENABLED: 'true', OPENCLAW_PILOT_USER_ID: '73', OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:39001', OPENCLAW_GATEWAY_SECRET_FILE: secret });
        globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('Gateway must not be called'); }) as typeof fetch;
        closeDb(); await runOnce(); closeDb(); assert.equal(fetchCalls, 0, `${status}/${extraFirst} must globally block`);
        const verify = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(verify);
        const rows = verify.prepare('SELECT status FROM notification_logs ORDER BY id').all() as Array<{ status: string }>;
        assert.deepEqual(rows.map((row) => row.status), ['pending', status], `${status}/${extraFirst} must stop before sending`);
        // Explicitly cover the second, after-claim gate: both ordering variants
        // form a two-task claimed batch, and the sealed proof still rejects it.
        const claimed = claimNotificationTasks(verify, 'synthetic-test-worker', task.occurred_at, 10, ['openclaw']);
        assert.equal(claimed.length, 2, `${status}/${extraFirst} must be a claimed batch`);
        assert.throws(() => assertSyntheticWorkerBatchSafety(verify, filename, 73, 'worker'), /OPENCLAW_SYNTHETIC/);
        verify.close();
      } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
    }
  } finally {
    closeDb(); globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('synthetic 密封门禁先于 retention cleanup，终态污染不会被删除后继续发送', async () => {
  const directory = privateDirectory(); const filename = databasePath(directory); const secret = path.join(directory, 'gateway.secret');
  const names = ['DB_PATH','NOTIFICATION_WORKER_ENABLED','NOTIFICATION_MOCK_ENABLED','OPENCLAW_CHANNEL_ENABLED','OPENCLAW_PILOT_USER_ID','OPENCLAW_GATEWAY_URL','OPENCLAW_GATEWAY_SECRET_FILE'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]])); const originalFetch = globalThis.fetch; let fetchCalls = 0;
  try {
    enqueueOpenClawSyntheticPilot(input(directory)); const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true }); configureConnection(database);
    const task = database.prepare('SELECT * FROM notification_logs').get() as any;
    database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,attempt_count,automatic_attempt_count,max_attempts,available_at,expires_at,failure_class,last_error_code,failed_at,retain_until)
      VALUES ('daily_report','ai_scheduler','ai:expired-terminal','recipient_digest',73,73,?,'expired-terminal-dedupe','expired-terminal-delivery',1,'{}','["openclaw"]','openclaw',?,'failed',1,1,2,?,?,'permanent','TEST_FAILED','2000-01-01 00:00:00','2000-01-01 00:00:00')`).run(task.occurred_at, task.message_snapshot_json, task.available_at, task.expires_at);
    database.close(); writeFileSync(secret, 's'.repeat(40)); chmodSync(secret, 0o600);
    Object.assign(process.env, { DB_PATH: filename, NOTIFICATION_WORKER_ENABLED: 'true', NOTIFICATION_MOCK_ENABLED: 'false', OPENCLAW_CHANNEL_ENABLED: 'true', OPENCLAW_PILOT_USER_ID: '73', OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:39001', OPENCLAW_GATEWAY_SECRET_FILE: secret });
    globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('Gateway must not be called'); }) as typeof fetch;
    closeDb(); await runOnce(); closeDb(); assert.equal(fetchCalls, 0);
    const verify = new DatabaseSync(filename, { readOnly: true });
    assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM notification_logs').get() as { count: number }).count, 2, 'retention cleanup must not erase contamination before the gate');
    assert.equal((verify.prepare("SELECT status FROM notification_logs WHERE operation_id='ai:expired-terminal'").get() as { status: string }).status, 'failed');
    verify.close();
  } finally {
    closeDb(); globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synthetic 密封门禁拒绝每类业务表污染、规则启用、任务篡改与外键异常', () => {
  const pollutants: Array<[string, (db: DatabaseSync) => void]> = [
    ['tags', (db) => { db.prepare("INSERT INTO tags(name) VALUES ('synthetic-tag')").run(); }],
    ['memos', (db) => { db.prepare("INSERT INTO memos(user_id,content) VALUES (73,'synthetic')").run(); }],
    ['leads', (db) => { db.prepare("INSERT INTO leads(contact_name,source,owner_id,lead_date,created_by) VALUES ('synthetic','test',73,'2026-08-01',73)").run(); }],
    ['follow_ups', (db) => { const id = Number(db.prepare("INSERT INTO leads(contact_name,source,owner_id,lead_date,created_by) VALUES ('synthetic','test',73,'2026-08-01',73)").run().lastInsertRowid); db.prepare("INSERT INTO follow_ups(lead_id,user_id,content) VALUES (?,73,'synthetic')").run(id); }],
    ['audit_logs', (db) => { const id = Number(db.prepare("INSERT INTO leads(contact_name,source,owner_id,lead_date,created_by) VALUES ('synthetic','test',73,'2026-08-01',73)").run().lastInsertRowid); db.prepare("INSERT INTO audit_logs(lead_id,user_id,action) VALUES (?,73,'synthetic')").run(id); }],
    ['favorites', (db) => { const id = Number(db.prepare("INSERT INTO leads(contact_name,source,owner_id,lead_date,created_by) VALUES ('synthetic','test',73,'2026-08-01',73)").run().lastInsertRowid); db.prepare('INSERT INTO favorites(user_id,lead_id) VALUES (73,?)').run(id); }],
    ['lead_tags', (db) => { const id = Number(db.prepare("INSERT INTO leads(contact_name,source,owner_id,lead_date,created_by) VALUES ('synthetic','test',73,'2026-08-01',73)").run().lastInsertRowid); const tag = Number(db.prepare("INSERT INTO tags(name) VALUES ('synthetic-tag')").run().lastInsertRowid); db.prepare('INSERT INTO lead_tags(lead_id,tag_id) VALUES (?,?)').run(id, tag); }],
    ['ai_request_logs', (db) => { db.prepare("INSERT INTO ai_request_logs(request_id,idempotency_key,job_type,recipient_user_id,recipient_role_snapshot,scope,business_date,prompt_version,status,available_at,retain_until) VALUES ('synthetic-request','synthetic-ai-key','daily_report',73,'member','self','2026-08-01','v','pending','2026-08-01 00:00:00','2026-09-01 00:00:00')").run(); }],
  ];
  for (const [_table, contaminate] of pollutants) {
    const directory = privateDirectory();
    try {
      enqueueOpenClawSyntheticPilot(input(directory)); const db = new DatabaseSync(databasePath(directory), { enableForeignKeyConstraints: true }); configureConnection(db); contaminate(db); db.close();
      assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /DATABASE_CONTAMINATED/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  for (const mutation of [
    "UPDATE notification_rules SET enabled=1 WHERE event_type='daily_report'",
    "UPDATE notification_logs SET channel='mock'", "UPDATE notification_logs SET rule_snapshot_json='{}'", "UPDATE notification_logs SET status='failed',failed_at=occurred_at,last_error_code='X'", "UPDATE notification_logs SET max_attempts=3",
    "UPDATE notification_logs SET lease_recovery_count=1", "UPDATE notification_logs SET management_audit_json='[{\"action\":\"manual_retry\"}]'", "UPDATE notification_logs SET row_version=9", "UPDATE notification_logs SET last_attempt_at=occurred_at", "UPDATE notification_logs SET expires_at=datetime(occurred_at,'+2 hours')",
  ]) {
    const directory = privateDirectory();
    try { enqueueOpenClawSyntheticPilot(input(directory)); const db = new DatabaseSync(databasePath(directory), { enableForeignKeyConstraints: true }); configureConnection(db); db.exec(mutation); db.close(); assert.throws(() => enqueueOpenClawSyntheticPilot(input(directory)), /(?:RULES_UNSAFE|TASK_UNSAFE)/); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const directory = privateDirectory();
  try {
    enqueueOpenClawSyntheticPilot(input(directory)); const db = new DatabaseSync(databasePath(directory), { enableForeignKeyConstraints: true }); configureConnection(db); db.exec('PRAGMA foreign_keys=OFF'); db.prepare('INSERT INTO favorites(user_id,lead_id) VALUES (73,999999)').run(); assert.throws(() => assertSyntheticDatabaseSafety(db, input(directory), 'queue'), /INTEGRITY_UNSAFE/); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
