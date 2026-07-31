import { randomBytes } from 'node:crypto'
import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, AdapterHealth } from '../types.js'
import type { GatewayConfig } from '../config.js'
import { readPocSession, type PocSession } from '../session.js'

export class ILinkAdapter implements ChannelAdapter {
  readonly name = 'ilink' as const
  constructor(private readonly config: GatewayConfig, private readonly fetcher: typeof fetch = fetch) {}
  private session(): PocSession { return readPocSession(this.config) }
  async health(): Promise<AdapterHealth> {
    if (!this.config.ILINK_POC_LIVE_ENABLED) return { status: 'offline', code: 'ILINK_LIVE_DISABLED' }
    try {
      this.session()
      return { status: 'healthy' }
    } catch (error) { return { status: 'login_required', code: error instanceof Error ? error.message : 'ILINK_SESSION_MISSING' } }
  }
  async send(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    if (!this.config.ILINK_POC_LIVE_ENABLED) return { status: 'permanent_failure', errorCode: 'ILINK_LIVE_DISABLED' }
    let session: PocSession
    try { session = this.session() } catch (error) { return { status: 'permanent_failure', errorCode: error instanceof Error ? error.message : 'ILINK_LOGIN_REQUIRED' } }
    const token = session.botToken
    const contextToken = session.contextToken
    if (!this.config.ILINK_POC_API_BASE_URL || !this.config.ILINK_POC_APP_ID) return { status: 'permanent_failure', errorCode: 'ILINK_LOGIN_REQUIRED' }
    if (session.recipientExternalId !== request.recipientExternalId) return { status: 'permanent_failure', errorCode: 'ILINK_RECIPIENT_MISMATCH' }
    const started = performance.now()
    try {
      // 精确对齐官方 api.ts：POST ilink/bot/sendmessage、base_info、iLink-App-*、token 和十进制 uint32 的 X-WECHAT-UIN。
      // base URL 与本地 session 格式没有稳定公开契约，均须在受控实况 PoC 中显式配置/人工导入。
      const endpoint = new URL('ilink/bot/sendmessage', this.config.ILINK_POC_API_BASE_URL.endsWith('/') ? this.config.ILINK_POC_API_BASE_URL : `${this.config.ILINK_POC_API_BASE_URL}/`).toString()
      const uint32 = randomBytes(4).readUInt32BE(0)
      const response = await this.fetcher(endpoint, {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}`,
          'X-WECHAT-UIN': Buffer.from(String(uint32), 'utf8').toString('base64'),
          'iLink-App-Id': this.config.ILINK_POC_APP_ID,
          'iLink-App-ClientVersion': String(this.config.ILINK_POC_CLIENT_VERSION)
        },
        body: JSON.stringify({
          msg: { to_user_id: request.recipientExternalId, context_token: contextToken, item_list: [{ type: 1, text_item: { text: `${request.message.title}\n${request.message.body ?? ''}`.trim() } }] },
          base_info: { channel_version: this.config.ILINK_POC_CHANNEL_VERSION, bot_agent: this.config.ILINK_POC_BOT_AGENT }
        })
      })
      const latencyMs = Math.max(0, Math.round(performance.now() - started))
      if (!response.ok) return { status: response.status === 429 || response.status >= 500 ? 'retryable_failure' : 'permanent_failure', errorCode: response.status === 429 ? 'ILINK_RATE_LIMITED' : 'ILINK_PROVIDER_REJECTED', latencyMs }
      const data = await response.json().catch(() => undefined) as { ret?: number; errcode?: number; message_id?: string | number } | undefined
      if (!data || data.ret !== 0) return { status: 'result_unknown', errorCode: data?.errcode === -14 ? 'ILINK_SESSION_EXPIRED' : 'ILINK_SEND_RESULT_UNKNOWN', latencyMs }
      // README does not define a durable delivery receipt for sendmessage; accepted protocol response is not claimed as final receipt.
      return { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN', latencyMs }
    } catch {
      const latencyMs = Math.max(0, Math.round(performance.now() - started))
      return { status: signal.aborted ? 'retryable_failure' : 'result_unknown', errorCode: signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN', latencyMs }
    }
  }
}
