import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const CODE_TTL_MS = 10 * 60_000;
const CODE_INTERVAL_MS = 60_000;
const codeHash = (code: string) => createHash('sha256').update(`xiansuo/hermes-binding-code/v1\0${code}`).digest('hex');
const activationHash = (activationId: string) => createHash('sha256').update(`xiansuo/hermes-activation/v1\0${activationId}`).digest('hex');
export const fingerprint = (peer: string) => createHash('sha256').update(`xiansuo/hermes-peer/v1\0${peer}`).digest('hex');

export type HermesBindingPublic = { status: 'unbound' | 'pending' | 'active' | 'disabled' | 'rebind_required'; generation: number; expires_at: string | null };
export function publicHermesBinding(database: DatabaseSync, userId: number): HermesBindingPublic {
  const row = database.prepare('SELECT status,generation,binding_code_expires_at,account_ref FROM hermes_bindings WHERE user_id=?').get(userId) as { status: Exclude<HermesBindingPublic['status'], 'rebind_required'>; generation: number; binding_code_expires_at: string | null; account_ref: string | null } | undefined;
  return row ? { status: row.status === 'active' && !row.account_ref ? 'rebind_required' : row.status, generation: row.generation, expires_at: row.binding_code_expires_at } : { status: 'unbound', generation: 0, expires_at: null };
}

export type HermesQrAttemptPublic = {
  id: string;
  status: 'waiting' | 'scanned' | 'awaiting_context' | 'active' | 'expired' | 'failed' | 'cancelled';
  generation: number;
  expires_at: string;
  confirmation_command?: string;
  error_code?: string;
};
const LIVE_ATTEMPT_STATUSES = "('waiting','scanned','awaiting_context')";
const attemptHash = (id: string) => createHash('sha256').update(`xiansuo/hermes/attempt/v2\0${id}`).digest('hex');
export const accountRefFingerprint = (accountRef: string) => createHash('sha256').update(`xiansuo/hermes/account-ref/v2\0${accountRef}`).digest('hex');

function opaqueAccountRef(): string { return `hr_${randomBytes(24).toString('base64url')}`; }

export function expireHermesQrAttempts(database: DatabaseSync, now: string): number {
  const result = database.prepare(`UPDATE hermes_login_attempts
    SET status='expired',terminal_at=?,updated_at=? WHERE status IN ('waiting','scanned','awaiting_context') AND expires_at<=?`).run(now, now, now);
  return Number(result.changes);
}

/** Allocate only opaque state. The account manager owns the QR and credentials. */
export function createHermesQrAttempt(database: DatabaseSync, userId: number, now: string): HermesQrAttemptPublic & { account_ref: string } {
  database.exec('BEGIN IMMEDIATE;');
  try {
    expireHermesQrAttempts(database, now);
    const existing = database.prepare(`SELECT user_id FROM hermes_login_attempts WHERE status IN ${LIVE_ATTEMPT_STATUSES} LIMIT 1`).get() as { user_id: number } | undefined;
    if (existing) throw Object.assign(new Error(existing.user_id === userId ? '当前二维码仍在等待完成' : '其他用户正在绑定，请稍后再试'), { code: existing.user_id === userId ? 'HERMES_ATTEMPT_EXISTS' : 'HERMES_ATTEMPT_BUSY' });
    const binding = database.prepare('SELECT status,generation FROM hermes_bindings WHERE user_id=?').get(userId) as { status: string; generation: number } | undefined;
    if (binding?.status === 'disabled') throw Object.assign(new Error('绑定已被停用，请联系管理员'), { code: 'HERMES_BINDING_DISABLED' });
    const generation = Number(binding?.generation ?? 0) + 1;
    const id = randomUUID(); const accountRef = opaqueAccountRef();
    const expires = formatShanghai(new Date(new Date(`${now.replace(' ', 'T')}+08:00`).getTime() + 5 * 60_000));
    database.prepare(`INSERT INTO hermes_login_attempts(id,user_id,attempt_hash,status,generation,account_ref,created_at,expires_at,updated_at)
      VALUES (?,?,?,'waiting',?,?,?, ?,?)`).run(id, userId, attemptHash(id), generation, accountRef, now, expires, now);
    database.prepare(`INSERT INTO hermes_bindings(user_id,status,generation,prepared_generation,prepared_account_ref,prepared_lifecycle,updated_at)
      VALUES (?,'pending',0,? ,?,'prepared',?)
      ON CONFLICT(user_id) DO UPDATE SET status=CASE WHEN hermes_bindings.status='active' THEN 'active' ELSE 'pending' END,
        prepared_generation=excluded.prepared_generation,prepared_account_ref=excluded.prepared_account_ref,prepared_target_fingerprint=NULL,prepared_lifecycle='prepared',updated_at=excluded.updated_at`).run(userId, generation, accountRef, now);
    database.exec('COMMIT;');
    return { id, status: 'waiting', generation, expires_at: expires, account_ref: accountRef };
  } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
}

export function getOwnedHermesQrAttempt(database: DatabaseSync, userId: number, id: string, now: string): (HermesQrAttemptPublic & { account_ref: string }) | undefined {
  expireHermesQrAttempts(database, now);
  const row = database.prepare(`SELECT id,status,generation,expires_at,account_ref,error_code FROM hermes_login_attempts WHERE id=? AND user_id=?`).get(id, userId) as any;
  return row ? { id: row.id, status: row.status, generation: row.generation, expires_at: row.expires_at, account_ref: row.account_ref, ...(row.error_code ? { error_code: row.error_code } : {}) } : undefined;
}

export function cancelOwnedHermesQrAttempt(database: DatabaseSync, userId: number, id: string, now: string): boolean {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const row = database.prepare(`SELECT generation,account_ref,status FROM hermes_login_attempts WHERE id=? AND user_id=?`).get(id, userId) as { generation: number; account_ref: string; status: string } | undefined;
    if (!row) { database.exec('COMMIT;'); return false; }
    if (['active','expired','failed','cancelled'].includes(row.status)) { database.exec('COMMIT;'); return true; }
    database.prepare("UPDATE hermes_login_attempts SET status='cancelled',terminal_at=?,updated_at=? WHERE id=?").run(now, now, id);
    database.prepare(`UPDATE hermes_bindings SET prepared_generation=NULL,prepared_account_ref=NULL,prepared_target_fingerprint=NULL,prepared_lifecycle='retired',updated_at=?
      WHERE user_id=? AND prepared_generation=? AND prepared_account_ref=?`).run(now, userId, row.generation, row.account_ref);
    database.exec('COMMIT;'); return true;
  } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
}

/** Manager reported QR confirmation. This does not activate delivery: a DM context is still required. */
export function markHermesQrConfirmed(database: DatabaseSync, id: string, now: string): HermesQrAttemptPublic | undefined {
  database.prepare("UPDATE hermes_login_attempts SET status=CASE WHEN status='waiting' THEN 'scanned' ELSE status END,confirmed_at=COALESCE(confirmed_at,?),updated_at=? WHERE id=? AND status IN ('waiting','scanned')").run(now, now, id);
  const row = database.prepare('SELECT id,status,generation,expires_at,error_code FROM hermes_login_attempts WHERE id=?').get(id) as any;
  return row ? { id: row.id, status: row.status, generation: row.generation, expires_at: row.expires_at, ...(row.error_code ? { error_code: row.error_code } : {}) } : undefined;
}

/** The manager has a dedicated account and is now waiting for its exact inbound DM. */
export function markHermesQrAwaitingContext(database: DatabaseSync, id: string, now: string): HermesQrAttemptPublic | undefined {
  database.prepare("UPDATE hermes_login_attempts SET status='awaiting_context',confirmed_at=COALESCE(confirmed_at,?),updated_at=? WHERE id=? AND status IN ('waiting','scanned','awaiting_context')").run(now, now, id);
  const row = database.prepare('SELECT id,status,generation,expires_at,error_code FROM hermes_login_attempts WHERE id=?').get(id) as any;
  return row ? { id: row.id, status: row.status, generation: row.generation, expires_at: row.expires_at, ...(row.error_code ? { error_code: row.error_code } : {}) } : undefined;
}

/** The account manager calls this only after exact account-local inbound context is in its vault. */
export function activateHermesQrAttempt(database: DatabaseSync, value: { id: string; accountRef: string; targetFingerprint: string; activationId: string }, now: string): HermesQrAttemptPublic {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const attempt = database.prepare('SELECT user_id,status,generation,account_ref,expires_at,activation_id_hash FROM hermes_login_attempts WHERE id=?').get(value.id) as any;
    if (!attempt || attempt.account_ref !== value.accountRef || attempt.expires_at <= now) throw Object.assign(new Error('二维码绑定代次已失效'), { code: 'HERMES_ATTEMPT_STALE' });
    const activation = activationHash(value.activationId);
    const binding = database.prepare('SELECT generation,account_ref,target_fingerprint,prepared_account_ref,status FROM hermes_bindings WHERE user_id=?').get(attempt.user_id) as any;
    if (attempt.status === 'active') {
      if (!attempt.activation_id_hash || !timingSafeEqual(Buffer.from(attempt.activation_id_hash), Buffer.from(activation)) || binding?.status !== 'active' || binding.generation !== attempt.generation || binding.account_ref !== value.accountRef || binding.target_fingerprint !== value.targetFingerprint) throw Object.assign(new Error('绑定激活凭证不匹配'), { code: 'HERMES_BINDING_ACTIVATION_CONFLICT' });
      database.exec('COMMIT;'); return { id: attempt.id, status: 'active', generation: attempt.generation, expires_at: attempt.expires_at };
    }
    if (attempt.status !== 'awaiting_context') throw Object.assign(new Error('尚未取得账号专属会话上下文'), { code: 'HERMES_CONTEXT_REQUIRED' });
    if (!binding || binding.generation >= attempt.generation || binding.prepared_account_ref !== value.accountRef) throw Object.assign(new Error('绑定代次冲突'), { code: 'HERMES_BINDING_GENERATION_CONFLICT' });
    database.prepare(`UPDATE hermes_bindings SET status='active',generation=?,account_ref=?,target_fingerprint=?,peer_fingerprint=?,active_activation_id_hash=?,
      prepared_generation=NULL,prepared_account_ref=NULL,prepared_target_fingerprint=NULL,prepared_lifecycle='active',binding_code_hash=NULL,binding_code_expires_at=NULL,updated_at=?,last_bound_at=? WHERE user_id=?`).run(attempt.generation, value.accountRef, value.targetFingerprint, value.targetFingerprint, activation, now, now, attempt.user_id);
    database.prepare("UPDATE hermes_login_attempts SET status='active',context_ready_at=?,terminal_at=?,activation_id_hash=?,updated_at=? WHERE id=?").run(now, now, activation, now, value.id);
    database.prepare(`UPDATE notification_logs SET status='cancelled',cancellation_reason='binding_generation_changed',cancelled_at=?,retain_until=datetime(?, '+180 days'),lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,row_version=row_version+1
      WHERE channel='hermes' AND recipient_user_id=? AND status IN ('pending','retry_wait','sending') AND (recipient_binding_generation<>? OR recipient_account_ref IS NULL OR recipient_account_ref<>?)`).run(now, now, now, attempt.user_id, attempt.generation, value.accountRef);
    database.exec('COMMIT;');
    return { id: attempt.id, status: 'active', generation: attempt.generation, expires_at: attempt.expires_at };
  } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
}

/** Generate an opaque 128-bit, displayable, single-use binding code. */
function base32Code(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const bytes = randomBytes(16); let buffer = 0; let bits = 0; let output = '';
  for (const byte of bytes) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { output += alphabet[(buffer >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31]; return output.slice(0, 26);
}
export function issueHermesBindingCode(database: DatabaseSync, userId: number, now = new Date()): { code: string; expires_at: string } {
  const existing = database.prepare('SELECT status,last_code_issued_at FROM hermes_bindings WHERE user_id=?').get(userId) as { status: string; last_code_issued_at: string | null } | undefined;
  if (existing?.status === 'disabled') throw Object.assign(new Error('绑定已被停用'), { code: 'HERMES_BINDING_DISABLED' });
  if (existing?.last_code_issued_at && now.getTime() - new Date(`${existing.last_code_issued_at.replace(' ', 'T')}+08:00`).getTime() < CODE_INTERVAL_MS) throw Object.assign(new Error('请稍后再生成绑定码'), { code: 'HERMES_BINDING_RATE_LIMIT' });
  const code = `XYY-${base32Code()}`;
  const at = formatShanghai(now); const expires = formatShanghai(new Date(now.getTime() + CODE_TTL_MS));
  database.prepare(`INSERT INTO hermes_bindings(user_id,status,generation,binding_code_hash,binding_code_expires_at,last_code_issued_at,updated_at)
    VALUES (?,'pending',0,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET status=CASE WHEN hermes_bindings.status='active' THEN 'active' ELSE 'pending' END,binding_code_hash=excluded.binding_code_hash,binding_code_expires_at=excluded.binding_code_expires_at,last_code_issued_at=excluded.last_code_issued_at,updated_at=excluded.updated_at`).run(userId, codeHash(code), expires, at, at);
  return { code, expires_at: expires };
}

export function prepareHermesBinding(database: DatabaseSync, payload: { userId: number; code: string; peerFingerprint: string }, now: string): { generation: number; activationId: string } {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare('UPDATE hermes_bindings SET prepared_generation=NULL,prepared_code_hash=NULL,prepared_peer_fingerprint=NULL,prepared_activation_id=NULL,prepared_at=NULL WHERE prepared_at IS NOT NULL AND prepared_at < datetime(?, \'-10 minutes\')').run(now);
    const row = database.prepare('SELECT status,generation,binding_code_hash,binding_code_expires_at,prepared_generation,prepared_code_hash,prepared_activation_id FROM hermes_bindings WHERE user_id=?').get(payload.userId) as any;
    if (!row || row.status === 'disabled') throw Object.assign(new Error('绑定不可用'), { code: 'HERMES_BINDING_UNAVAILABLE' });
    const hash = codeHash(payload.code);
    if (!row.binding_code_hash || !row.binding_code_expires_at || row.binding_code_expires_at < now || !timingSafeEqual(Buffer.from(row.binding_code_hash), Buffer.from(hash))) throw Object.assign(new Error('绑定码无效或已过期'), { code: 'HERMES_BINDING_CODE_INVALID' });
    if (row.prepared_generation && row.prepared_code_hash === hash) { database.exec('COMMIT;'); return { generation: Number(row.prepared_generation), activationId: String(row.prepared_activation_id) }; }
    // Active rebinding replaces the user's existing slot. A new/inactive
    // binding consumes a reservation now, not at commit, closing the race.
    if (row.status !== 'active') {
      const used = database.prepare("SELECT COUNT(*) AS count FROM hermes_bindings WHERE status='active' OR (prepared_generation IS NOT NULL AND status!='active')").get() as { count: number };
      if (used.count >= 10) throw Object.assign(new Error('最多只能绑定 10 位启用用户'), { code: 'HERMES_BINDING_CAPACITY_EXCEEDED' });
    }
    const generation = Number(row.generation) + 1;
    const conflict = database.prepare('SELECT user_id FROM hermes_bindings WHERE (peer_fingerprint=? OR prepared_peer_fingerprint=?) AND user_id<>?').get(payload.peerFingerprint, payload.peerFingerprint, payload.userId);
    if (conflict) throw Object.assign(new Error('该微信已绑定其他用户'), { code: 'HERMES_BINDING_PEER_CONFLICT' });
    const activationId = randomUUID();
    database.prepare('UPDATE hermes_bindings SET prepared_generation=?,prepared_code_hash=?,prepared_peer_fingerprint=?,prepared_activation_id=?,prepared_at=?,updated_at=? WHERE user_id=?').run(generation, hash, payload.peerFingerprint, activationId, now, now, payload.userId);
    database.exec('COMMIT;'); return { generation, activationId };
  } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
}

export function prepareHermesBindingByCode(database: DatabaseSync, payload: { code: string; peerFingerprint: string }, now: string): { userId: number; generation: number; activationId: string } {
  const row = database.prepare('SELECT user_id FROM hermes_bindings WHERE binding_code_hash=? AND binding_code_expires_at>=? AND status != \'disabled\'').get(codeHash(payload.code), now) as { user_id: number } | undefined;
  if (!row) throw Object.assign(new Error('绑定码无效或已过期'), { code: 'HERMES_BINDING_CODE_INVALID' });
  const prepared = prepareHermesBinding(database, { ...payload, userId: row.user_id }, now);
  return { userId: row.user_id, ...prepared };
}

export function commitHermesBinding(database: DatabaseSync, payload: { userId: number; activationId: string; peerFingerprint: string; generation: number }, now: string): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const row = database.prepare('SELECT status,generation,peer_fingerprint,active_activation_id_hash,prepared_generation,prepared_peer_fingerprint,prepared_activation_id FROM hermes_bindings WHERE user_id=?').get(payload.userId) as any;
    const suppliedActivationHash = activationHash(payload.activationId);
    if (row?.status === 'active' && row.generation === payload.generation && row.peer_fingerprint === payload.peerFingerprint) {
      if (!row.active_activation_id_hash || !timingSafeEqual(Buffer.from(row.active_activation_id_hash), Buffer.from(suppliedActivationHash))) throw Object.assign(new Error('绑定激活凭证不匹配'), { code: 'HERMES_BINDING_ACTIVATION_CONFLICT' });
      database.exec('COMMIT;'); return;
    }
    if (!row || row.prepared_generation !== payload.generation || row.prepared_peer_fingerprint !== payload.peerFingerprint || row.prepared_activation_id !== payload.activationId) throw Object.assign(new Error('绑定代次冲突'), { code: 'HERMES_BINDING_GENERATION_CONFLICT' });
    database.prepare(`UPDATE hermes_bindings SET peer_fingerprint=?,status='active',generation=?,active_activation_id_hash=?,binding_code_hash=NULL,binding_code_expires_at=NULL,prepared_generation=NULL,prepared_code_hash=NULL,prepared_peer_fingerprint=NULL,prepared_activation_id=NULL,prepared_at=NULL,last_bound_at=?,updated_at=? WHERE user_id=?`).run(payload.peerFingerprint, payload.generation, suppliedActivationHash, now, now, payload.userId);
    // A task is only valid for the exact generation persisted in its outbox
    // snapshot. Rebinding makes every older unsent Hermes task unsafe.
    database.prepare(`UPDATE notification_logs SET status='cancelled',cancellation_reason='binding_generation_changed',cancelled_at=?,retain_until=datetime(?, '+180 days'),lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,row_version=row_version+1
      WHERE channel='hermes' AND recipient_user_id=? AND status IN ('pending','retry_wait','sending') AND (recipient_binding_generation IS NULL OR recipient_binding_generation<>?)`).run(now, now, now, payload.userId, payload.generation);
    database.exec('COMMIT;');
  } catch (error) { database.exec('ROLLBACK;'); throw error; }
}

export function refreshHermesBinding(database: DatabaseSync, payload: { userId: number; peerFingerprint: string; generation: number }, now: string): void {
  const row = database.prepare('SELECT status,generation,peer_fingerprint FROM hermes_bindings WHERE user_id=?').get(payload.userId) as any;
  if (!row || row.status !== 'active' || row.generation !== payload.generation || row.peer_fingerprint !== payload.peerFingerprint) throw Object.assign(new Error('绑定代次不可刷新'), { code: 'HERMES_BINDING_GENERATION_CONFLICT' });
  database.prepare('UPDATE hermes_bindings SET updated_at=? WHERE user_id=?').run(now, payload.userId);
}

/** Caller must own the transaction; used by user deactivation to avoid nesting. */
export function disableHermesBindingInTransaction(database: DatabaseSync, userId: number, now: string): void {
  database.prepare(`UPDATE hermes_bindings SET status='disabled',active_activation_id_hash=NULL,binding_code_hash=NULL,binding_code_expires_at=NULL,prepared_generation=NULL,prepared_code_hash=NULL,prepared_peer_fingerprint=NULL,prepared_activation_id=NULL,prepared_at=NULL,updated_at=? WHERE user_id=?`).run(now, userId);
  database.prepare(`UPDATE notification_logs SET status='cancelled',cancellation_reason='recipient_inactive',cancelled_at=?,retain_until=datetime(?, '+180 days'),lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,row_version=row_version+1 WHERE channel='hermes' AND recipient_user_id=? AND status IN ('pending','retry_wait','sending')`).run(now, now, now, userId);
  database.prepare("UPDATE hermes_login_attempts SET status='cancelled',terminal_at=?,updated_at=? WHERE user_id=? AND status IN ('waiting','scanned','awaiting_context')").run(now, now, userId);
}

/** Stand-alone internal endpoint operation: never expose a partial disable. */
export function disableHermesBinding(database: DatabaseSync, userId: number, now: string): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    disableHermesBindingInTransaction(database, userId, now);
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original failure */ }
    throw error;
  }
}

/** Validate the HMAC only. Durable nonce consumption is a separate DB gate. */
export function verifyHermesInternalSignature(secret: string, method: string, path: string, timestamp: string | undefined, nonce: string | undefined, rawBody: string, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !nonce || !signature || !/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || Math.abs(now - Number(timestamp)) > 60_000) return false;
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const expected = createHmac('sha256', secret).update([method, path, timestamp, nonce, bodyHash].join('\n')).digest('hex');
  const valid = /^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return valid;
}

/** Durable replay gate used by HTTP routes; nonce values are never stored raw. */
export function consumeHermesInternalNonce(database: DatabaseSync, nonce: string, now: string): boolean {
  const hash = createHash('sha256').update(`xiansuo/hermes/nonce/v1\0${nonce}`).digest('hex');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare('DELETE FROM hermes_internal_nonces WHERE expires_at <= ?').run(now);
    const count = (database.prepare('SELECT COUNT(*) AS count FROM hermes_internal_nonces').get() as { count: number }).count;
    if (count >= 10_000) { database.exec('ROLLBACK;'); return false; }
    const result = database.prepare("INSERT OR IGNORE INTO hermes_internal_nonces(nonce_hash,expires_at) VALUES (?,datetime(?, '+65 seconds'))").run(hash, now);
    database.exec('COMMIT;'); return result.changes === 1;
  } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
}

function formatShanghai(value: Date): string { return value.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' '); }
