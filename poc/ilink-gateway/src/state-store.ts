import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type StoredDelivery = {
  idempotencyKey: string; recipientHash: string; messageHash: string; status: string; providerMessageId: string | null; errorCode: string | null
}

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
  findDelivery(idempotencyKey: string): StoredDelivery | undefined {
    return this.db.prepare('SELECT idempotency_key AS idempotencyKey, recipient_hash AS recipientHash, message_hash AS messageHash, status, provider_message_id AS providerMessageId, error_code AS errorCode FROM deliveries WHERE idempotency_key = ?').get(idempotencyKey) as StoredDelivery | undefined
  }
  createDelivery(delivery: StoredDelivery, now: number): void {
    this.db.prepare('INSERT INTO deliveries(idempotency_key,recipient_hash,message_hash,status,provider_message_id,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(delivery.idempotencyKey, delivery.recipientHash, delivery.messageHash, delivery.status, delivery.providerMessageId, delivery.errorCode, now, now)
    this.ensurePrivateArtifacts()
  }
  updateDelivery(idempotencyKey: string, status: string, providerMessageId: string | undefined, errorCode: string | undefined, now: number): void {
    this.db.prepare('UPDATE deliveries SET status=?, provider_message_id=?, error_code=?, updated_at=? WHERE idempotency_key=?').run(status, providerMessageId ?? null, errorCode ?? null, now, idempotencyKey)
    this.ensurePrivateArtifacts()
  }
  setMeta(key: string, value: string, now: number): void {
    this.db.prepare('INSERT INTO gateway_meta(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, now)
    this.ensurePrivateArtifacts()
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM gateway_meta WHERE key=?').get(key) as { value?: string } | undefined)?.value }
  deleteMeta(key: string): void { this.db.prepare('DELETE FROM gateway_meta WHERE key=?').run(key) }
}
