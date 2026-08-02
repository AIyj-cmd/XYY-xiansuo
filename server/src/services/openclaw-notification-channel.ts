import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NotificationConfig } from '../config.js';

export type PilotControl = { runId: string; generation: number; authorizationId: string; deliveryRequestId: string; previousKeyHash: string | null; manifestHash: string };
export type NotificationChannelMessage = { title: string; body?: string; detailPath: string; pilotControl?: PilotControl };
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
  scheduled_follow_overdue: { title: '【到期跟进提醒】', body: '你今天有待跟进的线索。\n请登录线索系统查看详情并安排处理。' },
  daily_report: { title: '【今日工作摘要】', body: '今日工作摘要已生成。\n请登录线索系统查看详情。' },
};
export function openClawTimeoutMs(config: NotificationConfig): number { return config.openclawGatewayTimeoutMs; }

/**
 * AI scheduler notifications remain fixed reminders. Owner-change content is
 * generated as a sanitized immutable outbox snapshot and passed separately.
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
    const deliveryId = message.pilotControl?.deliveryRequestId ?? randomUUID();
    // OpenClaw Gateway accepts only the fixed no-token H5 entry URL. Mock
    // retains the relative snapshot detailPath through its separate channel.
    const body = JSON.stringify({ deliveryId, idempotencyKey, recipientUserId: recipient.userId, title: message.title, body: message.body, detailUrl: DETAIL_URL, ...(message.pilotControl ? { pilotControl: message.pilotControl } : {}) });
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
      // A syntactically invalid/bare HTTP reply leaves submission unknowable;
      // never turn it into a second automatic attempt.
      return { status: 'result_unknown', errorCode: response.status >= 500 ? 'OPENCLAW_GATEWAY_HTTP_5XX_UNKNOWN' : payload?.code || 'OPENCLAW_GATEWAY_RESPONSE_INVALID' };
    } catch {
      return { status: 'result_unknown', errorCode: controller.signal.aborted ? 'OPENCLAW_GATEWAY_TIMEOUT' : 'OPENCLAW_GATEWAY_CONNECTION_UNKNOWN' };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
}
