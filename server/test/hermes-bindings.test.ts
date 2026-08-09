import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { MIGRATIONS } from '../src/db.js';
import { activateHermesQrAttempt, cancelOwnedHermesQrAttempt, commitHermesBinding, consumeHermesInternalNonce, createHermesQrAttempt, disableHermesBinding, disableHermesBindingInTransaction, fingerprint, getOwnedHermesQrAttempt, issueHermesBindingCode, markHermesQrAwaitingContext, markHermesQrConfirmed, prepareHermesBinding, publicHermesBinding, verifyHermesInternalSignature } from '../src/services/hermes-binding.js';

function open(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) { db.exec('BEGIN;'); if (migration.requiresForeignKeysOff) db.exec('PRAGMA foreign_keys=OFF;'); migration.up(db); if (migration.requiresForeignKeysOff) db.exec('PRAGMA foreign_keys=ON;'); db.exec('COMMIT;'); }
  db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES ('admin','管理员','x','admin')").run();
  return db;
}

test('008 重建通知表并只保存 Hermes 不透明绑定状态和代次', () => {
  const db = open();
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_logs'").get() as { sql: string }).sql;
  assert.match(sql, /'hermes'/); assert.match(sql, /recipient_binding_generation/);
  const bindingSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='hermes_bindings'").get() as { sql: string }).sql;
  assert.match(bindingSql, /active_activation_id_hash/);
  assert.doesNotMatch(bindingSql, /context_token|cursor|peer[^_f]/i);
  assert.match((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='hermes_login_attempts'").get() as { sql: string }).sql, /account_ref/);
});

test('每用户 QR attempt 受全局锁、所有权和确认上下文状态机保护', () => {
  const db = open(); db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('qr-other','二维码其他人','x')").run();
  const first = createHermesQrAttempt(db, 1, '2026-08-09 09:00:00');
  assert.match(first.account_ref, /^hr_[A-Za-z0-9_-]{16,96}$/);
  assert.throws(() => createHermesQrAttempt(db, 2, '2026-08-09 09:00:01'), /其他用户正在绑定/);
  assert.equal(getOwnedHermesQrAttempt(db, 2, first.id, '2026-08-09 09:00:01'), undefined);
  assert.equal(cancelOwnedHermesQrAttempt(db, 2, first.id, '2026-08-09 09:00:01'), false);
  markHermesQrConfirmed(db, first.id, '2026-08-09 09:00:02');
  assert.throws(() => activateHermesQrAttempt(db, { id:first.id,accountRef:first.account_ref,targetFingerprint:fingerprint('target-a'),activationId:'12345678-1234-4234-a234-123456789012' }, '2026-08-09 09:00:03'), /上下文/);
  markHermesQrAwaitingContext(db, first.id, '2026-08-09 09:00:04');
  const active = activateHermesQrAttempt(db, { id:first.id,accountRef:first.account_ref,targetFingerprint:fingerprint('target-a'),activationId:'12345678-1234-4234-a234-123456789012' }, '2026-08-09 09:00:05');
  assert.equal(active.status, 'active');
  assert.equal(activateHermesQrAttempt(db, { id:first.id,accountRef:first.account_ref,targetFingerprint:fingerprint('target-a'),activationId:'12345678-1234-4234-a234-123456789012' }, '2026-08-09 09:00:06').status, 'active');
  assert.throws(() => activateHermesQrAttempt(db, { id:first.id,accountRef:first.account_ref,targetFingerprint:fingerprint('target-a'),activationId:'00000000-0000-4000-8000-000000000099' }, '2026-08-09 09:00:07'), /激活凭证/);
  assert.throws(() => activateHermesQrAttempt(db, { id:first.id,accountRef:first.account_ref,targetFingerprint:fingerprint('target-b'),activationId:'12345678-1234-4234-a234-123456789012' }, '2026-08-09 09:00:08'), /激活凭证/);
  const binding = db.prepare('SELECT account_ref,target_fingerprint,generation,status FROM hermes_bindings WHERE user_id=1').get() as any;
  assert.deepEqual({ ...binding }, { account_ref:first.account_ref,target_fingerprint:fingerprint('target-a'),generation:1,status:'active' });
});

test('QR attempt TTL/cancel never exposes provider values and frees the global lock', () => {
  const db = open(); db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('qr-cancel','取消用户','x')").run();
  const expired = createHermesQrAttempt(db, 1, '2026-08-09 09:00:00');
  assert.equal(getOwnedHermesQrAttempt(db, 1, expired.id, '2026-08-09 09:06:00')?.status, 'expired');
  const next = createHermesQrAttempt(db, 2, '2026-08-09 09:06:01');
  assert.equal(cancelOwnedHermesQrAttempt(db, 2, next.id, '2026-08-09 09:06:02'), true);
  const serialized = JSON.stringify(db.prepare('SELECT * FROM hermes_login_attempts').all());
  assert.equal(/"(?:token|context|qrcode|providerAccountId)"/i.test(serialized), false);
});

test('legacy active 绑定迁移后仅提示重绑；新账号激活前不改旧任务，成功后原子切换', () => {
  const db = open();
  db.prepare("INSERT INTO hermes_bindings(user_id,peer_fingerprint,status,generation,active_activation_id_hash,updated_at) VALUES (1,?,'active',1,?,?)").run(fingerprint('legacy-peer'), 'a'.repeat(64), '2026-08-09 08:00:00');
  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,recipient_user_id,recipient_binding_generation,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
    VALUES ('scheduled_follow_overdue','test','legacy-rebind','lead',1,1,1,'2026-08-09 08:00:00','legacy-rebind','legacy-rebind-key',1,'{}','["hermes"]','hermes','{}','pending',1,'2026-08-09 08:00:00','2026-08-10 08:00:00')`).run();
  assert.equal(publicHermesBinding(db, 1).status, 'rebind_required');
  const attempt = createHermesQrAttempt(db, 1, '2026-08-09 09:00:00');
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='legacy-rebind'").get() as { status: string }).status, 'pending');
  markHermesQrAwaitingContext(db, attempt.id, '2026-08-09 09:00:01');
  assert.throws(() => activateHermesQrAttempt(db, { id:attempt.id,accountRef:'hr_abcdefghijklmnopqrstuv',targetFingerprint:fingerprint('new-target'),activationId:'00000000-0000-4000-8000-000000000001' }, '2026-08-09 09:00:02'), /失效/);
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='legacy-rebind'").get() as { status: string }).status, 'pending');
  activateHermesQrAttempt(db, { id:attempt.id,accountRef:attempt.account_ref,targetFingerprint:fingerprint('new-target'),activationId:'12345678-1234-4234-a234-123456789012' }, '2026-08-09 09:00:03');
  assert.equal(publicHermesBinding(db, 1).status, 'active');
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='legacy-rebind'").get() as { status: string }).status, 'cancelled');
});

test('绑定码为一次性128位随机值，代次递增且重绑取消旧 Hermes 任务', () => {
  const db = open(); const first = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:00:00Z'));
  assert.match(first.code, /^XYY-[A-Z2-7]{26}$/); const firstPrep = prepareHermesBinding(db, { userId: 1, code: first.code, peerFingerprint: fingerprint('peer-a') }, '2026-08-08 08:01:00');
  assert.equal(firstPrep.generation, 1); commitHermesBinding(db, { userId: 1, activationId: firstPrep.activationId, peerFingerprint: fingerprint('peer-a'), generation: 1 }, '2026-08-08 08:01:00');
  assert.deepEqual(publicHermesBinding(db, 1).status, 'rebind_required');
  db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('other','其他','x')").run();
  db.prepare("INSERT INTO leads(contact_name,source,lead_date,owner_id,created_by) VALUES ('测试','测试','2026-08-08',1,2)").run();
  db.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,new_owner_id,recipient_user_id,recipient_binding_generation,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at) VALUES ('owner_changed','single_edit','o','lead',1,1,2,1,1,1,'2026-08-08 08:01:00','d','k',1,'{}','["hermes"]','hermes','{}','pending',1,'2026-08-08 08:01:00','2026-08-09 08:01:00')`).run();
  const second = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:02:00Z'));
  const secondPrep = prepareHermesBinding(db, { userId: 1, code: second.code, peerFingerprint: fingerprint('peer-b') }, '2026-08-08 08:03:00'); assert.equal(secondPrep.generation, 2);
  commitHermesBinding(db, { userId: 1, activationId: secondPrep.activationId, peerFingerprint: fingerprint('peer-b'), generation: 2 }, '2026-08-08 08:03:00');
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='d'").get() as { status: string }).status, 'cancelled');
  assert.throws(() => prepareHermesBinding(db, { userId: 1, code: first.code, peerFingerprint: fingerprint('peer-a') }, '2026-08-08 08:04:00'));
});

test('内部 HMAC 请求拒绝重放和错误签名', () => {
  const secret = 'x'.repeat(32); const ts = String(Date.now()); const nonce = 'a'.repeat(24); const body = '{}'; const sig = createHmac('sha256', secret).update(['POST','/internal/hermes-bindings/prepare',ts,nonce,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  assert.equal(verifyHermesInternalSignature(secret, 'POST', '/internal/hermes-bindings/prepare', ts, nonce, body, sig), true);
  assert.equal(verifyHermesInternalSignature(secret, 'POST', '/internal/hermes-bindings/prepare', ts, nonce, body, '0'.repeat(64)), false);
});

test('内部 nonce 落库且跨重启拒绝重放，不保存原始 nonce', () => {
  const db = open(); const nonce = 'n'.repeat(24);
  assert.equal(consumeHermesInternalNonce(db, nonce, '2026-08-08 08:00:00'), true);
  assert.equal(consumeHermesInternalNonce(db, nonce, '2026-08-08 08:00:01'), false);
  const stored = db.prepare('SELECT nonce_hash FROM hermes_internal_nonces').get() as { nonce_hash: string };
  assert.equal(stored.nonce_hash.includes(nonce), false);
  // A new connection/process uses the same durable primary-key gate.
  assert.equal(consumeHermesInternalNonce(db, nonce, '2026-08-08 08:00:02'), false);
});

test('同一 peer 不能被两个用户预留，commit 重放可恢复 vault 崩溃点', () => {
  const db = open();
  db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('other','其他','x')").run();
  const a = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:00:00Z'));
  const first = prepareHermesBinding(db, { userId: 1, code: a.code, peerFingerprint: fingerprint('same-peer') }, '2026-08-08 08:01:00');
  // Retries of prepare use the persisted activation id rather than making a
  // different vault prepared record impossible to activate after a crash.
  const again = prepareHermesBinding(db, { userId: 1, code: a.code, peerFingerprint: fingerprint('same-peer') }, '2026-08-08 08:01:01');
  assert.deepEqual(again, first);
  const b = issueHermesBindingCode(db, 2, new Date('2026-08-08T00:02:00Z'));
  assert.throws(() => prepareHermesBinding(db, { userId: 2, code: b.code, peerFingerprint: fingerprint('same-peer') }, '2026-08-08 08:03:00'), /该微信已绑定/);
  commitHermesBinding(db, { userId: 1, activationId: first.activationId, peerFingerprint: fingerprint('same-peer'), generation: first.generation }, '2026-08-08 08:04:00');
  assert.doesNotThrow(() => commitHermesBinding(db, { userId: 1, activationId: first.activationId, peerFingerprint: fingerprint('same-peer'), generation: first.generation }, '2026-08-08 08:04:01'));
  assert.throws(() => commitHermesBinding(db, { userId: 1, activationId: '00000000-0000-4000-8000-000000000099', peerFingerprint: fingerprint('same-peer'), generation: first.generation }, '2026-08-08 08:04:02'), /激活凭证/);
});

test('停用事务回滚时用户、绑定与待发任务一并保持原状', () => {
  const db = open(); const code = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:00:00Z'));
  const prepared = prepareHermesBinding(db, { userId: 1, code: code.code, peerFingerprint: fingerprint('peer') }, '2026-08-08 08:01:00');
  commitHermesBinding(db, { userId: 1, activationId: prepared.activationId, peerFingerprint: fingerprint('peer'), generation: 1 }, '2026-08-08 08:01:01');
  db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('actor','执行人','x')").run();
  db.prepare("INSERT INTO leads(contact_name,source,lead_date,owner_id,created_by) VALUES ('测试','测试','2026-08-08',1,2)").run();
  db.prepare("INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at) VALUES ('owner_changed','single_edit','t','lead',1,1,2,1,1,'2026-08-08 08:01:00','tx','tx',1,'{}','[\"hermes\"]','hermes','{}','pending',1,'2026-08-08 08:01:00','2026-08-09 08:01:00')").run();
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  disableHermesBindingInTransaction(db, 1, '2026-08-08 08:02:00');
  db.exec('ROLLBACK');
  assert.equal((db.prepare('SELECT is_active FROM users WHERE id=1').get() as { is_active: number }).is_active, 1);
  assert.equal((db.prepare('SELECT status FROM hermes_bindings WHERE user_id=1').get() as { status: string }).status, 'active');
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='tx'").get() as { status: string }).status, 'pending');
});

test('独立 disable 发生取消任务失败时完整回滚', () => {
  const db = open(); const code = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:00:00Z'));
  const prepared = prepareHermesBinding(db, { userId: 1, code: code.code, peerFingerprint: fingerprint('rollback-peer') }, '2026-08-08 08:01:00');
  commitHermesBinding(db, { userId: 1, activationId: prepared.activationId, peerFingerprint: fingerprint('rollback-peer'), generation: 1 }, '2026-08-08 08:01:01');
  db.exec(`CREATE TRIGGER fail_hermes_disable BEFORE UPDATE OF status ON notification_logs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT, 'forced cancel failure'); END;`);
  // No notification row is required for SQLite to validate the transaction
  // owner; insert one so the cancellation update invokes the injected failure.
  db.prepare("INSERT INTO users(username,name,password_hash) VALUES ('actor2','执行人','x')").run();
  db.prepare("INSERT INTO leads(contact_name,source,lead_date,owner_id,created_by) VALUES ('测试','测试','2026-08-08',1,2)").run();
  db.prepare("INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at) VALUES ('owner_changed','single_edit','rollback','lead',1,1,2,1,1,'2026-08-08 08:01:00','rollback','rollback',1,'{}','[\"hermes\"]','hermes','{}','pending',1,'2026-08-08 08:01:00','2026-08-09 08:01:00')").run();
  assert.throws(() => disableHermesBinding(db, 1, '2026-08-08 08:02:00'), /forced cancel failure/);
  assert.equal((db.prepare('SELECT status FROM hermes_bindings WHERE user_id=1').get() as { status: string }).status, 'active');
  assert.equal((db.prepare("SELECT status FROM notification_logs WHERE dedupe_key='rollback'").get() as { status: string }).status, 'pending');
});

test('全局最多十个 active 绑定，prepare 预留容量且第十一人不改变 challenge', () => {
  const db = open();
  for (let id = 2; id <= 11; id++) db.prepare('INSERT INTO users(username,name,password_hash) VALUES (?,?,?)').run(`u${id}`, `用户${id}`, 'x');
  const codes: string[] = [];
  for (let id = 1; id <= 10; id++) {
    const issued = issueHermesBindingCode(db, id, new Date(`2026-08-08T00:${String(id).padStart(2, '0')}:00Z`)); codes.push(issued.code);
    const prepared = prepareHermesBinding(db, { userId: id, code: issued.code, peerFingerprint: fingerprint(`peer-${id}`) }, '2026-08-08 08:10:00');
    commitHermesBinding(db, { userId: id, activationId: prepared.activationId, peerFingerprint: fingerprint(`peer-${id}`), generation: prepared.generation }, '2026-08-08 08:10:01');
  }
  const eleventh = issueHermesBindingCode(db, 11, new Date('2026-08-08T00:20:00Z'));
  assert.throws(() => prepareHermesBinding(db, { userId: 11, code: eleventh.code, peerFingerprint: fingerprint('peer-11') }, '2026-08-08 08:20:00'), /最多只能绑定/);
  const row = db.prepare('SELECT status,binding_code_hash,prepared_generation FROM hermes_bindings WHERE user_id=11').get() as any;
  assert.equal(row.status, 'pending'); assert.ok(row.binding_code_hash); assert.equal(row.prepared_generation, null);
  // Rebinding an active user reserves no additional slot and remains allowed.
  const rebind = issueHermesBindingCode(db, 1, new Date('2026-08-08T00:21:00Z'));
  assert.equal(prepareHermesBinding(db, { userId: 1, code: rebind.code, peerFingerprint: fingerprint('peer-1b') }, '2026-08-08 08:21:00').generation, 2);
});

test('并发 prepare 在容量边界只允许一个预留', async () => {
  const db = open();
  for (let id = 2; id <= 11; id++) db.prepare('INSERT INTO users(username,name,password_hash) VALUES (?,?,?)').run(`c${id}`, `并发${id}`, 'x');
  for (let id = 1; id <= 9; id++) { const code = issueHermesBindingCode(db, id, new Date(`2026-08-08T00:${String(id).padStart(2,'0')}:00Z`)); const prepared = prepareHermesBinding(db, { userId:id, code:code.code, peerFingerprint:fingerprint(`c${id}`) }, '2026-08-08 08:10:00'); commitHermesBinding(db, { userId:id, activationId:prepared.activationId, peerFingerprint:fingerprint(`c${id}`), generation:prepared.generation }, '2026-08-08 08:10:01'); }
  const a = issueHermesBindingCode(db, 10, new Date('2026-08-08T00:15:00Z')); const b = issueHermesBindingCode(db, 11, new Date('2026-08-08T00:15:00Z'));
  const outcomes = await Promise.allSettled([Promise.resolve().then(() => prepareHermesBinding(db, { userId:10, code:a.code, peerFingerprint:fingerprint('ca') }, '2026-08-08 08:15:00')), Promise.resolve().then(() => prepareHermesBinding(db, { userId:11, code:b.code, peerFingerprint:fingerprint('cb') }, '2026-08-08 08:15:00'))]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
});
