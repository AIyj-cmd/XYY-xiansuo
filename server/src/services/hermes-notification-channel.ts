import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NotificationConfig } from '../config.js';
import type { ChannelResult, NotificationChannelMessage } from './openclaw-notification-channel.js';

const DETAIL_URL = 'https://xs.tomatopia.top/';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The business process only supplies a CRM user and immutable binding
 * generation. The external Hermes overlay resolves peer/token/cursor from its
 * private vault; there is intentionally no peer map or fallback here.
 */
export class HermesNotificationChannel {
  readonly name = 'hermes' as const;
  constructor(private readonly config: NotificationConfig) {}
  async send(recipient: { userId: number; generation: number }, message: NotificationChannelMessage, idempotencyKey: string, signal: AbortSignal): Promise<ChannelResult> {
    if (!this.config.hermesEnabled || !this.config.hermesGatewayUrl || !this.config.hermesGatewaySecret || recipient.generation < 1) return { status: 'permanent_failure', errorCode: 'HERMES_CHANNEL_DISABLED' };
    // Same authenticated delivery contract as the existing iLink Gateway.
    // Hermes adds only the explicitly-versioned recipient binding generation.
    const body = JSON.stringify({ deliveryId: randomUUID(), idempotencyKey, recipientUserId: recipient.userId, recipientBindingGeneration: recipient.generation, title: message.title, body: message.body, detailUrl: DETAIL_URL, gatewaySendTimeoutMs: this.config.openclawGatewaySendTimeoutMs, workerTimeoutMs: this.config.openclawGatewayTimeoutMs });
    const timestamp = String(Date.now()); const nonce = randomBytes(24).toString('base64url');
    const canonical = ['POST', '/deliveries', timestamp, nonce, sha256(body)].join('\n');
    const controller = new AbortController(); const onAbort = () => controller.abort(); signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.openclawGatewayTimeoutMs);
    try {
      const response = await fetch(`${this.config.hermesGatewayUrl}/deliveries`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': createHmac('sha256', this.config.hermesGatewaySecret).update(canonical).digest('hex') }, body });
      const payload = await response.json().catch(() => null) as { data?: ChannelResult } | null;
      if (payload?.data && ['sent', 'deduplicated', 'retryable_failure', 'permanent_failure', 'result_unknown'].includes(payload.data.status)) return payload.data;
      return { status: 'result_unknown', errorCode: response.status >= 500 ? 'HERMES_GATEWAY_HTTP_5XX_UNKNOWN' : 'HERMES_GATEWAY_RESPONSE_INVALID' };
    } catch { return { status: 'result_unknown', errorCode: controller.signal.aborted ? 'HERMES_GATEWAY_TIMEOUT' : 'HERMES_GATEWAY_CONNECTION_UNKNOWN' }; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
}
