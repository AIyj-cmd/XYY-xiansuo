import { createHash } from 'node:crypto'
import type { AdapterDeliveryRequest, ChannelAdapter, ChannelDeliveryResult, AdapterHealth } from '../types.js'

export type FakeMode = 'success' | 'duplicate' | 'timeout' | 'retryable_failure' | 'permanent_failure' | 'result_unknown' | 'offline' | 'login_required' | 'delay'

export class FakeAdapter implements ChannelAdapter {
  readonly name = 'fake' as const
  constructor(private readonly mode: FakeMode = 'success', private readonly delayMs = 0) {}
  async send(request: AdapterDeliveryRequest, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    if (this.delayMs || this.mode === 'delay') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs || 10)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
    if (signal.aborted || this.mode === 'timeout') return { status: 'retryable_failure', errorCode: 'ILINK_SEND_TIMEOUT' }
    if (this.mode === 'duplicate') return { status: 'deduplicated', errorCode: 'ILINK_DUPLICATE_SUPPRESSED' }
    if (this.mode === 'retryable_failure') return { status: 'retryable_failure', errorCode: 'ILINK_GATEWAY_OFFLINE' }
    if (this.mode === 'permanent_failure') return { status: 'permanent_failure', errorCode: 'ILINK_PROVIDER_REJECTED' }
    if (this.mode === 'result_unknown') return { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }
    if (this.mode === 'offline') return { status: 'retryable_failure', errorCode: 'ILINK_GATEWAY_OFFLINE' }
    if (this.mode === 'login_required') return { status: 'permanent_failure', errorCode: 'ILINK_LOGIN_REQUIRED' }
    return { status: 'sent', providerMessageId: `fake-${createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 24)}`, latencyMs: 0 }
  }
  async health(): Promise<AdapterHealth> {
    if (this.mode === 'offline') return { status: 'offline', code: 'ILINK_GATEWAY_OFFLINE' }
    if (this.mode === 'login_required') return { status: 'login_required', code: 'ILINK_LOGIN_REQUIRED' }
    return { status: 'healthy' }
  }
}
