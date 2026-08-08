import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { loadConfig, ensurePrivateStateDirectory, type GatewayConfig } from './config.js'
import { canonicalRequest, sha256, SIGNATURE_HEADERS, verifySignature } from './auth.js'
import { StateStore } from './state-store.js'
import { ReplayStore } from './replay-store.js'
import { IdempotencyStore } from './idempotency-store.js'
import { deliveryRequestSchema, type ChannelAdapter } from './types.js'
import { createConfiguredAdapter } from './adapters/factory.js'
import { GatewayService } from './gateway-service.js'

const MAX_BODY_BYTES = 16 * 1024

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > MAX_BODY_BYTES) throw new Error('ILINK_REQUEST_TOO_LARGE'); chunks.push(buffer) }
  return Buffer.concat(chunks)
}

export function createGateway(config: GatewayConfig = loadConfig(), adapter?: ChannelAdapter) {
  ensurePrivateStateDirectory(config)
  const store = new StateStore(config.stateDir)
  const service = new GatewayService(config, adapter ?? createConfiguredAdapter(config), new IdempotencyStore(store), store)
  const replay = new ReplayStore(store)
  const rate = new Map<string, number[]>()
  const secretList = [config.gatewaySecret]
  const authorized = (request: IncomingMessage, body: Buffer, path: string): string | undefined => {
    const timestamp = request.headers[SIGNATURE_HEADERS.timestamp] as string | undefined
    const nonce = request.headers[SIGNATURE_HEADERS.nonce] as string | undefined
    const signature = request.headers[SIGNATURE_HEADERS.signature] as string | undefined
    if (!timestamp || !nonce || !signature || !/^\d{13}$/.test(timestamp) || nonce.length < 16 || nonce.length > 200) return 'ILINK_SIGNATURE_INVALID'
    const now = Date.now(); const ts = Number(timestamp); const skew = config.ILINK_GATEWAY_CLOCK_SKEW_SECONDS * 1000
    if (Math.abs(now - ts) > skew) return 'ILINK_REPLAY_REJECTED'
    const canonical = canonicalRequest(request.method ?? 'GET', path, timestamp, nonce, sha256(body))
    if (!verifySignature(signature, canonical, secretList)) return 'ILINK_SIGNATURE_INVALID'
    if (!replay.accept(nonce, ts + skew, now)) return 'ILINK_REPLAY_REJECTED'
    const key = request.socket.remoteAddress ?? 'local'; const starts = (rate.get(key) ?? []).filter((time) => time > now - 60_000)
    if (starts.length >= config.ILINK_GATEWAY_RATE_LIMIT_PER_MINUTE) return 'ILINK_RATE_LIMITED'
    starts.push(now); rate.set(key, starts)
    return undefined
  }
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'; const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if ((method === 'GET' && (path === '/health' || path === '/session/status'))) {
      // Read-only observability remains bound to loopback; clients still need no secret for liveness only.
      return json(response, 200, await service.health())
    }
    if (method !== 'POST' || path !== '/deliveries') return json(response, 404, { code: 'ILINK_NOT_FOUND', msg: '未找到接口', data: null })
    try {
      const body = await readBody(request); const authError = authorized(request, body, path)
      if (authError) return json(response, authError === 'ILINK_RATE_LIMITED' ? 429 : 401, { code: authError, msg: '请求认证失败', data: null })
      const parsed = deliveryRequestSchema.safeParse(JSON.parse(body.toString('utf8')))
      if (!parsed.success) return json(response, 400, { code: 'ILINK_REQUEST_INVALID', msg: '请求格式不合法', data: null })
      const result = await service.deliver(parsed.data)
      const http = result.status === 'sent' || result.status === 'deduplicated' ? 200 : result.status === 'retryable_failure' ? 503 : result.status === 'result_unknown' ? 502 : 400
      return json(response, http, { code: result.errorCode ?? 'OK', msg: result.status, data: result })
    } catch (error) {
      const code = error instanceof Error && error.message === 'ILINK_REQUEST_TOO_LARGE' ? error.message : 'ILINK_INTERNAL_ERROR'
      return json(response, code === 'ILINK_REQUEST_TOO_LARGE' ? 413 : 500, { code, msg: '请求处理失败', data: null })
    }
  })
  return { server, store, service, close: () => { server.close(); store.close() } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(); const gateway = createGateway(config)
  for (const warning of config.deprecatedWarnings) console.warn(`WARNING: ${warning}`)
  gateway.server.listen({ host: config.ILINK_GATEWAY_HOST, port: config.ILINK_GATEWAY_PORT }, () => console.log('iLink PoC Gateway 已在本地监听'))
  process.on('SIGTERM', () => gateway.close())
}
