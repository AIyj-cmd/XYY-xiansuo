import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { GatewayConfig } from './config.js'
import { StateStore } from './state-store.js'

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (code: string): never => { throw new Error(code) }

export function assertOfflinePilotControl(config: GatewayConfig, operatorUid: number, processes: readonly string[] = defaultProcesses()): void {
  if (config.ILINK_POC_LIVE_ENABLED) fail('ILINK_PILOT_LIVE_MUST_BE_FALSE')
  const uid = process.getuid?.()
  if (typeof uid !== 'number' || uid !== operatorUid) fail('ILINK_PILOT_OPERATOR_UID_MISMATCH')
  if (processes.some((name) => /(?:^|[\s/])openclaw(?:[\s/]|$)|notification-worker\.(?:ts|js)|ilink-gateway.*(?:server|start)|(?:server|start).*ilink-gateway/i.test(name))) fail('ILINK_PILOT_PROCESS_RUNNING')
}
function defaultProcesses(): string[] {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((item) => item.trim()).filter(Boolean)
      .filter((item) => Number(item.split(/\s+/, 1)[0]) !== process.pid)
      .map((item) => item.replace(/^\d+\s+/, ''))
  } catch { return ['openclaw process-inspection-failed'] }
}
export function readPrivateKey(keyFile: string | undefined, stdin: string | undefined): string {
  if (Boolean(keyFile) === Boolean(stdin)) fail('ILINK_PILOT_KEY_SOURCE_REQUIRED')
  if (stdin !== undefined) return validateKey(stdin.trim())
  if (!keyFile || !isAbsolute(keyFile)) fail('ILINK_PILOT_KEY_FILE_INVALID')
  const resolved = resolve(keyFile as string)
  const stat = (() => { try { return lstatSync(resolved) } catch { return undefined } })()
  const uid = process.getuid?.()
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (Number(stat.mode) & 0o777) !== 0o600 || typeof uid !== 'number' || stat.uid !== uid) fail('ILINK_PILOT_KEY_FILE_INVALID')
  try { if (realpathSync(resolved) !== resolved) fail('ILINK_PILOT_KEY_FILE_INVALID') } catch { fail('ILINK_PILOT_KEY_FILE_INVALID') }
  return validateKey(readFileSync(resolved, 'utf8').trim())
}
function validateKey(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(value)) fail('ILINK_PILOT_KEY_INVALID'); return value }
function validateUuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('ILINK_PILOT_IDENTIFIER_INVALID'); return value as string }
function validateHash(value: unknown, nullable = false): string | null { if (nullable && value === null) return null; if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('ILINK_PILOT_HASH_INVALID'); return value as string }
function validateGeneration(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail('ILINK_PILOT_GENERATION_INVALID'); return Number(value) }

export type PilotCliInput = { command: 'legacy-import' | 'confirm' | 'prepare' | 'authorize' | 'cancel' | 'reconcile'; operatorUid: number; keyFile?: string; stdin?: string; runId?: string; generation?: number; previousKeyHash?: string | null; manifestHash?: string; deliveryRequestId?: string; authorizationId?: string; expiresAt?: number; confirmation?: 'confirmed_received' | 'confirmed_not_received' | 'inconclusive'; actualReceivedCount?: number | null }
export function runOfflinePilotControl(config: GatewayConfig, input: PilotCliInput, processes?: readonly string[]): Record<string, unknown> {
  assertOfflinePilotControl(config, input.operatorUid, processes)
  const store = new StateStore(config.stateDir)
  try {
    const now = Date.now()
    if (input.command === 'legacy-import') {
      const runId = validateUuid(input.runId); const deliveryRequestId = validateUuid(input.deliveryRequestId); const manifestHash = validateHash(input.manifestHash) as string
      const keyHash = store.importLegacyUnknownAttempt({ idempotencyKey: readPrivateKey(input.keyFile, input.stdin), runId, deliveryRequestId, manifestHash }, input.operatorUid, now)
      return { status: 'legacy_result_unknown_imported', generation: 1, keyHash: keyHash.slice(0, 16), runIdHash: shortHash(runId).slice(0, 16), deliveryRequestIdHash: shortHash(deliveryRequestId).slice(0, 16) }
    }
    if (input.command === 'confirm') {
      const keyHash = validateHash(input.previousKeyHash) as string
      if (!input.confirmation) fail('ILINK_PILOT_CONFIRMATION_INVALID')
      const confirmation = input.confirmation as NonNullable<PilotCliInput['confirmation']>; const actualReceivedCount = input.actualReceivedCount ?? null
      store.recordManualConfirmation(keyHash, confirmation, input.operatorUid, now, actualReceivedCount)
      return { status: `manually_${confirmation}`, actualReceivedCount, keyHash: keyHash.slice(0, 16) }
    }
    if (input.command === 'prepare') {
      const key = readPrivateKey(input.keyFile, input.stdin)
      const runId = validateUuid(input.runId); const generation = validateGeneration(input.generation); const manifestHash = validateHash(input.manifestHash) as string; const deliveryRequestId = validateUuid(input.deliveryRequestId); const previousKeyHash = validateHash(input.previousKeyHash ?? null, generation === 1) as string | null
      if ((generation === 1) !== (previousKeyHash === null)) fail('ILINK_GENERATION_LINEAGE_INVALID')
      store.prepareGeneration({ runId, generation, deliveryRequestId, previousKeyHash, manifestHash }, key, now)
      return { status: 'prepared', generation, keyHash: shortHash(key).slice(0, 16), runIdHash: shortHash(runId).slice(0, 16), deliveryRequestIdHash: shortHash(deliveryRequestId).slice(0, 16) }
    }
    if (input.command === 'authorize') {
      const runId = validateUuid(input.runId); const generation = validateGeneration(input.generation); const authorizationId = validateUuid(input.authorizationId)
      if (typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) fail('ILINK_PILOT_AUTHORIZATION_INVALID')
      const expiresAt = input.expiresAt as number
      store.authorizeGeneration(runId, generation, authorizationId, input.operatorUid, expiresAt, now)
      return { status: 'execution_authorized', generation, runIdHash: shortHash(runId).slice(0, 16), authorizationIdHash: shortHash(authorizationId).slice(0, 16), expiresAt }
    }
    if (input.command === 'cancel') {
      const runId = validateUuid(input.runId); const generation = validateGeneration(input.generation)
      store.cancelGeneration(runId, generation, input.operatorUid, now)
      return { status: 'cancelled_before_send', generation, runIdHash: shortHash(runId).slice(0, 16) }
    }
    store.verifyAuditChain(); return { status: 'reconciled', audit: 'valid' }
  } finally { store.close() }
}
