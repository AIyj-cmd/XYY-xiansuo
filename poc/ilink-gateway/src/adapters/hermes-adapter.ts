import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { AdapterDeliveryRequest, AdapterHealth, ChannelAdapter, ChannelDeliveryResult } from '../types.js'
import type { GatewayConfig } from '../config.js'

const MAX_CLI_OUTPUT_BYTES = 64 * 1024
const TERM_GRACE_MS = 250

export type HermesCommandResult = { exitCode: number | null; stdout: string; spawnError?: NodeJS.ErrnoException; timedOut?: boolean; aborted?: boolean; invalidOutput?: boolean }
export interface HermesCommandRunner {
  run(command: string, args: readonly string[], stdin: string, timeoutMs: number, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HermesCommandResult>
}

/** The only process boundary is a bounded JSON stdin/stdout exchange. */
export const hermesCommandRunner: HermesCommandRunner = {
  run(command, args, stdin, timeoutMs, environment, signal) {
    return new Promise((resolve) => {
      let stdout = ''; let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let terminating: HermesCommandResult | undefined
      const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: environment })
      let killTimer: NodeJS.Timeout | undefined
      const finish = (value: HermesCommandResult) => {
        if (settled) return
        settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', abort); resolve(value)
      }
      const terminate = (value: HermesCommandResult) => {
        if (settled || terminating) return
        terminating = value
        try { child.kill('SIGTERM') } catch {}
        // Do not report completion while an untrusted child can continue to
        // run.  SIGKILL is the bounded fallback, and ``close`` below reaps it.
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, TERM_GRACE_MS)
      }
      const abort = () => terminate({ exitCode: null, stdout: '', aborted: true })
      const timer = setTimeout(() => terminate({ exitCode: null, stdout: '', timedOut: true }), timeoutMs)
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      const totalOutputExceeded = () => stdoutBytes + stderrBytes > MAX_CLI_OUTPUT_BYTES
      child.stdout?.on('data', (chunk: Buffer) => {
        if (terminating) return
        stdoutBytes += chunk.length
        if (totalOutputExceeded()) terminate({ exitCode: null, stdout: '', invalidOutput: true })
        else stdout += chunk.toString('utf8')
      })
      // Never propagate or log child stderr: it can contain sensitive upstream
      // diagnostics and is not part of this strict response contract.
      child.stderr?.on('data', (chunk: Buffer) => { if (!terminating) { stderrBytes += chunk.length; if (totalOutputExceeded()) terminate({ exitCode: null, stdout: '', invalidOutput: true }) } })
      child.on('error', (spawnError) => { if (!terminating) terminating = { exitCode: null, stdout: '', spawnError } })
      child.on('close', (exitCode) => finish(terminating ?? { exitCode, stdout }))
      child.stdin?.on('error', () => terminate({ exitCode: null, stdout: '' }))
      try { child.stdin?.end(stdin, 'utf8') } catch { terminate({ exitCode: null, stdout: '' }) }
    })
  }
}

type OverlayResponseShape =
  | 'empty_object' | 'ret_zero' | 'ret_zero_errcode_zero'
  | 'ret_nonzero' | 'errcode_nonzero' | 'both_codes_nonzero'
  | 'unrecognized_object' | 'invalid_code_type' | 'conflicting_codes' | 'non_object'
  | 'timeout' | 'http_client_error' | 'http_server_error' | 'transport_error' | 'not_attempted'
type OverlayResponse = { status: 'sent' | 'permanent_failure' | 'result_unknown'; code: string; responseShape: OverlayResponseShape; idempotencyKey: string }
const allowedCodes: Record<OverlayResponse['status'], ReadonlySet<string>> = {
  sent: new Set(['ILINK_SENT']),
  permanent_failure: new Set(['ILINK_STALE_CONTEXT_TOKEN', 'ILINK_PROVIDER_REJECTED']),
  result_unknown: new Set(['ILINK_SEND_TIMEOUT', 'ILINK_SEND_RESULT_UNKNOWN'])
}
const allowedResponseShapes: Record<OverlayResponse['status'], ReadonlySet<OverlayResponseShape>> = {
  sent: new Set(['empty_object', 'ret_zero', 'ret_zero_errcode_zero']),
  permanent_failure: new Set(['ret_nonzero', 'errcode_nonzero', 'both_codes_nonzero', 'http_client_error', 'not_attempted']),
  result_unknown: new Set(['unrecognized_object', 'invalid_code_type', 'conflicting_codes', 'non_object', 'timeout', 'http_server_error', 'transport_error'])
}
const allResponseShapes = new Set<OverlayResponseShape>(Object.values(allowedResponseShapes).flatMap((values) => [...values]))

function isOverlayResponseShape(value: unknown): value is OverlayResponseShape {
  return typeof value === 'string' && allResponseShapes.has(value as OverlayResponseShape)
}

function strictResponse(stdout: string, key: string, exitCode: number | null): OverlayResponse | undefined {
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch { return undefined }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 4 || !Object.hasOwn(value, 'status') || !Object.hasOwn(value, 'code') || !Object.hasOwn(value, 'responseShape') || !Object.hasOwn(value, 'idempotencyKey')) return undefined
  if ((value.status !== 'sent' && value.status !== 'permanent_failure' && value.status !== 'result_unknown') || typeof value.code !== 'string' || !isOverlayResponseShape(value.responseShape) || value.idempotencyKey !== key || !allowedCodes[value.status].has(value.code) || !allowedResponseShapes[value.status].has(value.responseShape)) return undefined
  if ((value.status === 'sent' && exitCode !== 0) || (value.status !== 'sent' && exitCode !== 1)) return undefined
  return value as OverlayResponse
}

function localReceipt(request: AdapterDeliveryRequest): string {
  const material = JSON.stringify({ key: request.idempotencyKey, peer: request.recipientExternalId, message: request.message })
  return `hermes-local:${createHash('sha256').update(material).digest('hex')}`
}

/** A fixed single-attempt adapter: it never returns retryable_failure. */
export class HermesAdapter implements ChannelAdapter {
  readonly name = 'hermes' as const
  readonly attemptPolicy = 'single_attempt' as const
  constructor(private readonly config: GatewayConfig, private readonly runner: HermesCommandRunner = hermesCommandRunner) {}
  async health(): Promise<AdapterHealth> {
    if (!this.config.ILINK_POC_LIVE_ENABLED || !this.config.ILINK_HERMES_TRANSPORT_ENABLED) return { status: 'healthy', channelStatus: 'disabled', code: 'ILINK_HERMES_DISABLED' }
    // No hidden health probe exists: a probe could poll or consume iLink state.
    return { status: 'degraded', sessionStatus: 'unknown', channelStatus: 'enabled', code: 'ILINK_HERMES_SESSION_UNCHECKED' }
  }
  async send(request: AdapterDeliveryRequest, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    if (!this.config.ILINK_POC_LIVE_ENABLED || !this.config.ILINK_HERMES_TRANSPORT_ENABLED) return { status: 'permanent_failure', errorCode: 'ILINK_LIVE_DISABLED' }
    if (!this.config.hermesLauncherPath || !this.config.hermesPrivateRoot || !this.config.hermesSourceDir || !this.config.hermesPython || !this.config.hermesConfigPath || !this.config.hermesStateDir || !request.recipientUserId || !request.recipientBindingGeneration || !request.recipientAccountRef) return { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' }
    const text = `${request.message.title}\n${request.message.body}`
    if (text.length > 2000) return { status: 'permanent_failure', errorCode: 'ILINK_MESSAGE_TOO_LONG' }
    const input = JSON.stringify({ userId: request.recipientUserId, generation: request.recipientBindingGeneration, accountRef: request.recipientAccountRef, text, idempotencyKey: request.idempotencyKey })
    // Do not inherit the Gateway/PM2 environment into the overlay child.  In
    // particular DB/JWT/DeepSeek values must never cross this process boundary.
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'Asia/Shanghai',
      HERMES_PRIVATE_ROOT: this.config.hermesPrivateRoot,
      HERMES_SOURCE_DIR: this.config.hermesSourceDir,
      HERMES_HOME: this.config.hermesStateDir,
      HOME: this.config.hermesStateDir,
      XDG_CONFIG_HOME: this.config.hermesStateDir,
      XDG_DATA_HOME: this.config.hermesStateDir,
      HERMES_PYTHON: this.config.hermesPython,
      PYTHONPATH: ''
    }
    const started = performance.now()
    try {
      const result = await this.runner.run(this.config.hermesLauncherPath, ['send-bound', '--manager-config', this.config.hermesConfigPath], input, this.config.ILINK_REQUEST_TIMEOUT_MS, environment, signal)
      const latencyMs = Math.max(0, Math.round(performance.now() - started))
      if (result.spawnError || result.timedOut || result.aborted || result.invalidOutput || signal.aborted) return { status: 'result_unknown', errorCode: result.timedOut || result.aborted || signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN', latencyMs }
      const response = strictResponse(result.stdout, request.idempotencyKey, result.exitCode)
      if (!response) return { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN', latencyMs }
      return response.status === 'sent'
        ? { status: 'sent', providerMessageId: localReceipt(request), errorCode: response.code, latencyMs }
        : { status: response.status, errorCode: response.code, latencyMs }
    } catch {
      return { status: 'result_unknown', errorCode: signal.aborted ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN', latencyMs: Math.max(0, Math.round(performance.now() - started)) }
    }
  }
}
