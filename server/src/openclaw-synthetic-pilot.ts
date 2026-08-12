import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { configureConnection, MIGRATIONS, runMigrations } from './db.js';
import { dailySnapshotSchema } from './notifications/snapshot.js';
import { nowDatetime } from './utils/datetime.js';

/** A narrow, auditable marker; it is not a new notification event. */
export const SYNTHETIC_PILOT_EVENT_SOURCE = 'openclaw_synthetic_pilot';
export const SYNTHETIC_PILOT_EVENT_TYPE = 'daily_report';
const SYNTHETIC_DATABASE_BASENAME = 'openclaw-synthetic-pilot.db';
const DETAIL_PATH = '/pages/notify/index';
const DETAIL_URL = 'https://xs.tomatopia.top/';
const MESSAGE = { title: '【测试通知】', body: 'XYY-xiansuo普通微信通知通道已连接。\n这是一条内部测试消息。', detailPath: DETAIL_URL } as const;
const RULE_CONFIG = { schema_version: 1, recipient_mode: 'job_recipient', quiet_hours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }, max_attempts: 1, ttl_minutes: 60 } as const;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export type SyntheticPilotInput = { databasePath: string; pilotUserId: number; idempotencyKey: string; control?: Omit<SyntheticPilotControl, 'manifestHash'> };
type ValidatedSyntheticPilotInput = SyntheticPilotInput & { control: Omit<SyntheticPilotControl, 'manifestHash'> };
export type SyntheticPilotControl = { runId: string; generation: number; authorizationId: string; deliveryRequestId: string; previousKeyHash: string | null; manifestHash: string };
export type SyntheticPilotTask = { id?: number; event_type: string; event_source: string; operation_id: string; subject_type: string; subject_id: number; lead_id: number | null; actor_user_id: number | null; old_owner_id: number | null; new_owner_id: number | null; recipient_user_id: number; dedupe_key: string; delivery_idempotency_key: string; rule_version: number; rule_snapshot_json: string; channel_order_snapshot_json: string; channel: string; message_snapshot_json: string; status: string; attempt_count: number; automatic_attempt_count: number; manual_retry_count: number; max_attempts: number; available_at: string; occurred_at: string; expires_at: string; lease_token: string | null; lease_owner: string | null; lease_until: string | null; lease_recovery_count: number; retry_allowed: number; provider_message_id: string | null; failure_class: string | null; last_error_code: string | null; last_error_message: string | null; suppression_reason: string | null; cancellation_reason: string | null; management_audit_json: string; retain_until: string | null; last_attempt_at: string | null; sent_at: string | null; failed_at: string | null; suppressed_at: string | null; cancelled_at: string | null; row_version: number; created_at: string; updated_at: string };
export type SyntheticSafetyPhase = 'fresh' | 'repeat' | 'queue' | 'worker';
type ResolvedSyntheticPath = { requested: string; databasePath: string; directory: string };

export function assertSyntheticPilotIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(value)) throw new Error('OPENCLAW_SYNTHETIC_IDEMPOTENCY_KEY_INVALID');
  return value;
}
export function syntheticOperationId(idempotencyKey: string): string { return `openclaw_synthetic_pilot:v1:${sha(assertSyntheticPilotIdempotencyKey(idempotencyKey))}`; }
export function syntheticDedupeKey(idempotencyKey: string, pilotUserId: number, businessDate: string): string {
  return sha(`v1|openclaw_synthetic_pilot|idempotency_key=${assertSyntheticPilotIdempotencyKey(idempotencyKey)}|recipient_user_id=${pilotUserId}|business_date=${businessDate}`);
}
export function syntheticSnapshot(businessDate: string): Record<string, unknown> {
  return {
    schema_version: 1, title: MESSAGE.title, summary: 'XYY-xiansuo普通微信通知通道已连接。', highlights: [], actions: [], closing: '这是一条内部测试消息。',
    metrics: { today_new_count: 0, today_follow_up_count: 0, overdue_count: 0, next_day_count: 0 }, subject_lead_ids: [], business_date: businessDate,
    scope: 'self', fallback_used: true, detail_path: DETAIL_PATH,
  };
}
export function openClawSyntheticPilotMessage() { return MESSAGE; }

function plusMinutes(now: string, minutes: number): string {
  return new Date(new Date(`${now.replace(' ', 'T')}+08:00`).getTime() + minutes * 60_000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}
function isInside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
function fail(code: string): never { throw new Error(code); }
function assertPrivateRegularFile(filename: string, code: string): void {
  const info = lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || realpathSync(filename) !== filename) fail(code);
}
function assertArtifactPermissions(databasePath: string, create: boolean): void {
  for (const artifact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(artifact)) continue;
    if (create) chmodSync(artifact, 0o600);
    assertPrivateRegularFile(artifact, 'OPENCLAW_SYNTHETIC_DB_ARTIFACT_UNSAFE');
  }
}
/** Resolves every component, rejecting lexical and realpath disagreement. */
export function assertSyntheticDatabasePath(databasePath: string, create = false): ResolvedSyntheticPath {
  if (!path.isAbsolute(databasePath)) throw new Error('OPENCLAW_SYNTHETIC_DB_PATH_ABSOLUTE_REQUIRED');
  const resolved = path.resolve(databasePath); const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('OPENCLAW_SYNTHETIC_DB_PATH_REPOSITORY_FORBIDDEN');
  if (path.basename(resolved) !== SYNTHETIC_DATABASE_BASENAME) throw new Error('OPENCLAW_SYNTHETIC_DB_BASENAME_INVALID');
  const temporaryRoot = realpathSync(os.tmpdir()); const requestedDirectory = path.dirname(resolved);
  if (!existsSync(requestedDirectory)) throw new Error('OPENCLAW_SYNTHETIC_DB_PATH_TEMPORARY_REQUIRED');
  const directory = realpathSync(requestedDirectory);
  if (directory !== requestedDirectory || !isInside(temporaryRoot, directory)) throw new Error('OPENCLAW_SYNTHETIC_DB_PATH_SYMLINK_FORBIDDEN');
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('OPENCLAW_SYNTHETIC_DB_DIRECTORY_PRIVATE_REQUIRED');
  const target = path.join(directory, SYNTHETIC_DATABASE_BASENAME);
  if (target !== resolved) throw new Error('OPENCLAW_SYNTHETIC_DB_PATH_SYMLINK_FORBIDDEN');
  if (existsSync(target)) assertPrivateRegularFile(target, 'OPENCLAW_SYNTHETIC_DB_ARTIFACT_UNSAFE');
  if (!create && !existsSync(target)) throw new Error('OPENCLAW_SYNTHETIC_DB_MISSING');
  assertArtifactPermissions(target, false);
  return { requested: databasePath, databasePath: target, directory };
}
function validateInput(input: SyntheticPilotInput): ValidatedSyntheticPilotInput {
  if (!Number.isSafeInteger(input.pilotUserId) || input.pilotUserId < 1) throw new Error('OPENCLAW_SYNTHETIC_PILOT_USER_ID_INVALID');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const control = input.control;
  if (!control || !uuid.test(control.runId) || !Number.isSafeInteger(control.generation) || control.generation < 1 || !uuid.test(control.authorizationId) || !uuid.test(control.deliveryRequestId)
      || (control.generation === 1 ? control.previousKeyHash !== null : typeof control.previousKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(control.previousKeyHash))) throw new Error('OPENCLAW_SYNTHETIC_CONTROL_INPUT_INVALID');
  return { ...input, control, databasePath: assertSyntheticDatabasePath(input.databasePath, true).databasePath, idempotencyKey: assertSyntheticPilotIdempotencyKey(input.idempotencyKey) };
}
function migrationStateIsCurrent(database: DatabaseSync): boolean {
  const rows = database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: string; checksum: string }>;
  return JSON.stringify(rows) === JSON.stringify(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
}
const defaultRules = [
  ['owner_changed', 'new_owner', '["mock"]', JSON.stringify({ schema_version: 1, quiet_hours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }, max_attempts: 5, ttl_minutes: 1440 })],
  ['scheduled_follow_overdue', 'reserved', '["mock"]', JSON.stringify({ schema_version: 1, recipient_mode: 'job_recipient', quiet_hours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }, max_attempts: 5, ttl_minutes: 1440 })],
  ['visit_reminder', 'reserved', '[]', '{}'], ['status_changed', 'reserved', '[]', '{}'],
  ['daily_report', 'reserved', '["mock"]', JSON.stringify({ schema_version: 1, recipient_mode: 'job_recipient', quiet_hours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }, max_attempts: 5, ttl_minutes: 1440 })],
  ['weekly_report', 'reserved', '[]', '{}'], ['inactive_lead', 'reserved', '[]', '{}'],
] as const;
function assertEmptySensitiveTables(database: DatabaseSync): void {
  const allowed = new Set(['schema_migrations', 'users', 'notification_rules', 'notification_logs', 'openclaw_synthetic_pilot_control', 'openclaw_synthetic_pilot_audit', 'sqlite_sequence']);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  for (const { name } of tables) if (!allowed.has(name) && (database.prepare(`SELECT COUNT(*) AS count FROM "${name.replace(/"/g, '""')}"`).get() as { count: number }).count !== 0) fail('OPENCLAW_SYNTHETIC_DATABASE_CONTAMINATED');
}
function controlManifest(input: SyntheticPilotInput, task: SyntheticPilotTask, control: Omit<SyntheticPilotControl, 'manifestHash'>): string {
  return sha(JSON.stringify({ schema: 1, pilotUserId: input.pilotUserId, idempotencyKeyHash: sha(input.idempotencyKey), taskId: task.id, deliveryId: task.delivery_idempotency_key, runId: control.runId, generation: control.generation, authorizationId: control.authorizationId, deliveryRequestId: control.deliveryRequestId, previousKeyHash: control.previousKeyHash }))
}
export function readSyntheticPilotControl(database: DatabaseSync, input: SyntheticPilotInput, task: SyntheticPilotTask): SyntheticPilotControl {
  const rows = database.prepare('SELECT run_id,generation,authorization_id,delivery_request_id,previous_key_hash,manifest_hash FROM openclaw_synthetic_pilot_control').all() as Array<{ run_id: unknown; generation: unknown; authorization_id: unknown; delivery_request_id: unknown; previous_key_hash: unknown; manifest_hash: unknown }>;
  if (rows.length !== 1) fail('OPENCLAW_SYNTHETIC_CONTROL_UNSAFE')
  const row = rows[0];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof row.run_id !== 'string' || !uuid.test(row.run_id) || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1 || typeof row.authorization_id !== 'string' || !uuid.test(row.authorization_id) || typeof row.delivery_request_id !== 'string' || !uuid.test(row.delivery_request_id)
      || (row.generation === 1 ? row.previous_key_hash !== null : typeof row.previous_key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.previous_key_hash)) || typeof row.manifest_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.manifest_hash)) fail('OPENCLAW_SYNTHETIC_CONTROL_UNSAFE')
  const control = { runId: row.run_id, generation: row.generation as number, authorizationId: row.authorization_id, deliveryRequestId: row.delivery_request_id, previousKeyHash: row.previous_key_hash as string | null, manifestHash: row.manifest_hash } as const;
  if (input.control && (control.runId !== input.control.runId || control.generation !== input.control.generation || control.authorizationId !== input.control.authorizationId || control.deliveryRequestId !== input.control.deliveryRequestId || control.previousKeyHash !== input.control.previousKeyHash)) fail('OPENCLAW_SYNTHETIC_CONTROL_UNSAFE')
  if (controlManifest(input, task, control) !== control.manifestHash) fail('OPENCLAW_SYNTHETIC_CONTROL_UNSAFE')
  const audit = database.prepare('SELECT event_type,manifest_hash FROM openclaw_synthetic_pilot_audit').all() as Array<{ event_type: unknown; manifest_hash: unknown }>;
  if (audit.length !== 1 || audit[0].event_type !== 'created' || audit[0].manifest_hash !== control.manifestHash) fail('OPENCLAW_SYNTHETIC_CONTROL_UNSAFE')
  return control;
}
function assertRulesSealed(database: DatabaseSync): void {
  const rows = database.prepare('SELECT event_type,enabled,recipient_strategy,channel_order_json,config_schema_version,config_json,version,updated_by FROM notification_rules ORDER BY event_type').all() as Array<Record<string, unknown>>;
  const expected = [...defaultRules].sort((left, right) => left[0].localeCompare(right[0]));
  if (rows.length !== expected.length) fail('OPENCLAW_SYNTHETIC_RULES_UNSAFE');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]; const rule = expected[index];
    if (row.event_type !== rule[0] || row.enabled !== 0 || row.recipient_strategy !== rule[1] || row.channel_order_json !== rule[2] || row.config_schema_version !== 1 || row.config_json !== rule[3] || row.version !== 1 || row.updated_by !== null) fail('OPENCLAW_SYNTHETIC_RULES_UNSAFE');
  }
}
function assertTaskStage(task: SyntheticPilotTask, phase: SyntheticSafetyPhase): void {
  const noFailure = task.failure_class === null && task.last_error_code === null && task.last_error_message === null && task.suppression_reason === null && task.cancellation_reason === null && task.failed_at === null && task.suppressed_at === null && task.cancelled_at === null;
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const timing = timestamp.test(task.occurred_at) && task.available_at === task.occurred_at && task.expires_at === plusMinutes(task.occurred_at, 60)
    && timestamp.test(task.created_at) && timestamp.test(task.updated_at) && task.updated_at >= task.created_at;
  const common = task.rule_version === 1 && task.rule_snapshot_json === JSON.stringify({ enabled: true, config: RULE_CONFIG }) && task.max_attempts === 1
    && task.manual_retry_count === 0 && task.lease_recovery_count === 0 && task.retry_allowed === 1 && task.management_audit_json === '[]' && timing;
  if (!common) fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
  if (phase === 'worker') {
    if (task.status !== 'sending' || task.row_version !== 2 || task.attempt_count !== 0 || task.automatic_attempt_count !== 0 || task.last_attempt_at !== null || !task.lease_token || !task.lease_owner || !task.lease_until || task.provider_message_id !== null || task.sent_at !== null || task.retain_until !== null || !noFailure) fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
    return;
  }
  if (task.status === 'pending') {
    if (task.row_version !== 1 || task.created_at !== task.updated_at || task.attempt_count !== 0 || task.automatic_attempt_count !== 0 || task.last_attempt_at !== null || task.lease_token !== null || task.lease_owner !== null || task.lease_until !== null || task.provider_message_id !== null || task.sent_at !== null || task.retain_until !== null || !noFailure) fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
    return;
  }
  if (phase === 'repeat' && task.status === 'sent') {
    if (task.row_version !== 3 || task.attempt_count !== 1 || task.automatic_attempt_count !== 1 || task.lease_token !== null || task.lease_owner !== null || task.lease_until !== null || !task.provider_message_id || !task.sent_at || task.last_attempt_at !== task.sent_at || task.updated_at !== task.sent_at || task.retain_until !== plusMinutes(task.sent_at, 180 * 24 * 60) || !noFailure) fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
    return;
  }
  fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
}
function assertNoSensitiveSnapshot(task: SyntheticPilotTask): void {
  const visible = `${task.message_snapshot_json}\n${task.rule_snapshot_json}`;
  if (/(?:客户|联系人|手机号|微信号|需求|跟进正文|prompt|jwt|cookie|api[_ -]?key|bearer\s+)/i.test(visible)) fail('OPENCLAW_SYNTHETIC_PRIVACY_UNSAFE');
}
/** Full sealed-state proof. It is read-only and is shared by create, retry, queue and Worker gates. */
export function assertSyntheticDatabaseSafety(database: DatabaseSync, input: SyntheticPilotInput, phase: SyntheticSafetyPhase): { id: number; businessDate: string } {
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>;
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('OPENCLAW_SYNTHETIC_INTEGRITY_UNSAFE');
  if (!migrationStateIsCurrent(database)) fail('OPENCLAW_SYNTHETIC_MIGRATION_UNSAFE');
  const users = database.prepare('SELECT id,username,name,password_hash,role,is_active,phone,wx_openid FROM users ORDER BY id').all() as Array<Record<string, unknown>>;
  if (users.length !== 1 || users[0].id !== input.pilotUserId || users[0].username !== `openclaw-synthetic-pilot-${input.pilotUserId}` || users[0].name !== 'OpenClaw 隔离测试用户' || users[0].password_hash !== 'synthetic-no-login' || users[0].role !== 'member' || users[0].is_active !== 1 || users[0].phone !== null || users[0].wx_openid !== null) fail('OPENCLAW_SYNTHETIC_USER_UNSAFE');
  assertEmptySensitiveTables(database); assertRulesSealed(database);
  const count = (database.prepare('SELECT COUNT(*) AS count FROM notification_logs').get() as { count: number }).count;
  const task = database.prepare('SELECT * FROM notification_logs').get() as SyntheticPilotTask | undefined;
  if (count !== 1 || !task || !task.id || !isSyntheticPilotTask(task, input.pilotUserId, input.idempotencyKey)) fail('OPENCLAW_SYNTHETIC_TASK_UNSAFE');
  assertTaskStage(task, phase); assertNoSensitiveSnapshot(task); readSyntheticPilotControl(database, input, task);
  return { id: task.id, businessDate: JSON.parse(task.message_snapshot_json).business_date };
}

/**
 * Detects a synthetic DB marker before any Worker task is sent. A marker is
 * deliberately stronger than a claimed-task check: a contaminated batch must
 * fail as a whole, independent of candidate ordering. A normal database with
 * no marker and no synthetic filename takes no branch here.
 */
export function assertSyntheticWorkerBatchSafety(database: DatabaseSync, databasePath: string, configuredPilotUserId: number | undefined, phase: 'repeat' | 'worker'): boolean {
  const markers = database.prepare('SELECT recipient_user_id,delivery_idempotency_key FROM notification_logs WHERE event_source=? ORDER BY id LIMIT 2').all(SYNTHETIC_PILOT_EVENT_SOURCE) as Array<{ recipient_user_id: unknown; delivery_idempotency_key: unknown }>;
  const looksSynthetic = path.isAbsolute(databasePath) && path.basename(path.resolve(databasePath)) === SYNTHETIC_DATABASE_BASENAME;
  if (!markers.length && !looksSynthetic) return false;
  if (markers.length !== 1 || !Number.isSafeInteger(markers[0]?.recipient_user_id) || typeof markers[0]?.delivery_idempotency_key !== 'string') fail('OPENCLAW_SYNTHETIC_DATABASE_UNSAFE');
  const resolved = assertSyntheticDatabasePath(databasePath).databasePath;
  const pilotUserId = markers[0].recipient_user_id as number;
  if (configuredPilotUserId !== undefined && configuredPilotUserId !== pilotUserId) fail('OPENCLAW_SYNTHETIC_PILOT_USER_MISMATCH');
  assertSyntheticDatabaseSafety(database, { databasePath: resolved, pilotUserId, idempotencyKey: markers[0].delivery_idempotency_key as string }, phase);
  return true;
}

/** Validates the complete synthetic envelope before the Worker can use its fixed text. */
export function isSyntheticPilotTask(task: SyntheticPilotTask, pilotUserId: number, idempotencyKey: string): boolean {
  try {
    if (task.event_type !== SYNTHETIC_PILOT_EVENT_TYPE || task.event_source !== SYNTHETIC_PILOT_EVENT_SOURCE || task.subject_type !== 'recipient_digest'
        || task.subject_id !== pilotUserId || task.recipient_user_id !== pilotUserId || task.lead_id !== null || task.actor_user_id !== null || task.old_owner_id !== null || task.new_owner_id !== null
        || task.channel !== 'openclaw' || task.delivery_idempotency_key !== idempotencyKey || task.operation_id !== syntheticOperationId(idempotencyKey) || task.channel_order_snapshot_json !== '["openclaw"]') return false;
    const snapshot = dailySnapshotSchema.parse(JSON.parse(task.message_snapshot_json));
    return JSON.stringify(snapshot) === JSON.stringify(dailySnapshotSchema.parse(syntheticSnapshot(snapshot.business_date)))
      && task.dedupe_key === syntheticDedupeKey(idempotencyKey, pilotUserId, snapshot.business_date);
  } catch { return false; }
}

/** Creates exactly one sealed test user and one OpenClaw outbox task, or verifies the same key's existing result. */
export function enqueueOpenClawSyntheticPilot(input: SyntheticPilotInput): { result: 'created' | 'deduplicated'; taskId: number; businessDate: string; databasePathHash: string; generation: number; manifestHash: string } {
  const validated = validateInput(input); const existed = existsSync(validated.databasePath);
  if (!existed && (existsSync(`${validated.databasePath}-wal`) || existsSync(`${validated.databasePath}-shm`) || readdirSync(path.dirname(validated.databasePath)).length !== 0)) throw new Error('OPENCLAW_SYNTHETIC_DATABASE_NOT_FRESH');
  const database = new DatabaseSync(validated.databasePath, { readOnly: existed, enableForeignKeyConstraints: true });
  try {
    if (existed) {
      const repeat = assertSyntheticDatabaseSafety(database, validated, 'repeat');
      const task = database.prepare('SELECT * FROM notification_logs').get() as SyntheticPilotTask;
      const control = readSyntheticPilotControl(database, validated, task);
      return { result: 'deduplicated', taskId: repeat.id, businessDate: repeat.businessDate, databasePathHash: sha(validated.databasePath).slice(0, 16), generation: control.generation, manifestHash: control.manifestHash };
    }
    configureConnection(database);
    assertArtifactPermissions(validated.databasePath, true);
    runMigrations(database, MIGRATIONS, { log() {} });
    const now = nowDatetime(); const businessDate = now.slice(0, 10); const snapshot = syntheticSnapshot(businessDate);
    database.exec(`CREATE TABLE openclaw_synthetic_pilot_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1),run_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=1),authorization_id TEXT NOT NULL,delivery_request_id TEXT NOT NULL,previous_key_hash TEXT,manifest_hash TEXT NOT NULL);
      CREATE TABLE openclaw_synthetic_pilot_audit (id INTEGER PRIMARY KEY CHECK(id=1),event_type TEXT NOT NULL,manifest_hash TEXT NOT NULL);`);
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('INSERT INTO users(id,username,name,password_hash,role,is_active) VALUES (?,?,?,?,?,1)').run(validated.pilotUserId, `openclaw-synthetic-pilot-${validated.pilotUserId}`, 'OpenClaw 隔离测试用户', 'synthetic-no-login', 'member');
      const result = database.prepare(`INSERT INTO notification_logs(event_type,event_source,operation_id,subject_type,subject_id,lead_id,actor_user_id,old_owner_id,new_owner_id,recipient_user_id,occurred_at,dedupe_key,delivery_idempotency_key,rule_version,rule_snapshot_json,channel_order_snapshot_json,channel,message_snapshot_json,status,max_attempts,available_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        SYNTHETIC_PILOT_EVENT_TYPE, SYNTHETIC_PILOT_EVENT_SOURCE, syntheticOperationId(validated.idempotencyKey), 'recipient_digest', validated.pilotUserId, null, null, null, null, validated.pilotUserId, now,
        syntheticDedupeKey(validated.idempotencyKey, validated.pilotUserId, businessDate), validated.idempotencyKey, 1, JSON.stringify({ enabled: true, config: RULE_CONFIG }), '["openclaw"]', 'openclaw', JSON.stringify(snapshot), 'pending', 1, now, plusMinutes(now, 60),
      );
      const task = database.prepare('SELECT * FROM notification_logs').get() as SyntheticPilotTask;
      const controlBase = validated.control;
      const manifestHash = controlManifest(validated, task, controlBase);
      database.prepare('INSERT INTO openclaw_synthetic_pilot_control(singleton,run_id,generation,authorization_id,delivery_request_id,previous_key_hash,manifest_hash) VALUES (1,?,?,?,?,?,?)').run(controlBase.runId, controlBase.generation, controlBase.authorizationId, controlBase.deliveryRequestId, controlBase.previousKeyHash, manifestHash);
      database.prepare("INSERT INTO openclaw_synthetic_pilot_audit(id,event_type,manifest_hash) VALUES (1,'created',?)").run(manifestHash);
      database.exec('COMMIT;');
      assertArtifactPermissions(validated.databasePath, true);
      const sealed = assertSyntheticDatabaseSafety(database, validated, 'fresh');
      return { result: 'created', taskId: sealed.id, businessDate: sealed.businessDate, databasePathHash: sha(validated.databasePath).slice(0, 16), generation: controlBase.generation, manifestHash };
    } catch (error) { try { database.exec('ROLLBACK;'); } catch {} throw error; }
  } finally { database.close(); }
}
