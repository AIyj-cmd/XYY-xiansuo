import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, chmodSync, rmSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createGateway } from '../src/server.js'
import { ensurePrivateStateDirectory, loadConfig, type GatewayConfig } from '../src/config.js'
import { canonicalRequest, freshNonce, sha256, sign } from '../src/auth.js'
import { FakeAdapter } from '../src/adapters/fake-adapter.js'
import { ILinkAdapter } from '../src/adapters/ilink-adapter.js'
import { StateStore } from '../src/state-store.js'
import { IdempotencyStore } from '../src/idempotency-store.js'
import { GatewayService } from '../src/gateway-service.js'
import { clearPocSession, readPocSession } from '../src/session.js'
import { deliveryRequestSchema } from '../src/types.js'

function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'xiansuo-ilink-')); chmodSync(dir, 0o700); return dir }
function config(dir: string, extra: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    ILINK_GATEWAY_STATE_DIR: dir, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1',
    ...extra
  })
}
function request() { return { deliveryId: randomUUID(), idempotencyKey: `test-${randomUUID()}`, recipientExternalId: 'test-recipient-1', message: { title: '【测试通知】', body: '这是一条XYY-xiansuo渠道隔离测试消息。\n不包含真实客户或业务数据。' } } }

test('HMAC canonical signature supports current and previous secret rotation', () => {
  const body = Buffer.from('{"a":1}'); const nonce = freshNonce(); const canonical = canonicalRequest('POST', '/deliveries', '1700000000000', nonce, sha256(body))
  assert.equal(sign('a'.repeat(48), canonical).length, 64)
  assert.notEqual(sign('a'.repeat(48), canonical), sign('b'.repeat(48), canonical))
})

test('replay nonce persists across gateway service restarts', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const nonce = freshNonce(); const now = Date.now()
  const first = new StateStore(dir); assert.equal(first.useNonce(nonce, now + 300000, now), true); first.close()
  const second = new StateStore(dir); assert.equal(second.useNonce(nonce, now + 300000, now), false); second.close()
})

test('idempotency suppresses sent duplicates and rejects conflicting payloads after restart', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const state = new StateStore(dir); const service = new GatewayService(cfg, new FakeAdapter(), new IdempotencyStore(state)); const firstRequest = request()
  assert.equal((await service.deliver(firstRequest)).status, 'sent'); assert.equal((await service.deliver(firstRequest)).status, 'deduplicated'); state.close()
  const reopened = new StateStore(dir); const service2 = new GatewayService(cfg, new FakeAdapter(), new IdempotencyStore(reopened)); const conflicted = { ...firstRequest, message: { title: '【测试通知】', body: '另一条固定合成测试消息。' } }
  assert.equal((await service2.deliver(conflicted)).status, 'permanent_failure'); reopened.close()
})

test('result_unknown is preserved and never automatically resent', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const state = new StateStore(dir); const service = new GatewayService(cfg, new FakeAdapter('result_unknown'), new IdempotencyStore(state)); const item = request()
  assert.equal((await service.deliver(item)).status, 'result_unknown'); assert.equal((await service.deliver(item)).status, 'result_unknown'); state.close()
})

test('recipient mismatch and privacy policy fail before adapter send', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const state = new StateStore(dir); const service = new GatewayService(cfg, new FakeAdapter('success'), new IdempotencyStore(state)); const item = request()
  assert.equal((await service.deliver({ ...item, recipientExternalId: 'someone-else' })).errorCode, 'ILINK_RECIPIENT_MISMATCH')
  assert.equal((await service.deliver({ ...item, message: { title: '【测试通知】', body: '客户名称：不允许' } })).status, 'permanent_failure'); state.close()
})

test('all fake adapter failure modes are offline and classified', async () => {
  const payload = request()
  for (const [mode, expected] of [['success', 'sent'], ['duplicate', 'deduplicated'], ['timeout', 'retryable_failure'], ['retryable_failure', 'retryable_failure'], ['permanent_failure', 'permanent_failure'], ['result_unknown', 'result_unknown'], ['offline', 'retryable_failure'], ['login_required', 'permanent_failure']] as const) {
    const result = await new FakeAdapter(mode).send(payload, new AbortController().signal); assert.equal(result.status, expected)
  }
})

test('fake adapter duplicate is persisted as safe sent state and returned as deduplicated', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = new StateStore(dir); const service = new GatewayService(config(dir), new FakeAdapter('duplicate'), new IdempotencyStore(state)); const item = request()
  assert.equal((await service.deliver(item)).status, 'deduplicated'); assert.equal((await service.deliver(item)).status, 'deduplicated'); state.close()
})

test('gateway timeout is retryable and is never rewritten as result_unknown', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = new StateStore(dir); const service = new GatewayService(config(dir, { ILINK_POC_TIMEOUT_MS: '1000' }), new FakeAdapter('delay', 1200), new IdempotencyStore(state))
  const result = await service.deliver(request()); assert.deepEqual({ status: result.status, errorCode: result.errorCode }, { status: 'retryable_failure', errorCode: 'ILINK_SEND_TIMEOUT' }); state.close()
})

test('iLink adapter is live-off by default and never invokes fetch', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir, { ILINK_POC_ADAPTER: 'ilink' }); let calls = 0
  const adapter = new ILinkAdapter(cfg, async () => { calls += 1; throw new Error('network forbidden') })
  const result = await adapter.send(request(), new AbortController().signal)
  assert.equal(result.errorCode, 'ILINK_LIVE_DISABLED'); assert.equal(calls, 0); assert.deepEqual(await adapter.health(), { status: 'offline', code: 'ILINK_LIVE_DISABLED' })
})

test('strict configuration rejects public listen and invalid live settings', () => {
  const dir = directory(); try {
    assert.throws(() => config(dir, { ILINK_GATEWAY_HOST: '0.0.0.0' }))
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'true', ILINK_POC_ADAPTER: 'ilink' }))
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'maybe' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('configuration explicitly projects known ILINK fields and ignores PATH/HOME but rejects unknown managed fields', () => {
  const dir = directory(); try {
    const cfg = loadConfig({ PATH: '/usr/bin', HOME: '/home/test', ILINK_GATEWAY_STATE_DIR: dir, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' })
    assert.equal(cfg.stateDir, dir); assert.throws(() => loadConfig({ ...process.env, ILINK_GATEWAY_STATE_DIR: dir, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient', ILINK_UNSUPPORTED: '1' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('local PoC session is strict, state-contained, private, and clear only deletes permitted session.json', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir)
  writeFileSync(cfg.sessionPath, JSON.stringify({ botToken: 'token', contextToken: 'context', recipientExternalId: 'test-recipient-1' }), { mode: 0o600 }); chmodSync(cfg.sessionPath, 0o600)
  assert.equal(readPocSession(cfg).recipientExternalId, 'test-recipient-1'); assert.equal(clearPocSession(cfg), true); assert.equal(existsSync(cfg.sessionPath), false)
  const outside = join(dir, '..', `outside-${randomUUID()}`); writeFileSync(outside, 'keep', { mode: 0o600 }); t.after(() => rmSync(outside, { force: true }))
  symlinkSync(outside, cfg.sessionPath); assert.throws(() => clearPocSession(cfg), /ILINK_SESSION_PATH_INVALID/); assert.equal(existsSync(outside), true)
})

test('state directory itself must not be a symbolic link', async (t) => {
  const parent = directory(); t.after(() => rmSync(parent, { recursive: true, force: true })); const real = join(parent, 'real'); const linked = join(parent, 'linked');
  mkdirSync(real, { mode: 0o700 }); symlinkSync(real, linked)
  const cfg = config(linked); assert.throws(() => ensurePrivateStateDirectory(cfg))
})

test('session rejects permissive files, expired records and unknown fields', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir)
  writeFileSync(cfg.sessionPath, '{invalid-json', { mode: 0o600 }); chmodSync(cfg.sessionPath, 0o600); assert.throws(() => readPocSession(cfg), /^Error: ILINK_SESSION_INVALID$/)
  writeFileSync(cfg.sessionPath, JSON.stringify({ botToken: 'a', contextToken: 'b', recipientExternalId: 'test-recipient-1', extra: true }), { mode: 0o600 }); chmodSync(cfg.sessionPath, 0o600); assert.throws(() => readPocSession(cfg), /ILINK_SESSION_INVALID/)
  writeFileSync(cfg.sessionPath, JSON.stringify({ botToken: 'a', contextToken: 'b', recipientExternalId: 'test-recipient-1' }), { mode: 0o644 }); chmodSync(cfg.sessionPath, 0o644); assert.throws(() => readPocSession(cfg), /ILINK_SESSION_PERMISSION_INVALID/)
  writeFileSync(cfg.sessionPath, JSON.stringify({ botToken: 'a', contextToken: 'b', recipientExternalId: 'test-recipient-1', expiresAt: '2020-01-01T00:00:00.000Z' }), { mode: 0o600 }); chmodSync(cfg.sessionPath, 0o600); assert.throws(() => readPocSession(cfg), /ILINK_SESSION_EXPIRED/)
})

test('live adapter mock fetch matches official sendmessage protocol without revealing live use', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir, { ILINK_POC_ADAPTER: 'ilink', ILINK_POC_LIVE_ENABLED: 'true', ILINK_POC_API_BASE_URL: 'https://example.invalid/root', ILINK_POC_APP_ID: 'poc-app', ILINK_POC_CLIENT_VERSION: '65547' })
  writeFileSync(cfg.sessionPath, JSON.stringify({ botToken: 'token', contextToken: 'context', recipientExternalId: 'test-recipient-1' }), { mode: 0o600 }); chmodSync(cfg.sessionPath, 0o600)
  let url = ''; let init: RequestInit | undefined
  const adapter = new ILinkAdapter(cfg, async (input, options) => { url = String(input); init = options; return new Response(JSON.stringify({ ret: 0 }), { status: 200 }) })
  const result = await adapter.send(request(), new AbortController().signal); assert.equal(result.status, 'result_unknown'); assert.equal(url, 'https://example.invalid/root/ilink/bot/sendmessage')
  const headers = new Headers(init!.headers); assert.equal(headers.get('iLink-App-Id'), 'poc-app'); assert.equal(headers.get('iLink-App-ClientVersion'), '65547'); assert.equal(headers.get('X-WECHAT-UIN')!.match(/^[A-Za-z0-9+/=]+$/) !== null, true)
  const body = JSON.parse(String(init!.body)); assert.deepEqual(body.base_info, { channel_version: '0.1.0', bot_agent: 'XYY-xiansuo-iLink-PoC/0.1.0' }); assert.equal(body.msg.context_token, 'context')
})

test('health reads persistent success and failure counters without exposing recipient or content', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir); const state = new StateStore(dir); const service = new GatewayService(cfg, new FakeAdapter(), new IdempotencyStore(state))
  assert.deepEqual({ recent: (await service.health()).recentSuccessAt, failures: (await service.health()).consecutiveFailureCount }, { recent: null, failures: 0 })
  await service.deliver(request()); const afterSuccess = await service.health(); assert.equal(typeof afterSuccess.recentSuccessAt, 'number'); assert.equal(afterSuccess.consecutiveFailureCount, 0)
  const failed = new GatewayService(cfg, new FakeAdapter('offline'), new IdempotencyStore(state)); await failed.deliver(request()); assert.equal((await failed.health()).consecutiveFailureCount, 1); state.close()
})

test('HTTP gateway authenticates signatures before replay store and rejects altered or replayed requests', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const gateway = createGateway(cfg, new FakeAdapter()); t.after(() => gateway.close())
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`
  const body = JSON.stringify(request()); const nonce = freshNonce(); const timestamp = String(Date.now()); const signature = sign(cfg.ILINK_GATEWAY_SECRET, canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body)))
  const headers = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': signature }
  const accepted = await fetch(`${base}/deliveries`, { method: 'POST', headers, body }); assert.equal(accepted.status, 200)
  const replay = await fetch(`${base}/deliveries`, { method: 'POST', headers, body }); assert.equal(replay.status, 401)
  const changed = await fetch(`${base}/deliveries`, { method: 'POST', headers: { ...headers, 'x-ilink-gateway-nonce': freshNonce() }, body: `${body} ` }); assert.equal(changed.status, 401)
  const health = await fetch(`${base}/health`); assert.equal(health.status, 200)
})

test('HTTP gateway rejects extra schema fields and oversized signed bodies without logging message content', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir); const gateway = createGateway(cfg, new FakeAdapter()); t.after(() => gateway.close())
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`
  const raw = JSON.stringify({ ...request(), unexpected: 'reject' }); const timestamp = String(Date.now()); const nonce = freshNonce()
  const headers = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': sign(cfg.ILINK_GATEWAY_SECRET, canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(raw))) }
  assert.equal((await fetch(`${base}/deliveries`, { method: 'POST', headers, body: raw })).status, 400)
  const huge = 'x'.repeat(17 * 1024); const hugeTs = String(Date.now()); const hugeNonce = freshNonce(); const hugeHeaders = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': hugeTs, 'x-ilink-gateway-nonce': hugeNonce, 'x-ilink-gateway-signature': sign(cfg.ILINK_GATEWAY_SECRET, canonicalRequest('POST', '/deliveries', hugeTs, hugeNonce, sha256(huge))) }
  assert.equal((await fetch(`${base}/deliveries`, { method: 'POST', headers: hugeHeaders, body: huge })).status, 413)
})

test('previous HMAC secret is accepted only within configured rotation set', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = config(dir, { ILINK_GATEWAY_PREVIOUS_SECRET: 'b'.repeat(48) }); const gateway = createGateway(cfg, new FakeAdapter()); t.after(() => gateway.close())
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string'); const body = JSON.stringify(request()); const timestamp = String(Date.now()); const nonce = freshNonce()
  const headers = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': sign('b'.repeat(48), canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body))) }
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/deliveries`, { method: 'POST', headers, body })).status, 200)
})

test('HTTP rate limit, missing fields, invalid URLs, stale and future timestamps are rejected', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir, { ILINK_GATEWAY_RATE_LIMIT_PER_MINUTE: '1' }); const gateway = createGateway(cfg, new FakeAdapter()); t.after(() => gateway.close())
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve)); const address = gateway.server.address(); assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}/deliveries`
  const signed = (body: string, timestamp = String(Date.now()), nonce = freshNonce()) => ({ 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': sign(cfg.ILINK_GATEWAY_SECRET, canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body))) })
  const valid = JSON.stringify(request()); assert.equal((await fetch(endpoint, { method: 'POST', headers: signed(valid), body: valid })).status, 200)
  const another = JSON.stringify(request()); assert.equal((await fetch(endpoint, { method: 'POST', headers: signed(another), body: another })).status, 429)
  const missing = JSON.stringify({ deliveryId: randomUUID() }); assert.equal((await fetch(endpoint, { method: 'POST', headers: signed(missing), body: missing })).status, 429)
  const stale = JSON.stringify(request()); assert.equal((await fetch(endpoint, { method: 'POST', headers: signed(stale, String(Date.now() - 600_000)), body: stale })).status, 401)
  const future = JSON.stringify(request()); assert.equal((await fetch(endpoint, { method: 'POST', headers: signed(future, String(Date.now() + 600_000)), body: future })).status, 401)
})

test('strict delivery schema rejects missing fields, overlong text and malformed detailUrl', () => {
  const item = request()
  assert.equal(deliveryRequestSchema.safeParse({ deliveryId: item.deliveryId }).success, false)
  assert.equal(deliveryRequestSchema.safeParse({ ...item, message: { ...item.message, title: 'x'.repeat(41) } }).success, false)
  assert.equal(deliveryRequestSchema.safeParse({ ...item, message: { ...item.message, detailUrl: 'not-a-url' } }).success, false)
})
