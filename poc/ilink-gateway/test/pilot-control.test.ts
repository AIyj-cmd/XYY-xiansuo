import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig, type GatewayConfig } from '../src/config.js'
import { GatewayService } from '../src/gateway-service.js'
import { IdempotencyStore } from '../src/idempotency-store.js'
import { runPilotControlCli } from '../src/cli/pilot-control.js'
import { SYNTHETIC_MESSAGE } from '../src/message-policy.js'
import { runOfflinePilotControl } from '../src/pilot-control.js'
import { StateStore, type PilotControl } from '../src/state-store.js'
import type { ChannelAdapter } from '../src/types.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function directory(): string { const value = mkdtempSync(join(tmpdir(), 'xiansuo-pilot-ledger-')); chmodSync(value, 0o700); return value }
function config(dir: string): GatewayConfig {
  const secret = join(dir, 'gateway.secret'); writeFileSync(secret, 'a'.repeat(48), { mode: 0o600 }); chmodSync(secret, 0o600)
  const configDir = join(dir, 'openclaw'); mkdirSync(configDir, { mode: 0o700 }); chmodSync(configDir, 0o700)
  return loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: join(configDir, 'config.json'), ILINK_GATEWAY_SECRET_FILE: secret, OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1' })
}

test('pilot control CLI has a command-specific flag allowlist and never accepts a key in argv', () => {
  const dir = directory(); try {
    const cfg = config(dir); const uid = String(process.getuid!()); const prefix = ['node', 'pilot-control.js']
    assert.throws(() => runPilotControlCli([...prefix, 'reconcile', '--operator-uid', uid, '--idempotency-key', 'argv-secret-value'], '', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.throws(() => runPilotControlCli([...prefix, 'reconcile', '--operator-uid', uid, '--operator-uid', uid], '', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.throws(() => runPilotControlCli([...prefix, 'reconcile', '--operator-uid'], '', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.throws(() => runPilotControlCli([...prefix, 'reconcile', '--operator-uid', uid, 'extra-position'], '', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.throws(() => runPilotControlCli([...prefix, 'prepare', '--operator-uid', uid, '--run-id', randomUUID(), '--generation', '1', '--delivery-request-id', randomUUID(), '--manifest-hash', sha('argv'), '--stdin', 'argv-secret-value'], '', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.throws(() => runPilotControlCli([...prefix, 'prepare', '--operator-uid', uid, '--run-id', randomUUID(), '--generation', '1', '--delivery-request-id', randomUUID(), '--manifest-hash', sha('both-sources'), '--stdin', '--key-file', join(dir, 'key')], 'safe-key-from-stdin', cfg, []), /ILINK_PILOT_CLI_USAGE/)
    assert.deepEqual(runPilotControlCli([...prefix, 'reconcile', '--operator-uid', uid], '', cfg, []), { status: 'reconciled', audit: 'valid' })
    const keyFile = join(dir, 'prepare.key'); writeFileSync(keyFile, 'file-only-key-123456', { mode: 0o600 }); chmodSync(keyFile, 0o600)
    assert.equal((runPilotControlCli([...prefix, 'prepare', '--operator-uid', uid, '--run-id', randomUUID(), '--generation', '1', '--delivery-request-id', randomUUID(), '--manifest-hash', sha('legal-prepare'), '--key-file', keyFile], '', cfg, []) as { status: string }).status, 'prepared')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('offline pilot ledger burns legacy keys, appends manual facts, enforces linear generations and consumes authority once', () => {
  const dir = directory(); try {
    const cfg = config(dir); const operatorUid = process.getuid!(); const legacyFile = join(dir, 'legacy.key'); writeFileSync(legacyFile, 'legacy-key-123456', { mode: 0o600 }); chmodSync(legacyFile, 0o600)
    const legacyRun = randomUUID(); const legacyRequest = randomUUID(); const legacyManifest = sha('legacy-manifest')
    assert.deepEqual(runOfflinePilotControl(cfg, { command: 'legacy-import', operatorUid, keyFile: legacyFile, runId: legacyRun, deliveryRequestId: legacyRequest, manifestHash: legacyManifest }, []), {
      status: 'legacy_result_unknown_imported', generation: 1, keyHash: sha('legacy-key-123456').slice(0, 16), runIdHash: sha(legacyRun).slice(0, 16), deliveryRequestIdHash: sha(legacyRequest).slice(0, 16)
    })
    assert.deepEqual(runOfflinePilotControl(cfg, { command: 'confirm', operatorUid, previousKeyHash: sha('legacy-key-123456'), confirmation: 'confirmed_not_received', actualReceivedCount: 0 }, []), { status: 'manually_confirmed_not_received', actualReceivedCount: 0, keyHash: sha('legacy-key-123456').slice(0, 16) })
    assert.throws(() => runOfflinePilotControl(cfg, { command: 'legacy-import', operatorUid, keyFile: legacyFile, runId: legacyRun, deliveryRequestId: legacyRequest, manifestHash: legacyManifest }, []), /ALREADY_RESERVED/)
    const legacyNextKey = 'legacy-next-generation-key'; const legacyNextFile = join(dir, 'legacy-next.key'); writeFileSync(legacyNextFile, legacyNextKey, { mode: 0o600 }); chmodSync(legacyNextFile, 0o600)
    assert.equal((runOfflinePilotControl(cfg, { command: 'prepare', operatorUid, keyFile: legacyNextFile, runId: legacyRun, generation: 2, previousKeyHash: sha('legacy-key-123456'), deliveryRequestId: randomUUID(), manifestHash: sha('legacy-next-manifest') }, []) as { generation: number }).generation, 2)
    const store = new StateStore(dir); const runId = randomUUID(); const key1 = 'generation-one-key-123'; const request1 = randomUUID(); const manifest1 = sha('manifest-1')
    store.prepareGeneration({ runId, generation: 1, deliveryRequestId: request1, previousKeyHash: null, manifestHash: manifest1 }, key1, 100)
    const authorization = randomUUID(); store.authorizeGeneration(runId, 1, authorization, operatorUid, 1_000, 200)
    const control: PilotControl = { runId, generation: 1, authorizationId: authorization, deliveryRequestId: request1, previousKeyHash: null, manifestHash: manifest1 }
    assert.equal(store.consumeAuthorization(control, key1, 300), true); assert.equal(store.consumeAuthorization(control, key1, 301), false)
    store.finalizeAttempt(request1, 'result_unknown', undefined, 'ILINK_SEND_TIMEOUT', 302)
    store.recordManualConfirmation(sha(key1), 'confirmed_not_received', operatorUid, 400)
    const key2 = 'generation-two-key-123'; const request2 = randomUUID(); store.prepareGeneration({ runId, generation: 2, deliveryRequestId: request2, previousKeyHash: sha(key1), manifestHash: sha('manifest-2') }, key2, 401)
    assert.throws(() => store.prepareGeneration({ runId, generation: 4, deliveryRequestId: randomUUID(), previousKeyHash: sha(key2), manifestHash: sha('skip') }, 'generation-four-key-123', 402), /LINEAGE_INVALID/)
    store.verifyAuditChain(); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('StateStore rejects unsafe private directory before opening SQLite', () => {
  const dir = directory(); try { chmodSync(dir, 0o755); assert.throws(() => new StateStore(dir), /ILINK_STATE_DIR_UNSAFE/) } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('adapter timeout after a consumed pilot authorization is result_unknown and cannot call adapter twice', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const store = new StateStore(dir); const runId = randomUUID(); const requestId = randomUUID(); const key = 'unknown-once-key-123'; const manifestHash = sha('manifest'); const authorizationId = randomUUID(); const uid = process.getuid!()
    store.prepareGeneration({ runId, generation: 1, deliveryRequestId: requestId, previousKeyHash: null, manifestHash }, key, 1); store.authorizeGeneration(runId, 1, authorizationId, uid, Date.now() + 60_000, Date.now())
    let calls = 0; const adapter: ChannelAdapter = { name: 'fake', health: async () => ({ status: 'healthy' }), send: async () => { calls += 1; throw new Error('disconnect') } }
    const service = new GatewayService(cfg, adapter, new IdempotencyStore(store), store)
    const request = { deliveryId: requestId, idempotencyKey: key, recipientUserId: 1, ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' as const, pilotControl: { runId, generation: 1, authorizationId, deliveryRequestId: requestId, previousKeyHash: null, manifestHash } }
    assert.equal((await service.deliver(request)).status, 'result_unknown'); assert.equal((await service.deliver(request)).status, 'permanent_failure'); assert.equal(calls, 1); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attempt finalization has one terminal audit fact under repeats and concurrent calls', async () => {
  const dir = directory(); try {
    const store = new StateStore(dir); const uid = process.getuid!(); const runId = randomUUID(); const requestId = randomUUID(); const authorizationId = randomUUID(); const key = 'single-finalization-key'; const manifestHash = sha('single-finalization')
    store.prepareGeneration({ runId, generation: 1, deliveryRequestId: requestId, previousKeyHash: null, manifestHash }, key, 1)
    store.authorizeGeneration(runId, 1, authorizationId, uid, 99_999, 2)
    assert.equal(store.consumeAuthorization({ runId, generation: 1, authorizationId, deliveryRequestId: requestId, previousKeyHash: null, manifestHash }, key, 3), true)
    store.finalizeAttempt(requestId, 'result_unknown', undefined, 'ILINK_SEND_RESULT_UNKNOWN', 4)
    assert.equal(store.auditEventCount('attempt_finalized'), 1)
    assert.throws(() => store.finalizeAttempt(requestId, 'sent', 'must-not-replace', undefined, 5), /ILINK_ATTEMPT_ALREADY_FINALIZED/)
    const repeats = await Promise.all(Array.from({ length: 4 }, async () => {
      try { store.finalizeAttempt(requestId, 'sent', 'must-not-replace', undefined, 6); return 'unexpected_success' } catch (error) { return error instanceof Error ? error.message : 'unknown_error' }
    }))
    assert.deepEqual(repeats, Array(4).fill('ILINK_ATTEMPT_ALREADY_FINALIZED'))
    assert.equal(store.auditEventCount('attempt_finalized'), 1)
    store.verifyAuditChain(); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('manual confirmation is a single terminal fact for a real result_unknown attempt', () => {
  const dir = directory(); try {
    const store = new StateStore(dir); const uid = process.getuid!()
    assert.throws(() => store.recordManualConfirmation(sha('missing-key-123456'), 'confirmed_not_received', uid, 1), /ILINK_MANUAL_CONFIRMATION_TARGET_INVALID/)

    const explicitKey = 'explicit-failure-key-123'; const explicitRun = randomUUID(); const explicitRequest = randomUUID(); const explicitAuthorization = randomUUID(); const explicitManifest = sha('explicit')
    store.prepareGeneration({ runId: explicitRun, generation: 1, deliveryRequestId: explicitRequest, previousKeyHash: null, manifestHash: explicitManifest }, explicitKey, 2)
    store.authorizeGeneration(explicitRun, 1, explicitAuthorization, uid, 99_999, 3)
    assert.equal(store.consumeAuthorization({ runId: explicitRun, generation: 1, authorizationId: explicitAuthorization, deliveryRequestId: explicitRequest, previousKeyHash: null, manifestHash: explicitManifest }, explicitKey, 3), true)
    // A completed attempt with a known failure never permits a manual duplicate decision.
    store.finalizeAttempt(explicitRequest, 'explicit_failure', undefined, 'ILINK_PROVIDER_REJECTED', 4)
    assert.throws(() => store.recordManualConfirmation(sha(explicitKey), 'confirmed_not_received', uid, 5), /ILINK_MANUAL_CONFIRMATION_TARGET_INVALID/)

    const key = 'confirmed-received-key-123'; const runId = randomUUID(); const request = randomUUID(); const authorization = randomUUID(); const manifestHash = sha('received')
    store.prepareGeneration({ runId, generation: 1, deliveryRequestId: request, previousKeyHash: null, manifestHash }, key, 10)
    store.authorizeGeneration(runId, 1, authorization, uid, 99_999, 11)
    assert.equal(store.consumeAuthorization({ runId, generation: 1, authorizationId: authorization, deliveryRequestId: request, previousKeyHash: null, manifestHash }, key, 12), true)
    store.finalizeAttempt(request, 'result_unknown', undefined, 'ILINK_SEND_RESULT_UNKNOWN', 13)
    store.recordManualConfirmation(sha(key), 'confirmed_received', uid, 14, 1)
    assert.throws(() => store.recordManualConfirmation(sha(key), 'confirmed_not_received', uid, 15), /ILINK_MANUAL_CONFIRMATION_ALREADY_FINAL/)
    assert.throws(() => store.prepareGeneration({ runId, generation: 2, deliveryRequestId: randomUUID(), previousKeyHash: sha(key), manifestHash: sha('received-next') }, 'received-next-key-123', 16), /ILINK_GENERATION_LINEAGE_INVALID/)

    const unknownKey = 'not-received-key-123456'; const unknownRun = randomUUID(); const unknownRequest = randomUUID(); const unknownAuth = randomUUID(); const unknownManifest = sha('not-received')
    store.prepareGeneration({ runId: unknownRun, generation: 1, deliveryRequestId: unknownRequest, previousKeyHash: null, manifestHash: unknownManifest }, unknownKey, 20)
    store.authorizeGeneration(unknownRun, 1, unknownAuth, uid, 99_999, 21)
    assert.equal(store.consumeAuthorization({ runId: unknownRun, generation: 1, authorizationId: unknownAuth, deliveryRequestId: unknownRequest, previousKeyHash: null, manifestHash: unknownManifest }, unknownKey, 22), true)
    store.finalizeAttempt(unknownRequest, 'result_unknown', undefined, 'ILINK_SEND_RESULT_UNKNOWN', 23)
    store.recordManualConfirmation(sha(unknownKey), 'confirmed_not_received', uid, 24)
    assert.doesNotThrow(() => store.prepareGeneration({ runId: unknownRun, generation: 2, deliveryRequestId: randomUUID(), previousKeyHash: sha(unknownKey), manifestHash: sha('not-received-next') }, 'not-received-next-key', 25))

    const inconclusiveKey = 'inconclusive-key-123456'; const inconclusiveRun = randomUUID(); const inconclusiveRequest = randomUUID(); const inconclusiveAuth = randomUUID(); const inconclusiveManifest = sha('inconclusive')
    store.prepareGeneration({ runId: inconclusiveRun, generation: 1, deliveryRequestId: inconclusiveRequest, previousKeyHash: null, manifestHash: inconclusiveManifest }, inconclusiveKey, 30)
    store.authorizeGeneration(inconclusiveRun, 1, inconclusiveAuth, uid, 99_999, 31)
    assert.equal(store.consumeAuthorization({ runId: inconclusiveRun, generation: 1, authorizationId: inconclusiveAuth, deliveryRequestId: inconclusiveRequest, previousKeyHash: null, manifestHash: inconclusiveManifest }, inconclusiveKey, 32), true)
    store.finalizeAttempt(inconclusiveRequest, 'result_unknown', undefined, 'ILINK_SEND_RESULT_UNKNOWN', 33)
    store.recordManualConfirmation(sha(inconclusiveKey), 'inconclusive', uid, 34)
    assert.throws(() => store.prepareGeneration({ runId: inconclusiveRun, generation: 2, deliveryRequestId: randomUUID(), previousKeyHash: sha(inconclusiveKey), manifestHash: sha('inconclusive-next') }, 'inconclusive-next-key', 35), /ILINK_GENERATION_LINEAGE_INVALID/)
    store.verifyAuditChain(); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('burned and generation-reserved keys are rejected by the ordinary gateway before the adapter', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const store = new StateStore(dir); const uid = process.getuid!(); let calls = 0
    const adapter: ChannelAdapter = { name: 'fake', health: async () => ({ status: 'healthy' }), send: async () => { calls += 1; return { status: 'sent', providerMessageId: 'receipt-1' } } }
    const service = new GatewayService(cfg, adapter, new IdempotencyStore(store), store)
    const ordinary = (idempotencyKey: string) => ({ deliveryId: randomUUID(), idempotencyKey, recipientUserId: 1, ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' as const })

    const legacyKey = 'legacy-gateway-block-key'; store.importLegacyUnknownAttempt({ idempotencyKey: legacyKey, runId: randomUUID(), deliveryRequestId: randomUUID(), manifestHash: sha('legacy-gateway') }, uid, 1)
    const [first, second] = await Promise.all([service.deliver(ordinary(legacyKey)), service.deliver(ordinary(legacyKey))])
    assert.deepEqual([first.status, second.status], ['permanent_failure', 'permanent_failure'])
    assert.deepEqual([first.errorCode, second.errorCode], ['ILINK_IDEMPOTENCY_KEY_BURNED', 'ILINK_IDEMPOTENCY_KEY_BURNED'])

    const generatedKey = 'generation-gateway-block-key'; store.prepareGeneration({ runId: randomUUID(), generation: 1, deliveryRequestId: randomUUID(), previousKeyHash: null, manifestHash: sha('reserved-generation') }, generatedKey, 2)
    const generated = await service.deliver(ordinary(generatedKey))
    assert.equal(generated.status, 'permanent_failure'); assert.equal(generated.errorCode, 'ILINK_IDEMPOTENCY_KEY_BURNED')
    assert.equal(calls, 0)
    store.verifyAuditChain(); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
