import { createHash } from 'node:crypto';
import { resolveNotificationConfig } from '../config.js';

export type MockMode = 'success' | 'timeout' | 'rate_limit' | 'temporary_5xx' | 'permanent_config_error' | 'duplicate' | 'delay';
export type NotificationRecipient = { userId: number };
export type NotificationMessage = { title: string; body?: string; detailPath: string };
export class MockNotificationChannel {
  readonly name = 'mock' as const;
  constructor(private readonly mode: MockMode = (process.env.NOTIFICATION_MOCK_MODE as MockMode | undefined) || 'success') {}
  async health() { return { status: resolveNotificationConfig().mockEnabled ? 'ok' as const : 'down' as const, code: resolveNotificationConfig().mockEnabled ? undefined : 'mock_disabled' }; }
  async send(_recipient: NotificationRecipient, _message: NotificationMessage, idempotencyKey: string, signal: AbortSignal): Promise<{ providerMessageId: string; deduplicated: boolean }> {
    if (!resolveNotificationConfig().mockEnabled) { const error = Object.assign(new Error('Mock 通道未启用'), { code: 'mock_disabled', permanent: true }); throw error; }
    if (signal.aborted) throw Object.assign(new Error('发送超时'), { code: 'timeout' });
    if (this.mode === 'delay') await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 30); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('发送超时'), { code: 'timeout' })); }, { once: true }); });
    if (this.mode === 'timeout' || this.mode === 'rate_limit' || this.mode === 'temporary_5xx') throw Object.assign(new Error(this.mode), { code: this.mode });
    if (this.mode === 'permanent_config_error') throw Object.assign(new Error('mock 配置错误'), { code: 'invalid_channel_config', permanent: true });
    return { providerMessageId: `mock_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`, deduplicated: this.mode === 'duplicate' };
  }
}
