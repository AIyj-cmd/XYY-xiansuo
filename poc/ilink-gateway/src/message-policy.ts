import { createHash } from 'node:crypto'
import type { ChannelDeliveryRequest } from './types.js'

export const SYNTHETIC_MESSAGE = {
  title: '【测试通知】',
  body: 'XYY-xiansuo普通微信通知通道已连接。\n这是一条内部测试消息。'
} as const

const prohibited = [/手机号|微信号|联系人|客户名称|需求|跟进记录|api[_ -]?key|bearer\s+|jwt|token/i]
const ownerChangedTitle = '【新线索已分配】'
const ownerChangedTail = '请登录线索系统查看完整资料。'
const ownerChangedFields = [
  { label: '客户', max: 30, optional: true },
  { label: '联系人', max: 20, optional: true },
  { label: '联系方式', max: 11, optional: true },
  { label: '来源', max: 20, optional: false },
  { label: '需求', max: 80, optional: true },
  { label: '跟进要求', max: 17, optional: false },
] as const
const ownerForbidden = /(?:微信\s*(?:号|ID)|wxid[_-]?\S*|(?:\b(?:wechat|weixin|vx)\b|v信)\s*[:：]\s*\S+|微信\s*[:：]\s*\S+|\b(?:jwt|bearer|api[_ -]?key|token)\b)/i
const unmaskedChinaMobile = /(?<!\d)(?:\+?86[\s-]*)?1[3-9]\d[\s-]*\d{4}[\s-]*\d{4}(?!\d)/
function isValidFollowAt(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?前$/.exec(value)
  if (!match) return false
  const [year, month, day] = match.slice(1, 4).map(Number)
  const [hour, minute] = match[4]?.split(':').map(Number) ?? [0, 0]
  // Validate UTC components exactly; Date's overflow normalization and host
  // time zone must never turn an impossible calendar date into an accepted one.
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day && parsed.getUTCHours() === hour && parsed.getUTCMinutes() === minute
}

const INTERNAL_MESSAGES = new Set([
  `${SYNTHETIC_MESSAGE.title}\n${SYNTHETIC_MESSAGE.body}`,
  '【到期跟进提醒】\n你今天有待跟进的线索。\n请登录线索系统查看详情并安排处理。',
  '【今日工作摘要】\n今日工作摘要已生成。\n请登录线索系统查看详情。',
])
export function assertMessagePolicy(request: ChannelDeliveryRequest): void {
  if (request.title === ownerChangedTitle) {
    assertOwnerChangedMessage(request.body)
    if (request.detailUrl !== 'https://xs.tomatopia.top/') throw new Error('ILINK_DETAIL_URL_FORBIDDEN')
    return
  }
  const allText = `${request.title}\n${request.body}`
  if (!INTERNAL_MESSAGES.has(allText)) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  if (prohibited.some((pattern) => pattern.test(allText))) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  if (request.detailUrl !== 'https://xs.tomatopia.top/') throw new Error('ILINK_DETAIL_URL_FORBIDDEN')
}

function assertOwnerChangedMessage(body: string): void {
  // LF is reserved for the fixed template structure; any other Unicode control,
  // format, line or paragraph separator is rejected fail-closed.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(body.replaceAll('\n', ''))) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  const lines = body.split('\n')
  if (lines.length < 3 || lines.at(-1) !== ownerChangedTail) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
  const seen = new Set<string>(); let previous = -1
  for (const line of lines.slice(0, -1)) {
    const match = /^(客户|联系人|联系方式|来源|需求|跟进要求)：(.+)$/.exec(line)
    if (!match || seen.has(match[1])) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
    const index = ownerChangedFields.findIndex((field) => field.label === match[1])
    if (index <= previous || index < 0) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
    const field = ownerChangedFields[index]
    const value = match[2]
    if (Array.from(value).length > field.max || ownerForbidden.test(value) || unmaskedChinaMobile.test(value)) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
    if (field.label === '联系方式' && !/^1\d{2}\*{4}\d{4}$/.test(value)) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
    if (field.label === '跟进要求' && value !== '请尽快联系' && !isValidFollowAt(value)) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
    seen.add(field.label); previous = index
  }
  if (ownerChangedFields.some((field) => !field.optional && !seen.has(field.label))) throw new Error('ILINK_MESSAGE_POLICY_REJECTED')
}

export function hashMessage(message: { title: string; body: string; detailUrl: string }): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

export function syntheticRequest(recipientUserId: number, idempotencyKey: string): ChannelDeliveryRequest {
  return { deliveryId: crypto.randomUUID(), idempotencyKey, recipientUserId, ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' }
}
