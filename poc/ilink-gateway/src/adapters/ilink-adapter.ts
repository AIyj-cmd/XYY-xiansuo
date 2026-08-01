import { createHash } from 'node:crypto'
import type { AdapterHealth, ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult } from '../types.js'
import type { GatewayConfig } from '../config.js'
import { OfficialRuntime, type OfficialSessionResult } from '../official-runtime.js'

export type SendPhase = 'before_request' | 'after_request'
export type OfficialSendResponse = { httpStatus: number; body?: unknown; phase?: SendPhase; runtimeConfirmedMessageId?: string }
export interface OfficialSendTransport {
  send(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>, signal: AbortSignal): Promise<OfficialSendResponse>
}

/**
 * The public CLI bridge is enabled only after a strict capabilities JSON check says it can
 * send text. It never reads OpenClaw private state or accepts token/context values.
 */
export class OpenClawCliTransport implements OfficialSendTransport {
  constructor(private readonly runtime: OfficialRuntime, private readonly channel: string) {}
  async send(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>): Promise<OfficialSendResponse> {
    const command = await this.runtime.sendSynthetic(request.recipientExternalId, `${request.message.title}\n\n${request.message.body ?? ''}`)
    if (command.spawnError) throw new OfficialTransportError('ILINK_GATEWAY_OFFLINE', 'before_request')
    let body: unknown
    try { body = JSON.parse(command.stdout) } catch { body = undefined }
    // A raw provider ret, if present, remains a provider response even when the wrapper exits non-zero.
    if (body !== undefined && isRawRetResponse(body)) return { httpStatus: 200, body, phase: 'after_request' }
    const confirmation = command.exitCode === 0 ? parseRuntimeConfirmation(body, this.channel) : undefined
    if (confirmation) return { httpStatus: 200, runtimeConfirmedMessageId: confirmation, phase: 'after_request' }
    // The CLI ran but did not produce a provider response we can classify: it might have submitted.
    throw new OfficialTransportError(command.timedOut ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN', 'after_request')
  }
}

export class OfficialTransportError extends Error {
  constructor(readonly code: string, readonly phase: SendPhase) { super(code) }
}

function localReceipt(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>, classification: string): string {
  const recipientHash = createHash('sha256').update(request.recipientExternalId).digest('hex')
  const messageHash = createHash('sha256').update(JSON.stringify(request.message)).digest('hex')
  return `ilink-local:${createHash('sha256').update(`${request.idempotencyKey}${recipientHash}${messageHash}${classification}`).digest('hex')}`
}
function safeProviderReceipt(value: string): string { return `ilink-provider:${createHash('sha256').update(value).digest('hex')}` }
function isRawRetResponse(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).ret === 'number' }
function parseRuntimeConfirmation(value: unknown, channel: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>; const result = envelope.result
  if (envelope.ok !== true || result === null || typeof result !== 'object' || Array.isArray(result)) return undefined
  const data = result as Record<string, unknown>
  const messageId = typeof data.messageId === 'string' ? data.messageId : undefined
  const channelFields = [envelope.channel, data.channel].filter((field) => field !== undefined)
  const providerChannelIds = [envelope.channelId, data.channelId].filter((field) => field !== undefined)
  if (!messageId || !/^[\x21-\x7e]{1,512}$/.test(messageId)) return undefined
  if (channelFields.some((field) => typeof field !== 'string' || field !== channel)) return undefined
  if (providerChannelIds.some((field) => (typeof field !== 'string' && typeof field !== 'number') || String(field).length === 0 || String(field).length > 512 || !/^[\x20-\x7e]+$/.test(String(field)))) return undefined
  return messageId
}

export function classifyOfficialResponse(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>, response: OfficialSendResponse): ChannelDeliveryResult {
  if (response.runtimeConfirmedMessageId) return { status: 'sent', providerMessageId: `ilink-runtime:${createHash('sha256').update(response.runtimeConfirmedMessageId).digest('hex')}` }
  const data = response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body) ? response.body as Record<string, unknown> : undefined
  const ret = data?.ret
  if (response.httpStatus >= 200 && response.httpStatus < 300 && ret === 0) {
    const candidate = typeof data?.message_id === 'string' || typeof data?.message_id === 'number' ? String(data.message_id) : undefined
    return { status: 'sent', providerMessageId: candidate ? safeProviderReceipt(candidate) : localReceipt(request, 'ret=0') }
  }
  if (typeof ret !== 'number') return { status: response.phase === 'before_request' ? 'permanent_failure' : 'result_unknown', errorCode: response.phase === 'before_request' ? 'ILINK_PROVIDER_REJECTED' : 'ILINK_SEND_RESULT_UNKNOWN' }
  const code = data?.errcode
  if (ret === -14 || code === -14) return { status: 'permanent_failure', errorCode: 'ILINK_SESSION_EXPIRED' }
  if (response.httpStatus === 401) return { status: 'permanent_failure', errorCode: 'ILINK_LOGIN_REQUIRED' }
  if (response.httpStatus === 403) return { status: 'permanent_failure', errorCode: 'ILINK_ACCOUNT_RESTRICTED' }
  if (response.httpStatus === 429 || code === 429) return { status: 'retryable_failure', errorCode: 'ILINK_RATE_LIMITED' }
  if (response.httpStatus >= 500) return { status: 'retryable_failure', errorCode: 'ILINK_GATEWAY_OFFLINE' }
  return { status: 'permanent_failure', errorCode: 'ILINK_PROVIDER_REJECTED' }
}

function healthFromSession(session: OfficialSessionResult): AdapterHealth {
  if (session.state === 'authenticated') return { status: 'healthy', sessionStatus: session.state, channelStatus: 'enabled' }
  if (session.state === 'login_required' || session.state === 'expired') return { status: 'login_required', sessionStatus: session.state, channelStatus: 'enabled', code: session.code }
  if (session.state === 'restricted') return { status: 'restricted', sessionStatus: session.state, channelStatus: 'enabled', code: session.code }
  if (session.state === 'unsupported') return { status: 'unsupported', sessionStatus: session.state, channelStatus: 'enabled', code: session.code }
  if (session.state === 'offline') return { status: 'offline', sessionStatus: session.state, channelStatus: 'enabled', code: session.code }
  return { status: 'degraded', sessionStatus: 'unknown', channelStatus: 'enabled', code: session.code ?? 'ILINK_SESSION_STATUS_UNKNOWN' }
}

export class ILinkAdapter implements ChannelAdapter {
  readonly name = 'ilink' as const
  constructor(private readonly config: GatewayConfig, private readonly runtime: OfficialRuntime = new OfficialRuntime(config), private readonly transport: OfficialSendTransport = new OpenClawCliTransport(runtime, config.ILINK_OPENCLAW_CHANNEL)) {}
  async health(): Promise<AdapterHealth> {
    if (!this.config.ILINK_POC_LIVE_ENABLED) return { status: 'healthy', channelStatus: 'disabled', code: 'ILINK_LIVE_DISABLED' }
    return healthFromSession(await this.runtime.sessionStatus())
  }
  async send(request: Pick<ChannelDeliveryRequest, 'recipientExternalId' | 'message' | 'idempotencyKey'>, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    if (!this.config.ILINK_POC_LIVE_ENABLED) return { status: 'permanent_failure', errorCode: 'ILINK_LIVE_DISABLED' }
    const session = await this.runtime.sessionStatus()
    const health = healthFromSession(session)
    if (health.status !== 'healthy') return { status: health.status === 'offline' ? 'retryable_failure' : 'permanent_failure', errorCode: health.code ?? 'ILINK_LOGIN_REQUIRED' }
    const started = performance.now()
    try {
      const result = classifyOfficialResponse(request, await this.transport.send(request, signal))
      return { ...result, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(performance.now() - started))
      if (error instanceof OfficialTransportError) return { status: error.phase === 'after_request' ? 'result_unknown' : error.code === 'ILINK_GATEWAY_OFFLINE' ? 'retryable_failure' : 'permanent_failure', errorCode: error.code, latencyMs }
      return { status: signal.aborted ? 'result_unknown' : 'permanent_failure', errorCode: signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_PROVIDER_REJECTED', latencyMs }
    }
  }
}

export class MockOfficialSendTransport implements OfficialSendTransport {
  constructor(private readonly response?: OfficialSendResponse, private readonly error?: OfficialTransportError) {}
  async send(): Promise<OfficialSendResponse> { if (this.error) throw this.error; return this.response ?? { httpStatus: 200, body: { ret: 0 } } }
}
