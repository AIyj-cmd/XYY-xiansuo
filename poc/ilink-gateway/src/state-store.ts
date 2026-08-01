import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type StoredDelivery = {
  idempotencyKey: string; recipientHash: string; messageHash: string; status: string; providerMessageId: string | null; errorCode: string | null
}
export type DeliveryAcquire = { acquired: true } | { acquired: false; record: StoredDelivery; retryInProgress?: boolean }

export class StateStore {
  readonly databasePath: string
  private readonly db: DatabaseSync

  constructor(stateDir: string) {
    this.databasePath = join(stateDir, 'ilink-poc-state.db')
    const existed = existsSync(this.databasePath)
    this.db = new DatabaseSync(this.databasePath)
    if (!existed) chmodSync(this.databasePath, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS used_nonces (
        nonce TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_used_nonces_expires_at ON used_nonces(expires_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        recipient_hash TEXT NOT NULL,
        message_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent','retryable_failure','permanent_failure','result_unknown')),
        provider_message_id TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_locks (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `)
    this.ensurePrivateArtifacts()
  }

  private ensurePrivateArtifacts(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${this.databasePath}${suffix}`
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }

  close(): void { this.db.close() }
  useNonce(nonce: string, expiresAt: number, now: number): boolean {
    this.db.exec('DELETE FROM used_nonces WHERE expires_at < ' + Math.floor(now))
    try {
      this.db.prepare('INSERT INTO used_nonces(nonce, expires_at, created_at) VALUES (?, ?, ?)').run(nonce, expiresAt, now)
      this.ensurePrivateArtifacts(); return true
    } catch { return false }
  }
  /**
   * Atomically grants the only adapter-send lease for a new delivery or a
   * previously explicit retryable failure.  A process crash after acquisition
   * leaves the delivery result_unknown, deliberately failing closed.
   */
  acquireDelivery(idempotencyKey: string, recipientHash: string, messageHash: string, now: number): DeliveryAcquire {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT idempotency_key AS idempotencyKey, recipient_hash AS recipientHash, message_hash AS messageHash, status, provider_message_id AS providerMessageId, error_code AS errorCode FROM deliveries WHERE idempotency_key = ?').get(idempotencyKey) as StoredDelivery | undefined
      if (!existing) {
        this.db.prepare('INSERT INTO deliveries(idempotency_key,recipient_hash,message_hash,status,provider_message_id,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(idempotencyKey, recipientHash, messageHash, 'result_unknown', null, 'ILINK_SEND_RESULT_UNKNOWN', now, now)
        this.db.prepare('INSERT INTO delivery_locks(idempotency_key,acquired_at) VALUES (?,?)').run(idempotencyKey, now)
        this.db.exec('COMMIT'); this.ensurePrivateArtifacts(); return { acquired: true }
      }
      if (existing.recipientHash !== recipientHash || existing.messageHash !== messageHash) { this.db.exec('COMMIT'); return { acquired: false, record: existing } }
      if (existing.status !== 'retryable_failure') { this.db.exec('COMMIT'); return { acquired: false, record: existing } }
      const lock = this.db.prepare('INSERT OR IGNORE INTO delivery_locks(idempotency_key,acquired_at) VALUES (?,?)').run(idempotencyKey, now)
      if (!lock.changes) { this.db.exec('COMMIT'); return { acquired: false, record: existing, retryInProgress: true } }
      this.db.prepare("UPDATE deliveries SET status='result_unknown',provider_message_id=NULL,error_code='ILINK_SEND_RESULT_UNKNOWN',updated_at=? WHERE idempotency_key=? AND status='retryable_failure'").run(now, idempotencyKey)
      this.db.exec('COMMIT'); this.ensurePrivateArtifacts(); return { acquired: true }
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  finalizeDelivery(idempotencyKey: string, status: string, providerMessageId: string | undefined, errorCode: string | undefined, now: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE deliveries SET status=?, provider_message_id=?, error_code=?, updated_at=? WHERE idempotency_key=?').run(status, providerMessageId ?? null, errorCode ?? null, now, idempotencyKey)
      this.db.prepare('DELETE FROM delivery_locks WHERE idempotency_key=?').run(idempotencyKey)
      this.db.exec('COMMIT'); this.ensurePrivateArtifacts()
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  setMeta(key: string, value: string, now: number): void {
    this.db.prepare('INSERT INTO gateway_meta(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, now)
    this.ensurePrivateArtifacts()
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM gateway_meta WHERE key=?').get(key) as { value?: string } | undefined)?.value }
  deleteMeta(key: string): void { this.db.prepare('DELETE FROM gateway_meta WHERE key=?').run(key) }
}
