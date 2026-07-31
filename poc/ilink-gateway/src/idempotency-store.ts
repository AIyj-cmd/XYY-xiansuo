import { createHash } from 'node:crypto'
import type { ChannelDeliveryResult } from './types.js'
import { StateStore } from './state-store.js'

const recipientHash = (value: string) => createHash('sha256').update(value).digest('hex')
export class IdempotencyStore {
  constructor(private readonly state: StateStore) {}
  existing(key: string, recipientExternalId: string, messageHash: string): ChannelDeliveryResult | undefined {
    const record = this.state.findDelivery(key)
    if (!record) return undefined
    if (record.recipientHash !== recipientHash(recipientExternalId) || record.messageHash !== messageHash) return { status: 'permanent_failure', errorCode: 'ILINK_IDEMPOTENCY_CONFLICT' }
    if (record.status === 'sent') return { status: 'deduplicated', providerMessageId: record.providerMessageId ?? undefined, errorCode: 'ILINK_DUPLICATE_SUPPRESSED' }
    return { status: record.status as ChannelDeliveryResult['status'], providerMessageId: record.providerMessageId ?? undefined, errorCode: record.errorCode ?? undefined }
  }
  reserve(key: string, recipientExternalId: string, messageHash: string, now: number): void {
    this.state.createDelivery({ idempotencyKey: key, recipientHash: recipientHash(recipientExternalId), messageHash, status: 'result_unknown', providerMessageId: null, errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }, now)
  }
  finalize(key: string, result: ChannelDeliveryResult, now: number): void {
    const persistedStatus = result.status === 'deduplicated' ? 'sent' : result.status
    this.state.updateDelivery(key, persistedStatus, result.providerMessageId, result.errorCode, now)
    if (persistedStatus === 'sent') {
      this.state.setMeta('recent_success_at', String(now), now)
      this.state.setMeta('consecutive_failure_count', '0', now)
    } else {
      const current = Number(this.state.getMeta('consecutive_failure_count') ?? '0')
      this.state.setMeta('consecutive_failure_count', String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1), now)
    }
  }
  recentSuccessAt(): number | null {
    const raw = this.state.getMeta('recent_success_at')
    if (raw === undefined) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  consecutiveFailureCount(): number {
    const value = Number(this.state.getMeta('consecutive_failure_count') ?? '0')
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }
}
