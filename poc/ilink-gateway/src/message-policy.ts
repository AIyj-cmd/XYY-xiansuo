import { createHash } from 'node:crypto'
import type { ChannelDeliveryRequest } from './types.js'

export const SYNTHETIC_MESSAGE = {
  title: '【测试通知】',
  body: 'XYY-xiansuo普通微信通知通道已连接。\n这是一条内部测试消息。'
} as const

const prohibited = [/手机号|微信号|联系人|客户名称|需求|跟进记录|api[_ -]?key|bearer\s+|jwt|token/i]

const INTERNAL_MESSAGES = new Set([
  `${SYNTHETIC_MESSAGE.title}\n${SYNTHETIC_MESSAGE.body}`,
  '【线索负责人提醒】\n你有1条新分配的线索。\n请登录线索系统查看详情。',
  '【到期跟进提醒】\n你今天有待跟进的线索。\n请登录线索系统查看详情并安排处理。',
  '【今日工作摘要】\n今日工作摘要已生成。\n请登录线索系统查看详情。',
])
export function assertMessagePolicy(request: ChannelDeliveryRequest): void {
  const allText = `${request.title}\n${request.body}`
  if (!INTERNAL_MESSAGES.has(allText)) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  if (prohibited.some((pattern) => pattern.test(allText))) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  if (request.detailUrl !== 'https://xs.tomatopia.top/') throw new Error('ILINK_DETAIL_URL_FORBIDDEN')
}

export function hashMessage(message: { title: string; body: string; detailUrl: string }): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

export function syntheticRequest(recipientUserId: number, idempotencyKey: string): ChannelDeliveryRequest {
  return { deliveryId: crypto.randomUUID(), idempotencyKey, recipientUserId, ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' }
}
