import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { resolveNotificationConfig } from '../src/config.js';
import { configureConnection, MIGRATIONS, runMigrations } from '../src/db.js';
import { openClawMessage, openClawTimeoutMs } from '../src/services/openclaw-notification-channel.js';
import { mapChannelResult, workerAbortTimeoutMs } from '../src/notification-worker.js';
import { claimNotificationTasks, finishNotificationTask } from '../src/services/notification.js';

function db(): DatabaseSync { const database = new DatabaseSync(':memory:'); configureConnection(database); return database; }
function insertTask(database: DatabaseSync, channel: 'mock' | 'openclaw', status = 'pending'): Record<string, unknown> {
  database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,lease_token,lease_owner,lease_until,expires_at)
    VALUES ('daily_report','test','op-' || ?, 'recipient_digest',1,NULL,'2026-08-01 08:00:00',?,? ,1,'{}',?,?,'{}',?,2,'2026-08-01 08:00:00',?,?,?,'2026-08-02 08:00:00')`).run(channel, `dedupe-${channel}-${status}`, `delivery-${channel}-${status}-0000`, JSON.stringify([channel]), channel, status, status === 'sending' ? 'lease-current' : null, status === 'sending' ? 'worker' : null, status === 'sending' ? '2026-08-01 08:01:00' : null);
  return database.prepare('SELECT * FROM notification_logs WHERE dedupe_key=?').get(`dedupe-${channel}-${status}`) as Record<string, unknown>;
}

test('007 rebuild preserves data/indexes and restricts notification_logs.channel to mock/openclaw/null', () => {
  assert.deepEqual(MIGRATIONS.slice(0, 7).map(({ version, checksum }) => [version, checksum]), [
    ['001', 'c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0'],
    ['002', 'db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9'],
    ['003', 'e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704'],
    ['004', '61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75'],
    ['005', '8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346'],
    ['006', 'b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a'],
    ['007', 'c09175e80d010ea056c3e93e5f4fdfc61c4b2f4c08c885d0a6b4e96b1f5242da'],
  ]);
  const database = db();
  runMigrations(database, MIGRATIONS.slice(0, 6));
  const task = insertTask(database, 'mock');
  const rowBefore = database.prepare('SELECT * FROM notification_logs WHERE id=?').get(task.id);
  const indexesBefore = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notification_logs' ORDER BY name").all();
  runMigrations(database, [MIGRATIONS[6]]);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM notification_logs').get() as { count: number }).count, 1);
  assert.deepEqual(database.prepare('SELECT * FROM notification_logs WHERE id=?').get(task.id), rowBefore);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notification_logs' ORDER BY name").all(), indexesBefore);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM notification_rules WHERE enabled != 0').get() as { count: number }).count, 0);
  assert.doesNotThrow(() => database.prepare("UPDATE notification_logs SET channel='openclaw' WHERE id=?").run(task.id));
  assert.doesNotThrow(() => database.prepare('UPDATE notification_logs SET channel=NULL WHERE id=?').run(task.id));
  assert.throws(() => database.prepare("UPDATE notification_logs SET channel='email' WHERE id=?").run(task.id));
  runMigrations(database, [MIGRATIONS[6]]);
  assert.throws(() => runMigrations(database, [{ ...MIGRATIONS[6], checksum: 'conflicting-007-checksum' }]), /校验和不匹配/);
  assert.equal((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('channel-scoped claim and result_unknown terminal mapping prevent accidental retry or cross-channel pickup', () => {
  const database = db(); runMigrations(database);
  insertTask(database, 'mock'); insertTask(database, 'openclaw');
  const claimedMock = claimNotificationTasks(database, 'worker', '2026-08-01 08:00:00', 10, ['mock']);
  assert.equal(claimedMock.length, 1); assert.equal(claimedMock[0].channel, 'mock');
  const claimedOpenClaw = claimNotificationTasks(database, 'worker', '2026-08-01 08:00:00', 10, ['openclaw']);
  assert.equal(claimedOpenClaw.length, 1); assert.equal(claimedOpenClaw[0].channel, 'openclaw');
  assert.equal(finishNotificationTask(database, claimedOpenClaw[0], { kind: 'permanent', code: 'OPENCLAW_SEND_RESULT_UNKNOWN', retryAllowed: 0 }, '2026-08-01 08:00:01'), true);
  const final = database.prepare('SELECT status,retry_allowed,last_error_code FROM notification_logs WHERE id=?').get(claimedOpenClaw[0].id) as { status: string; retry_allowed: number; last_error_code: string };
  assert.equal(final.status, 'failed'); assert.equal(final.retry_allowed, 0); assert.equal(final.last_error_code, 'OPENCLAW_SEND_RESULT_UNKNOWN');
  database.close();
});

test('OpenClaw worker configuration requires a single pilot and a 0600 secret file, while API mode does not read it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'xiansuo-openclaw-config-')); const secret = path.join(directory, 'gateway.secret');
  try {
    writeFileSync(secret, 'a'.repeat(48)); chmodSync(secret, 0o600);
    const env = { OPENCLAW_CHANNEL_ENABLED: 'true', OPENCLAW_PILOT_USER_ID: '7', OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:38115', OPENCLAW_GATEWAY_SECRET_FILE: secret };
    const apiConfig = resolveNotificationConfig(env); assert.equal(apiConfig.openclawGatewaySecret, undefined);
    const workerConfig = resolveNotificationConfig(env, { requireOpenClawSecret: true }); assert.equal(workerConfig.openclawGatewaySecret, 'a'.repeat(48));
    for (const mode of [0o400, 0o200, 0o000, 0o644]) { chmodSync(secret, mode); assert.throws(() => resolveNotificationConfig(env, { requireOpenClawSecret: true }), /精确 0600/); }
    chmodSync(secret, 0o600); const linked = path.join(directory, 'linked.secret'); symlinkSync(secret, linked); assert.throws(() => resolveNotificationConfig({ ...env, OPENCLAW_GATEWAY_SECRET_FILE: linked }, { requireOpenClawSecret: true }), /普通文件/);
    assert.throws(() => resolveNotificationConfig({ ...env, OPENCLAW_PILOT_USER_ID: '7,8' }), /正整数/);
    assert.throws(() => resolveNotificationConfig({ ...env, OPENCLAW_GATEWAY_URL: 'https://gateway.example.test' }), /回环/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OpenClaw maps every permanent outcome to a non-retryable failure and preserves only genuine deduplicated receipts', () => {
  const task = { channel: 'openclaw', delivery_idempotency_key: 'immutable-key' };
  for (const code of ['OPENCLAW_RECIPIENT_NOT_ALLOWED', 'ILINK_LOGIN_REQUIRED', 'ILINK_ACCOUNT_RESTRICTED', 'ILINK_MESSAGE_POLICY_REJECTED']) {
    assert.deepEqual(mapChannelResult(task, { status: 'permanent_failure', errorCode: code }), { kind: 'permanent', code, retryAllowed: 0 });
  }
  assert.deepEqual(mapChannelResult(task, { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }), { kind: 'permanent', code: 'OPENCLAW_SEND_RESULT_UNKNOWN', message: 'ILINK_SEND_RESULT_UNKNOWN', retryAllowed: 0 });
  assert.deepEqual(mapChannelResult(task, { status: 'deduplicated', providerMessageId: 'existing-local-receipt' }), { kind: 'sent', receipt: 'existing-local-receipt' });
  assert.deepEqual(mapChannelResult(task, { status: 'deduplicated' }), { kind: 'permanent', code: 'OPENCLAW_DEDUPLICATED_RECEIPT_MISSING', retryAllowed: 0 });
});

test('OpenClaw text templates contain no business snapshot or credential fields', () => {
  for (const event of ['owner_changed', 'scheduled_follow_overdue', 'daily_report']) {
    const message = openClawMessage(event); const visible = `${message.title}\n${message.body}\n${message.detailPath}`;
    assert.equal(message.detailPath, 'https://xs.tomatopia.top/');
    assert.equal(/客户|联系人|手机号|微信号|需求正文|跟进正文|prompt|jwt|token|api[_ -]?key/i.test(visible), false);
  }
  assert.throws(() => openClawMessage('weekly_report'), /事件未实现/);
});

test('OpenClaw owns its configured gateway timeout while Mock keeps the legacy Worker timeout', () => {
  assert.equal(openClawTimeoutMs(resolveNotificationConfig({ OPENCLAW_GATEWAY_TIMEOUT_MS: '1000' })), 1_000);
  assert.equal(openClawTimeoutMs(resolveNotificationConfig({ OPENCLAW_GATEWAY_TIMEOUT_MS: '20000' })), 20_000);
  assert.equal(workerAbortTimeoutMs('openclaw'), undefined);
  assert.equal(workerAbortTimeoutMs('mock'), 10_000);
});
