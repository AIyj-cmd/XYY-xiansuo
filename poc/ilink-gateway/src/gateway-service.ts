import { createHash } from 'node:crypto'
import { IdempotencyStore } from './idempotency-store.js'
import { StateStore } from './state-store.js'
import { assertMessagePolicy, hashMessage } from './message-policy.js'
import type { GatewayConfig } from './config.js'
import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult } from './types.js'

export class GatewayService {
  constructor(private readonly config: GatewayConfig, private readonly adapter: ChannelAdapter, private readonly idempotency: IdempotencyStore, private readonly state?: StateStore) {}
  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (request.recipientUserId !== Number(this.config.OPENCLAW_PILOT_USER_ID)) return { status: 'permanent_failure', errorCode: 'OPENCLAW_RECIPIENT_NOT_ALLOWED' }
    try { assertMessagePolicy(request) } catch (error) { return { status: 'permanent_failure', errorCode: error instanceof Error ? error.message : 'ILINK_INTERNAL_ERROR' } }
    if (request.pilotControl) {
      if (!this.state || request.pilotControl.deliveryRequestId !== request.deliveryId) return { status: 'permanent_failure', errorCode: 'ILINK_PILOT_CONTROL_INVALID' }
      if (!this.state.consumeAuthorization(request.pilotControl, request.idempotencyKey, Date.now())) return { status: 'permanent_failure', errorCode: 'ILINK_PILOT_AUTHORIZATION_INVALID' }
    }
    const message = { title: request.title, body: request.body, detailUrl: request.detailUrl }
    const messageHash = hashMessage(message)
    const prior = this.idempotency.acquire(request.idempotencyKey, this.config.ILINK_POC_RECIPIENT_EXTERNAL_ID, messageHash, Date.now(), Boolean(request.pilotControl))
    if (prior) return prior
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.ILINK_REQUEST_TIMEOUT_MS)
    try {
      const result = await this.adapter.send({ recipientExternalId: this.config.ILINK_POC_RECIPIENT_EXTERNAL_ID, message, idempotencyKey: request.idempotencyKey }, controller.signal)
      // A deduplicated result is usable only when it carries the persisted
      // original local receipt. Never manufacture one in the worker.
      const safeResult = result.status === 'deduplicated' && !result.providerMessageId
        ? { status: 'permanent_failure' as const, errorCode: 'ILINK_DEDUPLICATED_RECEIPT_MISSING' }
        : result
      this.idempotency.finalize(request.idempotencyKey, safeResult, Date.now())
      if (request.pilotControl) this.state?.finalizeAttempt(request.pilotControl.deliveryRequestId, safeResult.status === 'sent' || safeResult.status === 'deduplicated' ? 'sent' : safeResult.status === 'result_unknown' ? 'result_unknown' : 'explicit_failure', safeResult.providerMessageId, safeResult.errorCode, Date.now())
      return safeResult
    } catch {
      // Once the adapter lease exists, a timeout/abort/disconnect cannot prove
      // the official bridge did not submit. Keep the key burned and fail closed.
      const result: ChannelDeliveryResult = { status: 'result_unknown', errorCode: controller.signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN' }
      this.idempotency.finalize(request.idempotencyKey, result, Date.now())
      if (request.pilotControl) this.state?.finalizeAttempt(request.pilotControl.deliveryRequestId, 'result_unknown', undefined, result.errorCode, Date.now())
      return result
    } finally { clearTimeout(timeout) }
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
