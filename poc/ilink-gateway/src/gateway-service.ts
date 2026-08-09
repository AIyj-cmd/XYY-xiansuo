import { createHash } from 'node:crypto'
import { IdempotencyStore } from './idempotency-store.js'
import { StateStore } from './state-store.js'
import { assertMessagePolicy, hashMessage } from './message-policy.js'
import type { GatewayConfig } from './config.js'
import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult } from './types.js'

export const WORKER_TIMEOUT_BUFFER_MS = 5_000

export class GatewayService {
  /** In-process waiters for the Hermes single-attempt policy.  Persistent
   * delivery_locks still protect restarts and competing Gateway processes. */
  private readonly singleAttempts = new Map<string, { fingerprint: string; promise: Promise<ChannelDeliveryResult> }>()
  constructor(private readonly config: GatewayConfig, private readonly adapter: ChannelAdapter, private readonly idempotency: IdempotencyStore, private readonly state?: StateStore) {}
  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    // Reject before authorization consumption, idempotency acquisition and any
    // Adapter work. This proves the Worker is waiting longer than this exact
    // Gateway instance's real outbound timer, not merely a mirrored setting.
    if (request.gatewaySendTimeoutMs !== this.config.ILINK_REQUEST_TIMEOUT_MS || request.workerTimeoutMs <= this.config.ILINK_REQUEST_TIMEOUT_MS + WORKER_TIMEOUT_BUFFER_MS) {
      return { status: 'permanent_failure', errorCode: 'ILINK_REQUEST_INVALID' }
    }
    let recipientExternalId: string | undefined
    const isHermes = this.config.ILINK_POC_TRANSPORT === 'hermes'
    if (isHermes) {
      const generation = request.recipientBindingGeneration
      const accountRef = request.recipientAccountRef
      if (!Number.isInteger(generation) || generation === undefined || generation < 1 || typeof accountRef !== 'string' || !/^hr_[A-Za-z0-9_-]{16,96}$/.test(accountRef)) return { status: 'permanent_failure', errorCode: 'ILINK_RECIPIENT_NOT_CONFIGURED' }
      // No raw peer mapping is available to the Gateway.  The vault-resolving
      // overlay receives this exact pair and rejects stale generations.
      recipientExternalId = `hermes:${request.recipientUserId}:${generation}:${accountRef}`
    }
    else if (this.config.recipientMap) {
      const recipient = this.config.recipientMap.get(request.recipientUserId)
      if (!recipient) return { status: 'permanent_failure', errorCode: this.config.ILINK_POC_TRANSPORT === 'hermes' ? 'ILINK_RECIPIENT_NOT_CONFIGURED' : 'OPENCLAW_RECIPIENT_NOT_BOUND' }
      if (!recipient.enabled) return { status: 'permanent_failure', errorCode: this.config.ILINK_POC_TRANSPORT === 'hermes' ? 'ILINK_RECIPIENT_MISMATCH' : 'OPENCLAW_RECIPIENT_DISABLED' }
      recipientExternalId = recipient.target
    } else {
      recipientExternalId = request.recipientUserId === Number(this.config.OPENCLAW_PILOT_USER_ID) ? this.config.ILINK_POC_RECIPIENT_EXTERNAL_ID : undefined
      if (!recipientExternalId) return { status: 'permanent_failure', errorCode: 'OPENCLAW_RECIPIENT_NOT_ALLOWED' }
    }
    try { assertMessagePolicy(request) } catch (error) { return { status: 'permanent_failure', errorCode: error instanceof Error ? error.message : 'ILINK_INTERNAL_ERROR' } }
    const message = { title: request.title, body: request.body, detailUrl: request.detailUrl }
    const messageHash = hashMessage(message)
    const singleAttempt = this.adapter.attemptPolicy === 'single_attempt'
    const fingerprint = `${recipientExternalId}\0${messageHash}`
    if (singleAttempt) {
      const active = this.singleAttempts.get(request.idempotencyKey)
      if (active) {
        if (active.fingerprint !== fingerprint) return { status: 'permanent_failure', errorCode: 'ILINK_IDEMPOTENCY_CONFLICT' }
        const original = await active.promise
        return original.status === 'sent'
          ? original.providerMessageId ? { status: 'deduplicated', providerMessageId: original.providerMessageId, errorCode: 'ILINK_DUPLICATE_SUPPRESSED' } : { status: 'permanent_failure', errorCode: 'ILINK_DEDUPLICATED_RECEIPT_MISSING' }
          : original
      }
      // Hermes has no approved pilot-control contract.  Reject it before an
      // authorization can be consumed or a child process can be started.
      if (request.pilotControl) return { status: 'permanent_failure', errorCode: 'ILINK_PILOT_CONTROL_INVALID' }
    }
    if (request.pilotControl) {
      if (!this.state || request.pilotControl.deliveryRequestId !== request.deliveryId) return { status: 'permanent_failure', errorCode: 'ILINK_PILOT_CONTROL_INVALID' }
      if (!this.state.consumeAuthorization(request.pilotControl, request.idempotencyKey, Date.now())) return { status: 'permanent_failure', errorCode: 'ILINK_PILOT_AUTHORIZATION_INVALID' }
    }
    const execute = async (): Promise<ChannelDeliveryResult> => {
      const prior = this.idempotency.acquire(request.idempotencyKey, recipientExternalId, messageHash, Date.now(), Boolean(request.pilotControl))
      if (prior) {
        if (singleAttempt && prior.status === 'retryable_failure') {
          const burned: ChannelDeliveryResult = { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }
          this.idempotency.finalize(request.idempotencyKey, burned, Date.now())
          return burned
        }
        return prior
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.ILINK_REQUEST_TIMEOUT_MS)
      try {
        const result = await this.adapter.send({ recipientExternalId, ...(isHermes ? { recipientUserId: request.recipientUserId, recipientBindingGeneration: request.recipientBindingGeneration!, recipientAccountRef: request.recipientAccountRef! } : {}), message, idempotencyKey: request.idempotencyKey }, controller.signal)
        // A deduplicated result is usable only when it carries the persisted
        // original local receipt. Never manufacture one in the worker.
        const normalized = singleAttempt && result.status === 'retryable_failure'
          ? { status: 'result_unknown' as const, errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }
          : result
        const safeResult = normalized.status === 'deduplicated' && !normalized.providerMessageId
          ? { status: 'permanent_failure' as const, errorCode: 'ILINK_DEDUPLICATED_RECEIPT_MISSING' }
          : normalized
        this.idempotency.finalize(request.idempotencyKey, safeResult, Date.now())
        if (request.pilotControl) this.state?.finalizeAttempt(request.pilotControl.deliveryRequestId, safeResult.status === 'sent' || safeResult.status === 'deduplicated' ? 'sent' : safeResult.status === 'result_unknown' ? 'result_unknown' : 'explicit_failure', safeResult.providerMessageId, safeResult.errorCode, Date.now())
        return safeResult
      } catch {
        // Once the adapter lease exists, a timeout/abort/disconnect cannot prove
        // the bridge did not submit. Keep the key burned and fail closed.
        const result: ChannelDeliveryResult = { status: 'result_unknown', errorCode: controller.signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN' }
        this.idempotency.finalize(request.idempotencyKey, result, Date.now())
        if (request.pilotControl) this.state?.finalizeAttempt(request.pilotControl.deliveryRequestId, 'result_unknown', undefined, result.errorCode, Date.now())
        return result
      } finally { clearTimeout(timeout) }
    }
    if (!singleAttempt) return execute()
    const promise = execute()
    this.singleAttempts.set(request.idempotencyKey, { fingerprint, promise })
    try { return await promise } finally { this.singleAttempts.delete(request.idempotencyKey) }
  }
  async health(): Promise<Record<string, unknown>> {
    const adapter = await this.adapter.health()
    const failures = this.idempotency.consecutiveFailureCount()
    const status = adapter.status === 'healthy' && adapter.channelStatus !== 'disabled' && failures > 0 ? 'degraded' : adapter.status
    return {
      status,
      gatewayStatus: 'healthy',
      channelStatus: adapter.channelStatus ?? 'enabled',
      adapter: this.adapter.name,
      liveEnabled: this.config.ILINK_POC_LIVE_ENABLED,
      sessionStatus: adapter.sessionStatus ?? (this.config.ILINK_POC_LIVE_ENABLED ? 'unknown' : 'disabled'),
      recentSuccessAt: this.idempotency.recentSuccessAt(),
      consecutiveFailureCount: failures,
      version: '0.1.0',
      code: adapter.code
    }
  }
}

export function maskedIdentifier(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 12) }
