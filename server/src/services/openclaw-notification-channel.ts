import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NotificationConfig } from '../config.js';

export type NotificationChannelMessage = { title: string; body?: string; detailPath: string };
export type ChannelResult = { status: 'sent' | 'deduplicated' | 'retryable_failure' | 'permanent_failure' | 'result_unknown'; providerMessageId?: string; errorCode?: string };
export interface NotificationChannel {
  send(recipient: { userId: number }, message: NotificationChannelMessage, idempotencyKey: string, signal: AbortSignal): Promise<ChannelResult>;
}

const DETAIL_URL = 'https://xs.tomatopia.top/';
const SIGNATURE_HEADERS = { timestamp: 'x-ilink-gateway-timestamp', nonce: 'x-ilink-gateway-nonce', signature: 'x-ilink-gateway-signature' } as const;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const freshNonce = () => randomBytes(24).toString('base64url');
const canonicalRequest = (method: string, path: string, timestamp: string, nonce: string, bodySha256: string) => [method.toUpperCase(), path, timestamp, nonce, bodySha256].join('\n');
const sign = (secret: string, canonical: string) => createHmac('sha256', secret).update(canonical).digest('hex');
const templates: Record<string, { title: string; body: string }> = {
  owner_changed: { title: '【线索负责人提醒】', body: '你有1条新分配的线索。\n请登录线索系统查看详情。' },
  scheduled_follow_overdue: { title: '【到期跟进提醒】', body: '你今天有待跟进的线索。\n请登录线索系统查看详情并安排处理。' },
  daily_report: { title: '【今日工作摘要】', body: '今日工作摘要已生成。\n请登录线索系统查看详情。' },
};
export function openClawTimeoutMs(config: NotificationConfig): number { return config.openclawGatewayTimeoutMs; }

/**
 * The worker deliberately discards business snapshots here.  The loopback
 * Gateway receives only a fixed internal reminder and no lead/AI content.
 */
export function openClawMessage(eventType: string): NotificationChannelMessage {
  const template = templates[eventType];
  if (!template) throw Object.assign(new Error('事件未实现'), { code: 'EVENT_NOT_IMPLEMENTED', permanent: true });
  return { ...template, detailPath: DETAIL_URL };
}

export class OpenClawNotificationChannel implements NotificationChannel {
  readonly name = 'openclaw' as const;
  constructor(private readonly config: NotificationConfig) {}

  async send(recipient: { userId: number }, message: NotificationChannelMessage, idempotencyKey: string, signal: AbortSignal): Promise<ChannelResult> {
    if (!this.config.openclawEnabled || !this.config.openclawGatewayUrl || !this.config.openclawGatewaySecret || !this.config.openclawPilotUserId) {
      return { status: 'permanent_failure', errorCode: 'OPENCLAW_CHANNEL_DISABLED' };
    }
    if (recipient.userId !== this.config.openclawPilotUserId) return { status: 'permanent_failure', errorCode: 'OPENCLAW_RECIPIENT_NOT_ALLOWED' };
    const body = JSON.stringify({ deliveryId: randomUUID(), idempotencyKey, recipientUserId: recipient.userId, title: message.title, body: message.body, detailUrl: message.detailPath });
    const timestamp = String(Date.now()); const nonce = freshNonce();
    const canonical = canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body));
    const controller = new AbortController();
    const onAbort = () => controller.abort(); signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), openClawTimeoutMs(this.config));
    try {
      const response = await fetch(`${this.config.openclawGatewayUrl}/deliveries`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.timestamp]: timestamp, [SIGNATURE_HEADERS.nonce]: nonce, [SIGNATURE_HEADERS.signature]: sign(this.config.openclawGatewaySecret, canonical) },
        body,
      });
      const payload = await response.json().catch(() => null) as { data?: ChannelResult; code?: string } | null;
      if (payload?.data && ['sent','deduplicated','retryable_failure','permanent_failure','result_unknown'].includes(payload.data.status)) return payload.data;
      return response.status >= 500 ? { status: 'retryable_failure', errorCode: 'OPENCLAW_GATEWAY_UNAVAILABLE' } : { status: 'permanent_failure', errorCode: payload?.code || 'OPENCLAW_GATEWAY_RESPONSE_INVALID' };
    } catch {
      return controller.signal.aborted ? { status: 'retryable_failure', errorCode: 'OPENCLAW_GATEWAY_TIMEOUT' } : { status: 'retryable_failure', errorCode: 'OPENCLAW_GATEWAY_UNAVAILABLE' };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
}
