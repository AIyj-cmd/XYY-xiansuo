import { createHash } from 'node:crypto'
import { IdempotencyStore } from './idempotency-store.js'
import { assertMessagePolicy, hashMessage } from './message-policy.js'
import type { GatewayConfig } from './config.js'
import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult } from './types.js'

export class GatewayService {
  constructor(private readonly config: GatewayConfig, private readonly adapter: ChannelAdapter, private readonly idempotency: IdempotencyStore) {}
  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (request.recipientExternalId !== this.config.ILINK_POC_RECIPIENT_EXTERNAL_ID) return { status: 'permanent_failure', errorCode: 'ILINK_RECIPIENT_MISMATCH' }
    try { assertMessagePolicy(request) } catch (error) { return { status: 'permanent_failure', errorCode: error instanceof Error ? error.message : 'ILINK_INTERNAL_ERROR' } }
    const messageHash = hashMessage(request.message)
    const prior = this.idempotency.existing(request.idempotencyKey, request.recipientExternalId, messageHash)
    if (prior) return prior
    const now = Date.now()
    this.idempotency.reserve(request.idempotencyKey, request.recipientExternalId, messageHash, now)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.ILINK_REQUEST_TIMEOUT_MS)
    try {
      const result = await this.adapter.send(request, controller.signal)
      this.idempotency.finalize(request.idempotencyKey, result, Date.now())
      return result
    } catch {
      const result: ChannelDeliveryResult = controller.signal.aborted
        ? { status: 'retryable_failure', errorCode: 'ILINK_SEND_TIMEOUT' }
        : { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }
      this.idempotency.finalize(request.idempotencyKey, result, Date.now())
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
