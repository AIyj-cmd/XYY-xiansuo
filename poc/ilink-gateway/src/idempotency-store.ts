import { createHash } from 'node:crypto'
import type { ChannelDeliveryResult } from './types.js'
import { StateStore } from './state-store.js'

const recipientHash = (value: string) => createHash('sha256').update(value).digest('hex')
export class IdempotencyStore {
  constructor(private readonly state: StateStore) {}
  acquire(key: string, recipientExternalId: string, messageHash: string, now: number, allowGenerationReservation = false): ChannelDeliveryResult | undefined {
    const acquired = this.state.acquireDelivery(key, recipientHash(recipientExternalId), messageHash, now, allowGenerationReservation)
    if (acquired.acquired) return undefined
    if ('blocked' in acquired) return { status: 'permanent_failure', errorCode: 'ILINK_IDEMPOTENCY_KEY_BURNED' }
    const record = acquired.record
    if (record.recipientHash !== recipientHash(recipientExternalId) || record.messageHash !== messageHash) return { status: 'permanent_failure', errorCode: 'ILINK_IDEMPOTENCY_CONFLICT' }
    if (acquired.retryInProgress) return { status: 'retryable_failure', errorCode: 'ILINK_RETRY_IN_PROGRESS' }
    if (record.status === 'sent') return record.providerMessageId
      ? { status: 'deduplicated', providerMessageId: record.providerMessageId, errorCode: 'ILINK_DUPLICATE_SUPPRESSED' }
      : { status: 'permanent_failure', errorCode: 'ILINK_DEDUPLICATED_RECEIPT_MISSING' }
    return { status: record.status as ChannelDeliveryResult['status'], providerMessageId: record.providerMessageId ?? undefined, errorCode: record.errorCode ?? undefined }
  }
  finalize(key: string, result: ChannelDeliveryResult, now: number): void {
    const persistedStatus = result.status === 'deduplicated' ? 'sent' : result.status
    this.state.finalizeDelivery(key, persistedStatus, result.providerMessageId, result.errorCode, now)
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
