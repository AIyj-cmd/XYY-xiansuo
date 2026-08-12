import { createHash } from 'node:crypto'
import type { AdapterDeliveryRequest, AdapterHealth, ChannelAdapter, ChannelDeliveryResult } from '../types.js'
import type { GatewayConfig } from '../config.js'
import { OfficialRuntime, type OfficialSessionResult } from '../official-runtime.js'

export type SendPhase = 'before_request' | 'after_request'
export type OfficialSendResponse = { httpStatus: number; body?: unknown; phase?: SendPhase; runtimeConfirmedMessageId?: string }
export interface OfficialSendTransport {
  send(request: AdapterDeliveryRequest, signal: AbortSignal): Promise<OfficialSendResponse>
}

/**
 * The public CLI bridge is enabled only after a strict capabilities JSON check says it can
 * send text. It never reads OpenClaw private state or accepts token/context values.
 */
export class OpenClawCliTransport implements OfficialSendTransport {
  constructor(private readonly runtime: OfficialRuntime, private readonly channel: string) {}
  async send(request: AdapterDeliveryRequest): Promise<OfficialSendResponse> {
    const command = await this.runtime.sendSynthetic(request.recipientExternalId, `${request.message.title}\n\n${request.message.body ?? ''}`)
    if (command.spawnError) throw new OfficialTransportError('ILINK_GATEWAY_OFFLINE', 'before_request')
    if (command.timedOut) throw new OfficialTransportError('ILINK_SEND_TIMEOUT', 'after_request')
    const cleanStdout = stripTerminalAnsi(command.stdout)
    const cleanStderr = stripTerminalAnsi(command.stderr)
    if (command.exitCode === 1 && !cleanStdout.trim() && isExplicitUnknownTarget(cleanStderr, request.recipientExternalId, this.channel)) return { httpStatus: 400, phase: 'before_request' }
    const body = parseCliJson(cleanStdout)
    // A nonzero raw provider result is still an explicit failure (for example,
    // Unknown target). A ret=0 wrapper response lacks the CLI success contract,
    // so it cannot prove delivery even if the wrapper exited successfully.
    if (body !== undefined && isRawRetResponse(body)) {
      if (body.ret === 0) throw new OfficialTransportError('ILINK_SEND_RESULT_UNKNOWN', 'after_request')
      return { httpStatus: command.exitCode === 0 ? 200 : 400, body, phase: 'after_request' }
    }
    const confirmation = command.exitCode === 0 && !hasExplicitErrorLine(cleanStderr) ? parseRuntimeConfirmation(body, this.channel) : undefined
    if (confirmation) return { httpStatus: 200, runtimeConfirmedMessageId: confirmation, phase: 'after_request' }
    // The CLI ran but did not produce a provider response we can classify: it might have submitted.
    throw new OfficialTransportError(command.timedOut ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN', 'after_request')
  }
}

export class OfficialTransportError extends Error {
  constructor(readonly code: string, readonly phase: SendPhase) { super(code) }
}

function localReceipt(request: AdapterDeliveryRequest, classification: string): string {
  const recipientHash = createHash('sha256').update(request.recipientExternalId).digest('hex')
  const messageHash = createHash('sha256').update(JSON.stringify(request.message)).digest('hex')
  return `ilink-local:${createHash('sha256').update(`${request.idempotencyKey}${recipientHash}${messageHash}${classification}`).digest('hex')}`
}
function safeProviderReceipt(value: string): string { return `ilink-provider:${createHash('sha256').update(value).digest('hex')}` }
function isRawRetResponse(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).ret === 'number' }
function stripTerminalAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function isExplicitUnknownTarget(stderr: string, target: string, channel: string): boolean {
  return new RegExp(`^Error: Unknown target ${escapeRegExp(target)} for ${escapeRegExp(channel)}\\.\\r?\\n?$`).test(stderr)
}
function hasExplicitErrorLine(stderr: string): boolean { return stderr.split(/\r?\n/).some((line) => /^Error:\s+\S(?:.*\S)?$/.test(line)) }
function parseCliJson(stdout: string): unknown {
  const clean = stdout.trim()
  if (!clean) return undefined
  try { return JSON.parse(clean) } catch { /* fall through to exactly one complete JSON output line */ }
  const candidates: unknown[] = []
  const lines = clean.split(/\r?\n/)
  for (let start = 0; start < lines.length;) {
    if (!lines[start].trim().startsWith('{')) { start += 1; continue }
    let parsed: unknown | undefined; let end = start
    for (; end < lines.length; end++) {
      const candidate = lines.slice(start, end + 1).join('\n')
      try { parsed = JSON.parse(candidate); break } catch { /* wait for a complete bounded object */ }
    }
    if (parsed === undefined) return undefined
    candidates.push(parsed); start = end + 1
  }
  return candidates.length === 1 ? candidates[0] : undefined
}
function parseRuntimeConfirmation(value: unknown, channel: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>
  if (envelope.action !== 'send' || envelope.channel !== channel || envelope.dryRun !== false || envelope.handledBy !== 'core' || !Object.hasOwn(envelope, 'payload') || envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return undefined
  const messageId = typeof envelope.messageId === 'string' ? envelope.messageId : undefined
  if (!messageId || !/^[\x21-\x7e]{1,512}$/.test(messageId)) return undefined
  return messageId
}

export function classifyOfficialResponse(request: AdapterDeliveryRequest, response: OfficialSendResponse): ChannelDeliveryResult {
  if (response.runtimeConfirmedMessageId) return { status: 'sent', providerMessageId: response.runtimeConfirmedMessageId }
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
  async send(request: AdapterDeliveryRequest, signal: AbortSignal): Promise<ChannelDeliveryResult> {
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
