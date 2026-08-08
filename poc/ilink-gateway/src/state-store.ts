import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type StoredDelivery = {
  idempotencyKey: string; recipientHash: string; messageHash: string; status: string; providerMessageId: string | null; errorCode: string | null
}
export type DeliveryAcquire = { acquired: true } | { acquired: false; record: StoredDelivery; retryInProgress?: boolean } | { acquired: false; blocked: true }
export type PilotControl = { runId: string; generation: number; authorizationId: string; deliveryRequestId: string; previousKeyHash: string | null; manifestHash: string }
type Migration = { version: string; checksum: string; sql: string }

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const migrations: readonly Migration[] = [{
  version: '001', checksum: '59c06bf54b4dccd940022313635062d174c0e3f8da5bcc9970ce5863d0a93a85', sql: `
    CREATE TABLE IF NOT EXISTS gateway_state_migrations (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reserved_idempotency_keys (key_hash TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL CHECK(source IN ('delivery','legacy','generation')), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key_hash TEXT NOT NULL, delivery_request_id TEXT UNIQUE, technical_status TEXT NOT NULL CHECK(technical_status IN ('prepared','in_flight','sent','explicit_failure','result_unknown')),
      provider_message_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS manual_delivery_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key_hash TEXT NOT NULL, confirmation_status TEXT NOT NULL CHECK(confirmation_status IN ('awaiting_confirmation','confirmed_received','confirmed_not_received','inconclusive')),
      operator_uid INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pilot_generations (
      run_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1), parent_run_id TEXT, previous_key_hash TEXT,
      idempotency_key_hash TEXT UNIQUE NOT NULL, manifest_hash TEXT NOT NULL, delivery_request_id TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','prepared','execution_authorized','consumed','closed','cancelled_before_send','expired','abandoned')),
      authorization_id TEXT UNIQUE, authorization_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(run_id, generation)
    );
    CREATE TABLE IF NOT EXISTS pilot_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, payload_hash TEXT NOT NULL, previous_hash TEXT, event_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS no_manual_confirmation_update BEFORE UPDATE ON manual_delivery_confirmations BEGIN SELECT RAISE(ABORT, 'append_only'); END;
    CREATE TRIGGER IF NOT EXISTS no_manual_confirmation_delete BEFORE DELETE ON manual_delivery_confirmations BEGIN SELECT RAISE(ABORT, 'append_only'); END;
    CREATE TRIGGER IF NOT EXISTS no_pilot_audit_update BEFORE UPDATE ON pilot_audit_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;
    CREATE TRIGGER IF NOT EXISTS no_pilot_audit_delete BEFORE DELETE ON pilot_audit_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;
  `
}, {
  version: '002', checksum: '1a4f8e6c1fbb9189cfd78d3709d41a0f36e3eca03a0e98d0b6b54a0c4a3f6388', sql: `
    ALTER TABLE manual_delivery_confirmations ADD COLUMN attempt_id INTEGER REFERENCES delivery_attempts(id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_confirmation_once_per_attempt ON manual_delivery_confirmations(attempt_id) WHERE attempt_id IS NOT NULL;
  `
}, {
  version: '003', checksum: '36d4886c01512f01359b8dbd5506d952eb4f2c49fcf5fcf0728bb0af35e1a228', sql: `
    ALTER TABLE manual_delivery_confirmations ADD COLUMN actual_received_count INTEGER CHECK(actual_received_count IS NULL OR (typeof(actual_received_count)='integer' AND actual_received_count >= 0));
  `
}]

function fail(code: string): never { throw new Error(code) }
function currentUid(): number { const uid = process.getuid?.(); if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) fail('ILINK_STATE_OWNER_UNAVAILABLE'); return uid }
function assertPrivateDirectory(stateDir: string): string {
  const resolved = resolve(stateDir)
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(resolved) } catch { fail('ILINK_STATE_DIR_MISSING') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== currentUid()) fail('ILINK_STATE_DIR_UNSAFE')
  let actual: string
  try { actual = realpathSync(resolved) } catch { fail('ILINK_STATE_DIR_UNSAFE') }
  if (actual !== resolved) fail('ILINK_STATE_DIR_UNSAFE')
  return actual
}
function assertPrivateFile(file: string, code = 'ILINK_STATE_ARTIFACT_UNSAFE'): void {
  const state = lstatSync(file)
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || (state.mode & 0o777) !== 0o600 || state.uid !== currentUid() || realpathSync(file) !== file) fail(code)
}

export class StateStore {
  readonly databasePath: string
  private readonly db: DatabaseSync

  constructor(stateDir: string) {
    const directory = assertPrivateDirectory(stateDir)
    this.databasePath = join(directory, 'ilink-poc-state.db')
    const existed = existsSync(this.databasePath)
    for (const suffix of ['', '-wal', '-shm']) {
      const artifact = `${this.databasePath}${suffix}`
      if (existsSync(artifact)) assertPrivateFile(artifact)
    }
    if (!existed && (existsSync(`${this.databasePath}-wal`) || existsSync(`${this.databasePath}-shm`))) fail('ILINK_STATE_ARTIFACT_UNSAFE')
    this.db = new DatabaseSync(this.databasePath)
    if (!existed) chmodSync(this.databasePath, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.ensurePrivateArtifacts()
    this.createBaseSchema()
    this.runInternalMigrations()
    this.verifyAuditChain()
  }

  private createBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_used_nonces_expires_at ON used_nonces(expires_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        idempotency_key TEXT PRIMARY KEY NOT NULL, recipient_hash TEXT NOT NULL, message_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent','retryable_failure','permanent_failure','result_unknown')),
        provider_message_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_locks (idempotency_key TEXT PRIMARY KEY NOT NULL, acquired_at INTEGER NOT NULL);
    `)
  }
  private runInternalMigrations(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // The migration ledger itself predates the first entry, so bootstrap it
      // separately and keep all later schema changes checksum-bound.
      this.db.exec('CREATE TABLE IF NOT EXISTS gateway_state_migrations (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)')
      for (const migration of migrations) {
        const existing = this.db.prepare('SELECT checksum FROM gateway_state_migrations WHERE version=?').get(migration.version) as { checksum?: string } | undefined
        if (existing && existing.checksum !== migration.checksum) fail('ILINK_STATE_MIGRATION_CHECKSUM_CONFLICT')
        if (!existing) {
          this.db.exec(migration.sql)
          this.db.prepare('INSERT INTO gateway_state_migrations(version,checksum,applied_at) VALUES (?,?,?)').run(migration.version, migration.checksum, Date.now())
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
    this.ensurePrivateArtifacts()
  }
  private ensurePrivateArtifacts(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.databasePath}${suffix}`
      if (!existsSync(file)) continue
      chmodSync(file, 0o600)
      assertPrivateFile(file)
    }
  }
  private appendAudit(eventType: string, payload: Record<string, unknown>, now: number): void {
    const previous = this.db.prepare('SELECT event_hash FROM pilot_audit_events ORDER BY id DESC LIMIT 1').get() as { event_hash?: string } | undefined
    const payloadHash = hash(JSON.stringify(payload)); const eventHash = hash(`${previous?.event_hash ?? ''}|${eventType}|${payloadHash}|${now}`)
    this.db.prepare('INSERT INTO pilot_audit_events(event_type,payload_hash,previous_hash,event_hash,created_at) VALUES (?,?,?,?,?)').run(eventType, payloadHash, previous?.event_hash ?? null, eventHash, now)
  }
  verifyAuditChain(): void {
    const rows = this.db.prepare('SELECT event_type,payload_hash,previous_hash,event_hash,created_at FROM pilot_audit_events ORDER BY id').all() as Array<{ event_type: string; payload_hash: string; previous_hash: string | null; event_hash: string; created_at: number }>
    let previous = ''
    for (const row of rows) {
      if ((row.previous_hash ?? '') !== previous || row.event_hash !== hash(`${previous}|${row.event_type}|${row.payload_hash}|${row.created_at}`)) fail('ILINK_STATE_AUDIT_CHAIN_INVALID')
      previous = row.event_hash
    }
  }
  auditEventCount(eventType: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM pilot_audit_events WHERE event_type=?').get(eventType) as { count: number }).count)
  }

  close(): void { this.db.close() }
  useNonce(nonce: string, expiresAt: number, now: number): boolean {
    this.db.exec('DELETE FROM used_nonces WHERE expires_at < ' + Math.floor(now))
    try { this.db.prepare('INSERT INTO used_nonces(nonce, expires_at, created_at) VALUES (?, ?, ?)').run(nonce, expiresAt, now); this.ensurePrivateArtifacts(); return true } catch { return false }
  }
  acquireDelivery(idempotencyKey: string, recipientHash: string, messageHash: string, now: number, allowGenerationReservation = false): DeliveryAcquire {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT idempotency_key AS idempotencyKey, recipient_hash AS recipientHash, message_hash AS messageHash, status, provider_message_id AS providerMessageId, error_code AS errorCode FROM deliveries WHERE idempotency_key = ?').get(idempotencyKey) as StoredDelivery | undefined
      const reservation = this.db.prepare('SELECT source FROM reserved_idempotency_keys WHERE key_hash=?').get(hash(idempotencyKey)) as { source?: string } | undefined
      if (reservation?.source === 'legacy' || (reservation?.source === 'generation' && !allowGenerationReservation)) { this.db.exec('COMMIT'); return { acquired: false, blocked: true } }
      if (reservation?.source === 'delivery' && !existing) { this.db.exec('COMMIT'); return { acquired: false, blocked: true } }
      if (!existing) {
        this.db.prepare('INSERT INTO deliveries(idempotency_key,recipient_hash,message_hash,status,provider_message_id,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(idempotencyKey, recipientHash, messageHash, 'result_unknown', null, 'ILINK_SEND_RESULT_UNKNOWN', now, now)
        this.db.prepare('INSERT OR IGNORE INTO reserved_idempotency_keys(key_hash,source,created_at) VALUES (?,?,?)').run(hash(idempotencyKey), 'delivery', now)
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
    try { this.db.prepare('UPDATE deliveries SET status=?, provider_message_id=?, error_code=?, updated_at=? WHERE idempotency_key=?').run(status, providerMessageId ?? null, errorCode ?? null, now, idempotencyKey); this.db.prepare('DELETE FROM delivery_locks WHERE idempotency_key=?').run(idempotencyKey); this.db.exec('COMMIT'); this.ensurePrivateArtifacts() } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  importLegacyUnknownAttempt(input: { idempotencyKey: string; runId: string; deliveryRequestId: string; manifestHash: string }, operatorUid: number, now: number): string {
    const { idempotencyKey, runId, deliveryRequestId, manifestHash } = input
    const keyHash = hash(idempotencyKey)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO reserved_idempotency_keys(key_hash,source,created_at) VALUES (?,?,?)').run(keyHash, 'legacy', now)
      if (!result.changes) fail('ILINK_LEGACY_KEY_ALREADY_RESERVED')
      this.db.prepare("INSERT INTO delivery_attempts(idempotency_key_hash,delivery_request_id,technical_status,error_code,created_at,completed_at) VALUES (?,?,?,'ILINK_SEND_RESULT_UNKNOWN',?,?)").run(keyHash, deliveryRequestId, 'result_unknown', now, now)
      this.db.prepare("INSERT INTO pilot_generations(run_id,generation,parent_run_id,previous_key_hash,idempotency_key_hash,manifest_hash,delivery_request_id,state,created_at,updated_at) VALUES (?,1,NULL,NULL,?,?,?,'closed',?,?)").run(runId, keyHash, manifestHash, deliveryRequestId, now, now)
      this.appendAudit('legacy_unknown_imported', { keyHash, runIdHash: hash(runId), deliveryRequestIdHash: hash(deliveryRequestId), manifestHash, operatorUid, technicalStatus: 'result_unknown' }, now)
      this.db.exec('COMMIT'); return keyHash
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  burnLegacyKey(idempotencyKey: string, operatorUid: number, now: number): string {
    return this.importLegacyUnknownAttempt({ idempotencyKey, runId: `legacy-${hash(idempotencyKey).slice(0, 29)}`, deliveryRequestId: `legacy-${hash(`delivery:${idempotencyKey}`).slice(0, 29)}`, manifestHash: hash(`legacy:${idempotencyKey}`) }, operatorUid, now)
  }
  recordManualConfirmation(keyHash: string, status: 'confirmed_received' | 'confirmed_not_received' | 'inconclusive', operatorUid: number, now: number, actualReceivedCount: number | null = status === 'confirmed_not_received' ? 0 : null): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const validCount = status === 'confirmed_not_received'
        ? actualReceivedCount === 0
        : status === 'confirmed_received'
          ? Number.isSafeInteger(actualReceivedCount) && Number(actualReceivedCount) > 0
          : actualReceivedCount === null
      if (!validCount) fail('ILINK_MANUAL_CONFIRMATION_COUNT_INVALID')
      const attempt = this.db.prepare("SELECT id FROM delivery_attempts WHERE idempotency_key_hash=? AND technical_status='result_unknown' ORDER BY id DESC LIMIT 1").get(keyHash) as { id?: number } | undefined
      if (!attempt?.id) fail('ILINK_MANUAL_CONFIRMATION_TARGET_INVALID')
      const existing = this.db.prepare('SELECT confirmation_status FROM manual_delivery_confirmations WHERE attempt_id=?').get(attempt.id)
      if (existing) fail('ILINK_MANUAL_CONFIRMATION_ALREADY_FINAL')
      this.db.prepare('INSERT INTO manual_delivery_confirmations(idempotency_key_hash,attempt_id,confirmation_status,operator_uid,created_at,actual_received_count) VALUES (?,?,?,?,?,?)').run(keyHash, attempt.id, status, operatorUid, now, actualReceivedCount)
      this.appendAudit('manual_confirmation', { keyHash, attemptId: attempt.id, status, actualReceivedCount, operatorUid }, now); this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  prepareGeneration(control: Omit<PilotControl, 'authorizationId'>, idempotencyKey: string, now: number): void {
    const keyHash = hash(idempotencyKey)
    if (keyHash !== control.previousKeyHash && control.generation === 1 && control.previousKeyHash !== null) fail('ILINK_GENERATION_LINEAGE_INVALID')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reserved = this.db.prepare('SELECT 1 FROM reserved_idempotency_keys WHERE key_hash=?').get(keyHash)
      const historicalDelivery = this.db.prepare('SELECT 1 FROM deliveries WHERE idempotency_key=?').get(idempotencyKey)
      if (reserved || historicalDelivery) fail('ILINK_GENERATION_KEY_RESERVED')
      if (control.generation > 1) {
        const parent = this.db.prepare('SELECT idempotency_key_hash,generation,state FROM pilot_generations WHERE run_id=? AND generation=?').get(control.runId, control.generation - 1) as { idempotency_key_hash: string; generation: number; state: string } | undefined
        const prohibitingConfirmation = this.db.prepare("SELECT 1 FROM manual_delivery_confirmations WHERE idempotency_key_hash=? AND confirmation_status IN ('confirmed_received','inconclusive') LIMIT 1").get(control.previousKeyHash ?? '')
        const latestUnknown = this.db.prepare("SELECT id FROM delivery_attempts WHERE idempotency_key_hash=? AND technical_status='result_unknown' ORDER BY id DESC LIMIT 1").get(control.previousKeyHash ?? '') as { id?: number } | undefined
        const confirmation = latestUnknown?.id ? this.db.prepare('SELECT confirmation_status FROM manual_delivery_confirmations WHERE attempt_id=?').get(latestUnknown.id) as { confirmation_status?: string } | undefined : undefined
        if (!parent || parent.state !== 'closed' || parent.generation + 1 !== control.generation || parent.idempotency_key_hash !== control.previousKeyHash || prohibitingConfirmation || confirmation?.confirmation_status !== 'confirmed_not_received') fail('ILINK_GENERATION_LINEAGE_INVALID')
      }
      this.db.prepare('INSERT INTO reserved_idempotency_keys(key_hash,source,created_at) VALUES (?,?,?)').run(keyHash, 'generation', now)
      this.db.prepare('INSERT INTO pilot_generations(run_id,generation,parent_run_id,previous_key_hash,idempotency_key_hash,manifest_hash,delivery_request_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(control.runId, control.generation, control.generation === 1 ? null : control.runId, control.previousKeyHash, keyHash, control.manifestHash, control.deliveryRequestId, 'prepared', now, now)
      this.appendAudit('generation_prepared', { runId: control.runId, generation: control.generation, keyHash, manifestHash: control.manifestHash }, now); this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  authorizeGeneration(runId: string, generation: number, authorizationId: string, operatorUid: number, expiresAt: number, now: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.db.prepare("UPDATE pilot_generations SET state='execution_authorized',authorization_id=?,authorization_expires_at=?,updated_at=? WHERE run_id=? AND generation=? AND state='prepared'").run(authorizationId, expiresAt, now, runId, generation)
      if (!updated.changes) fail('ILINK_GENERATION_NOT_PREPARED')
      this.appendAudit('generation_authorized', { runId, generation, authorizationId, operatorUid, expiresAt }, now); this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  cancelGeneration(runId: string, generation: number, operatorUid: number, now: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { const updated = this.db.prepare("UPDATE pilot_generations SET state='cancelled_before_send',updated_at=? WHERE run_id=? AND generation=? AND state IN ('reserved','prepared','execution_authorized')").run(now, runId, generation); if (!updated.changes) fail('ILINK_GENERATION_NOT_CANCELLABLE'); this.appendAudit('generation_cancelled', { runId, generation, operatorUid }, now); this.db.exec('COMMIT') } catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }
  consumeAuthorization(control: PilotControl, idempotencyKey: string, now: number): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT generation,previous_key_hash,manifest_hash,delivery_request_id,state,authorization_id,authorization_expires_at,idempotency_key_hash FROM pilot_generations WHERE run_id=? AND generation=?').get(control.runId, control.generation) as Record<string, unknown> | undefined
      if (!row || row.generation !== control.generation || row.previous_key_hash !== control.previousKeyHash || row.manifest_hash !== control.manifestHash || row.delivery_request_id !== control.deliveryRequestId || row.authorization_id !== control.authorizationId || row.idempotency_key_hash !== hash(idempotencyKey) || row.state !== 'execution_authorized' || typeof row.authorization_expires_at !== 'number' || row.authorization_expires_at <= now) { this.db.exec('COMMIT'); return false }
      this.db.prepare("UPDATE pilot_generations SET state='consumed',updated_at=? WHERE run_id=? AND generation=? AND state='execution_authorized'").run(now, control.runId, control.generation)
      this.db.prepare('INSERT INTO delivery_attempts(idempotency_key_hash,delivery_request_id,technical_status,created_at) VALUES (?,?,?,?)').run(hash(idempotencyKey), control.deliveryRequestId, 'in_flight', now)
      this.appendAudit('authorization_consumed', { runId: control.runId, generation: control.generation, deliveryRequestId: control.deliveryRequestId }, now); this.db.exec('COMMIT'); return true
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {}; throw error }
  }
  finalizeAttempt(deliveryRequestId: string, status: 'sent' | 'explicit_failure' | 'result_unknown', providerMessageId: string | undefined, errorCode: string | undefined, now: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const attempt = this.db.prepare('SELECT technical_status FROM delivery_attempts WHERE delivery_request_id=?').get(deliveryRequestId) as { technical_status?: string } | undefined
      if (!attempt) fail('ILINK_ATTEMPT_FINALIZATION_TARGET_INVALID')
      if (attempt.technical_status !== 'in_flight') fail('ILINK_ATTEMPT_ALREADY_FINALIZED')
      const finalized = this.db.prepare('UPDATE delivery_attempts SET technical_status=?,provider_message_id=?,error_code=?,completed_at=? WHERE delivery_request_id=? AND technical_status=?').run(status, providerMessageId ?? null, errorCode ?? null, now, deliveryRequestId, 'in_flight')
      if (finalized.changes !== 1) fail('ILINK_ATTEMPT_ALREADY_FINALIZED')
      const generation = this.db.prepare("UPDATE pilot_generations SET state='closed',updated_at=? WHERE delivery_request_id=? AND state='consumed'").run(now, deliveryRequestId)
      if (generation.changes !== 1) fail('ILINK_ATTEMPT_FINALIZATION_STATE_INVALID')
      this.appendAudit('attempt_finalized', { deliveryRequestId, status, errorCode: errorCode ?? null }, now)
      this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch {}; throw error }
  }
  setMeta(key: string, value: string, now: number): void { this.db.prepare('INSERT INTO gateway_meta(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, now); this.ensurePrivateArtifacts() }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM gateway_meta WHERE key=?').get(key) as { value?: string } | undefined)?.value }
  deleteMeta(key: string): void { this.db.prepare('DELETE FROM gateway_meta WHERE key=?').run(key) }
}
