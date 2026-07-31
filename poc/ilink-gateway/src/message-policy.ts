import { createHash } from 'node:crypto'
import type { ChannelDeliveryRequest } from './types.js'

export const SYNTHETIC_MESSAGE = {
  title: '【测试通知】',
  body: '这是一条XYY-xiansuo渠道隔离测试消息。\n不包含真实客户或业务数据。'
} as const

const prohibited = [/手机号|微信号|联系人|客户名称|需求|跟进记录|api[_ -]?key|bearer\s+|jwt|token/i]

export function assertMessagePolicy(request: ChannelDeliveryRequest, allowedDetailUrl?: string): void {
  const allText = `${request.message.title}\n${request.message.body ?? ''}`
  if (request.message.title !== SYNTHETIC_MESSAGE.title || request.message.body !== SYNTHETIC_MESSAGE.body) throw new Error('ILINK_SYNTHETIC_MESSAGE_REQUIRED')
  if (prohibited.some((pattern) => pattern.test(allText))) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  if (request.message.detailUrl && request.message.detailUrl !== allowedDetailUrl) throw new Error('ILINK_DETAIL_URL_FORBIDDEN')
}

export function hashMessage(message: ChannelDeliveryRequest['message']): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

export function syntheticRequest(recipientExternalId: string, idempotencyKey: string): ChannelDeliveryRequest {
  return { deliveryId: crypto.randomUUID(), idempotencyKey, recipientExternalId, message: { ...SYNTHETIC_MESSAGE } }
}
