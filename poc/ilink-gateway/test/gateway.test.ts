import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRequest, freshNonce, sha256, sign } from '../src/auth.js'
import { inspectRecipientMapFile, loadConfig, ensurePrivateOpenClawStateDirectory, ensurePrivateStateDirectory, type GatewayConfig } from '../src/config.js'
import { IdempotencyStore } from '../src/idempotency-store.js'
import { GatewayService } from '../src/gateway-service.js'
import { OfficialRuntime, type CommandResult, type OfficialCommandRunner, hasVerifiedOutboundSendCapability, parseOfficialSessionStatus, satisfiesDeclaredCompatibility } from '../src/official-runtime.js'
import { ILinkAdapter, MockOfficialSendTransport, OfficialTransportError, OpenClawCliTransport, classifyOfficialResponse } from '../src/adapters/ilink-adapter.js'
import { HermesAdapter, hermesCommandRunner, type HermesCommandRunner } from '../src/adapters/hermes-adapter.js'
import { createConfiguredAdapter } from '../src/adapters/factory.js'
import { FakeAdapter } from '../src/adapters/fake-adapter.js'
import { StateStore } from '../src/state-store.js'
import { createGateway } from '../src/server.js'
import { deliveryRequestSchema } from '../src/types.js'
import { requiredIdempotencyKey } from '../src/cli/arguments.js'
import { runLogin } from '../src/cli/login.js'
import { runRecipientMapCheck, runRecipientMapCheckProgram } from '../src/cli/recipient-map-check.js'
import { publicPrereq } from '../src/cli/prereq-check.js'
import { publicSession } from '../src/cli/official-session-status.js'
import { SYNTHETIC_MESSAGE, assertMessagePolicy } from '../src/message-policy.js'
import noReplyPlugin from '../openclaw-plugins/xiansuo-no-reply/index.mjs'

function directory(): string { const value = mkdtempSync(join(tmpdir(), 'xiansuo-ilink-')); chmodSync(value, 0o700); return value }
function secretFile(dir: string): string { const file = join(dir, 'gateway.secret'); writeFileSync(file, 'a'.repeat(48), { mode: 0o600 }); chmodSync(file, 0o600); return file }
function recipientMapFile(dir: string, mapping: unknown): string { const file = join(dir, 'recipients.json'); writeFileSync(file, JSON.stringify(mapping), { mode: 0o600 }); chmodSync(file, 0o600); return file }
function openclawConfigPath(dir: string): string { const parent = join(dir, 'openclaw-config'); mkdirSync(parent, { recursive: true, mode: 0o700 }); chmodSync(parent, 0o700); return join(parent, 'openclaw.json') }
function config(dir: string, extra: Record<string, string> = {}): GatewayConfig {
  return loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1', ...extra })
}
function hermesConfig(dir: string, mapping: unknown = { '1': { peer: 'peer-a', enabled: true }, '2': { peer: 'peer-b', enabled: true } }, extra: Record<string, string> = {}): GatewayConfig {
  const overlayConfig = join(dir, 'hermes-config.json'); writeFileSync(overlayConfig, '{"opaque":"test-only"}', { mode: 0o600 }); chmodSync(overlayConfig, 0o600)
  const overlayState = join(dir, 'hermes-state'); mkdirSync(overlayState, { recursive: true, mode: 0o700 }); chmodSync(overlayState, 0o700)
  const map = recipientMapFile(dir, mapping)
  return loadConfig({
    ILINK_POC_TRANSPORT: 'hermes', ILINK_POC_LIVE_ENABLED: 'true', ILINK_HERMES_TRANSPORT_ENABLED: 'true',
    ILINK_POC_STATE_DIR: dir, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), ILINK_HERMES_SOURCE_DIR: dir,
    ILINK_HERMES_CONFIG_FILE: overlayConfig, ILINK_HERMES_STATE_DIR: overlayState,
    ILINK_HERMES_RECIPIENT_MAP_FILE: map, ...extra
  })
}
function request() { return { deliveryId: randomUUID(), idempotencyKey: `phase5a-test-${randomUUID()}`, recipientUserId: 1, recipientBindingGeneration: 1, ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' as const, gatewaySendTimeoutMs: 30_000, workerTimeoutMs: 40_000 } }
function adapterRequest() { return { recipientExternalId: 'test-recipient-1', idempotencyKey: `phase5a-test-${randomUUID()}`, message: { ...SYNTHETIC_MESSAGE, detailUrl: 'https://xs.tomatopia.top/' } } }
function result(stdout = '', exitCode = 0): CommandResult { return { stdout, stderr: '', exitCode } }
const openClawMessageSendSuccessFixture = readFileSync(new URL('./fixtures/openclaw-2026.7.1-message-send-success.json', import.meta.url), 'utf8').trim()
const openClawUnknownTargetFixture = readFileSync(new URL('./fixtures/openclaw-2026.7.1-unknown-target.stderr.txt', import.meta.url), 'utf8')
const openClawInboundOrderFixture = JSON.parse(readFileSync(new URL('./fixtures/openclaw-2026.7.1-2-inbound-order.json', import.meta.url), 'utf8')) as { ordered_boundaries: string[] }
function runner(responses: Record<string, CommandResult>, interactiveExit = 0): OfficialCommandRunner {
  const key = (args: readonly string[]) => args.join(' ')
  return { run: async (_command, args) => responses[key(args)] ?? result('', 1), interactive: async () => interactiveExit }
}
function readyRuntime(cfg: GatewayConfig, session = 'authenticated'): OfficialRuntime {
  return new OfficialRuntime(cfg, runner({ '--version': result('OpenClaw 2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: { actions: ['send'] } })), 'channels status --channel openclaw-weixin --probe --timeout 5000 --json': result(JSON.stringify({ status: session })) }))
}
function currentChannelStatus(account: Record<string, unknown> = {}, channel = 'openclaw-weixin'): Record<string, unknown> {
  return {
    channels: { [channel]: { configured: true } },
    channelAccounts: { [channel]: [{ accountId: 'private-account-id-must-not-escape', enabled: true, configured: true, running: true, restartPending: false, lastError: null, reconnectAttempts: 0, ...account }] },
  }
}

test('HMAC canonical signature remains deterministic', () => {
  const canonical = canonicalRequest('POST', '/deliveries', '1700000000000', freshNonce(), sha256('body'))
  assert.equal(sign('a'.repeat(48), canonical).length, 64)
})

test('owner_changed policy accepts only the generated fixed detail structure', () => {
  const accepted = {
    ...request(), title: '【新线索已分配】', body: '客户：星际企业\n联系人：王小明\n联系方式：138****1234\n来源：官网\n需求：需要采购服务\n跟进要求：2026-08-02 09:30前\n请登录线索系统查看完整资料。'
  }
  assert.doesNotThrow(() => assertMessagePolicy(accepted))
  assert.doesNotThrow(() => assertMessagePolicy({ ...accepted, body: accepted.body.replace('客户：星际企业\n', '').replace('联系方式：138****1234\n', '').replace('需求：需要采购服务\n', '').replace('2026-08-02 09:30前', '请尽快联系') }))
  assert.doesNotThrow(() => assertMessagePolicy({ ...accepted, body: '来源：微信咨询\n跟进要求：请尽快联系\n请登录线索系统查看完整资料。' }))
  assert.doesNotThrow(() => assertMessagePolicy({ ...accepted, body: accepted.body.replace('2026-08-02 09:30前', '2026-08-02前') }))
  assert.doesNotThrow(() => assertMessagePolicy({ ...accepted, body: accepted.body.replace('2026-08-02 09:30前', '2028-02-29前') }))
  for (const body of [
    accepted.body.replace('联系人：王小明\n', '来源：官网\n联系人：王小明\n'),
    accepted.body.replace('138****1234', '13812341234'),
    accepted.body.replace('需求：需要采购服务\n', '需求：一\n需求：二\n'),
    accepted.body.replace('请登录线索系统查看完整资料。', '额外字段：x\n请登录线索系统查看完整资料。'),
    accepted.body.replace('需求：需要采购服务', '需求：wxid_private'),
    accepted.body.replace('需求：需要采购服务', '需求：微信：abc123'),
    accepted.body.replace('需求：需要采购服务', '需求：wechat: abc123'),
    accepted.body.replace('客户：星际企业', '客户：+86 138 1234 5678'),
    accepted.body.replace('来源：官网', '来源：139-0000-0000'),
    accepted.body.replace('需求：需要采购服务', '需求：请联系13812345678'),
    accepted.body.replace('需求：需要采购服务', `需求：${'😀'.repeat(81)}`),
    accepted.body.replace('2026-08-02 09:30前', '2026-08-02 29:30前'),
    accepted.body.replace('2026-08-02 09:30前', '2026-08-02 00:00:00前'),
    accepted.body.replace('2026-08-02 09:30前', '2026-99-99前'),
    accepted.body.replace('2026-08-02 09:30前', '2026-02-30 09:30前'),
    accepted.body.replace('2026-08-02 09:30前', '2027-02-29前'),
    accepted.body.replace('王小明', '王\n来源：伪造'),
    accepted.body.replace('星际企业', '星际\u202E企业'),
    accepted.body.replace('需要采购服务', '需要\u200B采购服务'),
  ]) assert.throws(() => assertMessagePolicy({ ...accepted, body }), /ILINK_MESSAGE_POLICY_REJECTED/)
  assert.throws(() => assertMessagePolicy({ ...accepted, title: '【其他标题】' }), /ILINK_MESSAGE_POLICY_REJECTED/)
})

test('accepted owner_changed detail reaches the Fake Adapter exactly once', async () => {
  const dir = directory(); try {
    const state = new StateStore(dir); let calls = 0
    const adapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async () => { calls += 1; return { status: 'sent' as const, providerMessageId: 'owner-detail-receipt' } } }
    const service = new GatewayService(config(dir), adapter, new IdempotencyStore(state))
    const result = await service.deliver({ ...request(), title: '【新线索已分配】', body: '联系人：王小明\n来源：官网\n跟进要求：请尽快联系\n请登录线索系统查看完整资料。' })
    assert.deepEqual(result, { status: 'sent', providerMessageId: 'owner-detail-receipt' }); assert.equal(calls, 1)
    state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('OpenClaw WeChat no-reply hook handles all inbound text before any provider reply while other channels pass', () => {
  let registered: ((event: unknown, context: { messageProvider?: string }) => unknown) | undefined
  let providerCalls = 0; let replyCount = 0
  const sessions = new Map<string, { target: string }>()
  noReplyPlugin.register({ on: (name: string, handler: typeof registered) => { assert.equal(name, 'before_agent_reply'); registered = handler } })
  assert.ok(registered)
  const runInbound = (messageProvider: string, inboundBody: string) => {
    // The fake channel has already preserved routing state before the Hook runs.
    const sessionId = `session:${messageProvider}:${sessions.size + 1}`; const target = `target:${sessions.size + 1}`
    sessions.set(sessionId, { target })
    const event = new Proxy({ cleanedBody: inboundBody }, { get() { throw new Error('Hook must not read inbound body') } })
    const decision = registered!(event, { messageProvider }) as { handled?: boolean; reply?: unknown } | undefined
    if (!decision?.handled) { providerCalls += 1; replyCount += 1 }
    return { decision, sessionId, target }
  }
  for (const message of ['已收到', '绑定 XYY-12', '普通文字']) {
    const inbound = runInbound('openclaw-weixin', message)
    assert.deepEqual(inbound.decision, { handled: true, reason: 'xiansuo_openclaw_weixin_inbound_disabled' })
    assert.deepEqual(sessions.get(inbound.sessionId), { target: inbound.target })
    assert.equal(providerCalls, 0); assert.equal(replyCount, 0)
  }
  const forwarded = runInbound('telegram', '普通文字')
  assert.equal(forwarded.decision, undefined)
  assert.deepEqual(sessions.get(forwarded.sessionId), { target: forwarded.target })
  assert.equal(providerCalls, 1); assert.equal(replyCount, 1)
  assert.deepEqual(openClawInboundOrderFixture.ordered_boundaries, ['recordInboundSession', 'setContextToken', 'dispatch', 'before_agent_reply', 'model_call'])
})

test('runtime prereq reports OpenClaw missing without running a real command', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const missing: OfficialCommandRunner = { run: async () => ({ ...result('', 1), spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }), interactive: async () => null }
    assert.deepEqual(await new OfficialRuntime(cfg, missing).prereqCheck(), { conclusion: 'NOT_READY', code: 'ILINK_OPENCLAW_NOT_INSTALLED', openclawInstalled: false, pluginInstalled: false, compatible: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('prereq reads installed version, plugin version and plugin-declared compatibility', async () => {
  const dir = directory(); try {
    const actual = await readyRuntime(config(dir)).prereqCheck()
    assert.deepEqual(publicPrereq(actual), { conclusion: 'READY', code: undefined, openclawInstalled: true, openclawVersion: '2026.8.1', pluginInstalled: true, pluginVersion: '2.4.6', pluginCompatibility: '>=2026.3.22', compatible: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('all OpenClaw subprocesses receive isolated state/config environment and overwrite parent values', async () => {
  const dir = directory(); const previousState = process.env.OPENCLAW_STATE_DIR; const previousConfig = process.env.OPENCLAW_CONFIG_PATH
  try {
    process.env.OPENCLAW_STATE_DIR = '/unsafe-parent-state'; process.env.OPENCLAW_CONFIG_PATH = '/unsafe-parent-config'
    const cfg = config(dir); const environments: NodeJS.ProcessEnv[] = []
    assert.equal(cfg.openclawConfigPath, join(dir, 'openclaw-config', 'openclaw.json'))
    const base = runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: ['send'] })), 'channels status --channel openclaw-weixin --probe --timeout 5000 --json': result(JSON.stringify({ status: 'authenticated' })), 'message send --channel openclaw-weixin --target test-recipient-1 --message fixed --json': result(JSON.stringify({ ok: true, channel: 'openclaw-weixin', result: { messageId: 'm-1' } })) })
    const observed: OfficialCommandRunner = { run: async (command, args, timeout, environment) => { environments.push(environment); return base.run(command, args, timeout, environment) }, interactive: async (_command, _args, environment) => { environments.push(environment); return 0 } }
    const runtime = new OfficialRuntime(cfg, observed); await runtime.prereqCheck(); await runtime.sessionStatus(); await runtime.login(); await runtime.sendSynthetic('test-recipient-1', 'fixed')
    assert.ok(environments.length >= 7)
    for (const environment of environments) { assert.equal(environment.OPENCLAW_STATE_DIR, cfg.openclawStateDir); assert.equal(environment.OPENCLAW_CONFIG_PATH, cfg.openclawConfigPath) }
  } finally {
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousState
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = previousConfig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('metadata minHostVersion and only explicit send capability declarations are accepted', async () => {
  const dir = directory(); try {
    const cfg = config(dir)
    const minimum = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', openclaw: { install: { minHostVersion: '2026.3.22' } } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: { send: true } })) }))
    assert.equal((await minimum.prereqCheck()).conclusion, 'READY')
    const prefixedMinimum = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', install: { minHostVersion: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: { send: true } })) }))
    assert.equal((await prefixedMinimum.prereqCheck()).conclusion, 'READY')
    assert.equal(hasVerifiedOutboundSendCapability({ sendText: true }), false)
    assert.equal(hasVerifiedOutboundSendCapability({ actions: ['send'] }), true)
    assert.equal(hasVerifiedOutboundSendCapability({ capabilities: { send: true } }), true)
    assert.equal(hasVerifiedOutboundSendCapability({ send: true, capabilities: { actions: [] } }), false)
    const currentOfficialShape = { channels: [{ channel: 'openclaw-weixin', plugin: { id: 'openclaw-weixin' }, actions: ['send', 'broadcast'] }] }
    assert.equal(hasVerifiedOutboundSendCapability(currentOfficialShape, 'openclaw-weixin'), true)
    assert.equal(hasVerifiedOutboundSendCapability({ channels: [{ channel: 'other', plugin: { id: 'other' }, actions: ['send'] }] }, 'openclaw-weixin'), false)
    assert.equal(hasVerifiedOutboundSendCapability({ channels: [currentOfficialShape.channels[0], currentOfficialShape.channels[0]] }, 'openclaw-weixin'), false)
    assert.equal(hasVerifiedOutboundSendCapability({ channels: [{ channel: 'openclaw-weixin', plugin: { id: 'other' }, actions: ['send'] }] }, 'openclaw-weixin'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compatibility fallback reads only a bounded real package inside the isolated session state', async () => {
  const dir = directory(); try {
    const cfg = config(dir)
    const capabilities = { channels: [{ channel: 'openclaw-weixin', plugin: { id: 'openclaw-weixin' }, actions: ['send', 'broadcast'] }] }
    const makeRuntime = (root: string) => new OfficialRuntime(cfg, runner({
      '--version': result('OpenClaw 2026.7.1-2'),
      'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', plugin: { rootDir: root }, install: { installPath: root, version: '2.4.6' } })),
      'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify(capabilities))
    }))
    const privatePlugin = (name: string) => { const root = join(cfg.openclawStateDir!, 'plugins', name); mkdirSync(root, { recursive: true, mode: 0o700 }); return root }
    const validRoot = privatePlugin('valid'); writeFileSync(join(validRoot, 'package.json'), JSON.stringify({ openclaw: { install: { minHostVersion: '2026.3.22' } } }), { mode: 0o600 })
    assert.equal((await makeRuntime(validRoot).prereqCheck()).conclusion, 'READY')
    const outsideRoot = join(dir, 'outside-plugin'); mkdirSync(outsideRoot, { mode: 0o700 }); writeFileSync(join(outsideRoot, 'package.json'), JSON.stringify({ openclaw: { install: { minHostVersion: '2026.3.22' } } }), { mode: 0o600 })
    assert.equal((await makeRuntime(outsideRoot).prereqCheck()).code, 'ILINK_VERSION_UNSUPPORTED')
    const linkedRoot = privatePlugin('linked'); const target = join(dir, 'outside-package.json'); writeFileSync(target, JSON.stringify({ openclaw: { install: { minHostVersion: '2026.3.22' } } }), { mode: 0o600 }); symlinkSync(target, join(linkedRoot, 'package.json'))
    assert.equal((await makeRuntime(linkedRoot).prereqCheck()).code, 'ILINK_VERSION_UNSUPPORTED')
    const malformedRoot = privatePlugin('malformed'); writeFileSync(join(malformedRoot, 'package.json'), '{', { mode: 0o600 })
    assert.equal((await makeRuntime(malformedRoot).prereqCheck()).code, 'ILINK_VERSION_UNSUPPORTED')
    const missingFieldRoot = privatePlugin('missing-field'); writeFileSync(join(missingFieldRoot, 'package.json'), '{}', { mode: 0o600 })
    assert.equal((await makeRuntime(missingFieldRoot).prereqCheck()).code, 'ILINK_VERSION_UNSUPPORTED')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('live-off prereq uses a derived private directory instead of default or parent OpenClaw state', async () => {
  const dir = directory(); const prior = process.env.OPENCLAW_STATE_DIR
  try {
    process.env.OPENCLAW_STATE_DIR = '/unsafe-parent-state'
    const configPath = openclawConfigPath(dir)
    const cfg = loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1' })
    let environment: NodeJS.ProcessEnv | undefined
    const fake: OfficialCommandRunner = { run: async (_command, _args, _timeout, value) => { environment = value; return { ...result('', 1), spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }, interactive: async () => null }
    assert.equal((await new OfficialRuntime(cfg, fake).prereqCheck()).code, 'ILINK_OPENCLAW_NOT_INSTALLED')
    assert.equal(environment?.OPENCLAW_STATE_DIR, join(dir, 'openclaw-offline'))
    assert.equal(environment?.OPENCLAW_CONFIG_PATH, configPath)
  } finally { if (prior === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prior; rmSync(dir, { recursive: true, force: true }) }
})

test('ambiguous, missing and unmet compatibility always stop live readiness', async () => {
  const dir = directory(); try {
    const cfg = config(dir)
    const ambiguous = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '^2026.3.22' } })) }))
    assert.equal((await ambiguous.prereqCheck()).code, 'ILINK_VERSION_UNSUPPORTED')
    assert.equal(satisfiesDeclaredCompatibility('2026.3.21', '>=2026.3.22'), false)
    assert.equal(satisfiesDeclaredCompatibility('2026.3.22', '^2026.3.22'), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official session state uses only public CLI JSON and never exposes identities', async () => {
  const dir = directory(); try {
    const status = await readyRuntime(config(dir), 'authenticated').sessionStatus()
    assert.deepEqual(publicSession(status), { installed: true, loggedIn: true, sessionStatus: 'authenticated', requiresHumanLogin: false, code: undefined })
    assert.equal((await readyRuntime(config(dir), 'expired').sessionStatus()).state, 'expired')
    assert.equal((await readyRuntime(config(dir), 'restricted').sessionStatus()).state, 'restricted')
    assert.equal((await readyRuntime(config(dir), 'unrecognized').sessionStatus()).state, 'unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('2026.7 structured channel status strictly proves one healthy configured account without exposing account ID', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const structured = currentChannelStatus()
    const runtime = new OfficialRuntime(cfg, runner({ '--version': result('OpenClaw 2026.7.1-2'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: { actions: ['send'] } })), 'channels status --channel openclaw-weixin --probe --timeout 5000 --json': result(JSON.stringify(structured)) }))
    const publicResult = publicSession(await runtime.sessionStatus())
    assert.deepEqual(publicResult, { installed: true, loggedIn: true, sessionStatus: 'authenticated', requiresHumanLogin: false, code: undefined })
    assert.equal(JSON.stringify(publicResult).includes('private-account-id-must-not-escape'), false)
    assert.equal(parseOfficialSessionStatus(structured, 'other-channel')?.state, 'unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('2026.7 structured status rejects tampering, account ambiguity and errors without inferring restriction from text', () => {
  const state = (payload: Record<string, unknown>) => parseOfficialSessionStatus(payload, 'openclaw-weixin')?.state
  assert.equal(state({ channels: { other: { configured: true } }, channelAccounts: { 'openclaw-weixin': [] } }), 'unknown')
  assert.equal(state({ channels: { 'openclaw-weixin': { configured: true } }, channelAccounts: { 'openclaw-weixin': [] } }), 'login_required')
  const multiple = currentChannelStatus(); ((multiple.channelAccounts as Record<string, unknown>)['openclaw-weixin'] as unknown[]).push({ accountId: 'second', enabled: true, configured: true, running: true, restartPending: false, lastError: null, reconnectAttempts: 0 })
  assert.equal(state(multiple), 'unknown')
  assert.equal(state(currentChannelStatus({ accountId: 1 })), 'unknown')
  assert.equal(state(currentChannelStatus({ accountId: '   ' })), 'unknown')
  assert.equal(state(currentChannelStatus({ reconnectAttempts: 1 })), 'unknown')
  assert.equal(state(currentChannelStatus({ lastError: 'account restricted maybe' })), 'unknown')
  assert.equal(state(currentChannelStatus({ status: 1 })), 'unknown')
  assert.equal(state(currentChannelStatus({ status: 'unrecognized' })), 'unknown')
  assert.equal(state(currentChannelStatus({ status: 'authenticated' })), 'authenticated')
  assert.equal(state(currentChannelStatus({ status: 'authenticated', lastError: 'ambiguous' })), 'unknown')
  assert.equal(state(currentChannelStatus({ enabled: false })), 'offline')
  assert.equal(state(currentChannelStatus({ running: false })), 'offline')
  assert.equal(state(currentChannelStatus({ restartPending: true })), 'offline')
  assert.equal(state(currentChannelStatus({ configured: false })), 'login_required')
  assert.equal(state(currentChannelStatus({ status: 'restricted', lastError: 'official status' })), 'restricted')
  // A malformed structured envelope is authoritative and must not be rescued
  // by a legacy top-level authenticated flag.
  assert.equal(state({ status: 'authenticated', channels: {}, channelAccounts: {} }), 'unknown')
})

test('structured unknown session fails closed before the send transport', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); let transportCalls = 0
    const responses = {
      '--version': result('OpenClaw 2026.7.1-2'),
      'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })),
      'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: { actions: ['send'] } })),
      'channels status --channel openclaw-weixin --probe --timeout 5000 --json': result(JSON.stringify(currentChannelStatus({ status: 'unrecognized' }))),
    }
    const transport = { send: async () => { transportCalls += 1; return { httpStatus: 200, body: { ret: 0 } } } }
    const outcome = await new ILinkAdapter(cfg, new OfficialRuntime(cfg, runner(responses)), transport).send(adapterRequest(), new AbortController().signal)
    assert.deepEqual(outcome, { status: 'permanent_failure', errorCode: 'ILINK_SESSION_STATUS_UNKNOWN' })
    assert.equal(transportCalls, 0)
    assert.equal(JSON.stringify(outcome).includes('private-account-id-must-not-escape'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('login requires explicit confirmation and live enablement', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const runtime = readyRuntime(cfg)
    assert.deepEqual(await runLogin([], runtime, cfg), { code: 'ILINK_LIVE_LOGIN_CONFIRMATION_REQUIRED', started: false })
    assert.deepEqual(await runLogin(['--confirm-live-login'], runtime, cfg), { code: 'ILINK_LIVE_DISABLED', started: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('login launches only the official command after secure live gates', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); let interactiveArgs: readonly string[] = []
    const base = runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: ['send'] })) })
    const fake: OfficialCommandRunner = { ...base, interactive: async (_bin, args) => { interactiveArgs = args; return 0 } }
    assert.deepEqual(await runLogin(['--confirm-live-login'], new OfficialRuntime(cfg, fake), cfg), { code: 'OK', started: true, exitCode: 0 })
    assert.deepEqual(interactiveArgs, ['channels', 'login', '--channel', 'openclaw-weixin'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('private state and session directories require 0700 and reject symbolic links', () => {
  const parent = directory(); try {
    const real = join(parent, 'real'); const linked = join(parent, 'linked'); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, linked)
    const linkedConfig = loadConfig({ ILINK_POC_STATE_DIR: linked, OPENCLAW_STATE_DIR: join(parent, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(parent), ILINK_GATEWAY_SECRET_FILE: secretFile(parent), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1' })
    assert.throws(() => ensurePrivateStateDirectory(linkedConfig), /ILINK_POC_STATE_DIR/)
    const cfg = config(parent); ensurePrivateStateDirectory(cfg); ensurePrivateOpenClawStateDirectory(cfg); chmodSync(cfg.openclawStateDir!, 0o755); assert.throws(() => ensurePrivateOpenClawStateDirectory(cfg), /0700/)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('Hermes mode keeps the Gateway ledger root and its database outside the repository', () => {
  const dir = directory(); try {
    const externalState = join(dir, 'gateway-ledger')
    const cfg = hermesConfig(dir, undefined, { ILINK_POC_STATE_DIR: externalState })
    assert.equal(lstatSync(externalState).mode & 0o777, 0o700)
    const state = new StateStore(cfg.stateDir)
    assert.ok(existsSync(join(externalState, 'ilink-poc-state.db')))
    state.close()

    assert.throws(() => hermesConfig(dir, undefined, { ILINK_POC_STATE_DIR: join(process.cwd(), 'src') }), /ILINK_POC_STATE_DIR 必须位于仓库外/)
    assert.doesNotThrow(() => loadConfig({ ILINK_POC_STATE_DIR: join(process.cwd(), 'src'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'compatibility-only' }))
    assert.throws(() => hermesConfig(dir, undefined, { ILINK_POC_STATE_DIR: 'relative' }), /必须为绝对路径/)
    const actualParent = join(dir, 'actual-ledger-parent'); const linkedParent = join(dir, 'linked-ledger-parent')
    mkdirSync(actualParent, { mode: 0o700 }); chmodSync(actualParent, 0o700); symlinkSync(actualParent, linkedParent)
    assert.throws(() => hermesConfig(dir, undefined, { ILINK_POC_STATE_DIR: join(linkedParent, 'ledger') }), /祖先目录必须是非符号链接目录/)
    const unsafe = join(dir, 'unsafe-ledger'); mkdirSync(unsafe, { mode: 0o700 }); chmodSync(unsafe, 0o755)
    assert.throws(() => hermesConfig(dir, undefined, { ILINK_POC_STATE_DIR: unsafe }), /权限精确 0700/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('configuration accepts only frozen names, absolute paths and a non-conflicting legacy alias', () => {
  const dir = directory(); try {
    const configPath = openclawConfigPath(dir)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: 'relative', OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: 'relative', ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    assert.throws(() => config(dir, { ILINK_UNKNOWN: 'x' }))
    assert.throws(() => config(dir, { ILINK_GATEWAY_STATE_DIR: '/tmp/one', ILINK_POC_STATE_DIR: '/tmp/two' }))
    const alias = loadConfig({ ILINK_GATEWAY_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' })
    assert.equal(alias.stateDir, dir); assert.ok(alias.deprecatedWarnings.some((warning) => warning.includes('ILINK_GATEWAY_STATE_DIR')))
    const stateAlias = loadConfig({ ILINK_POC_STATE_DIR: dir, ILINK_POC_SESSION_DIR: join(dir, 'legacy-session'), OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' })
    assert.equal(stateAlias.openclawStateDir, join(dir, 'legacy-session')); assert.ok(stateAlias.deprecatedWarnings.some((warning) => warning.includes('ILINK_POC_SESSION_DIR')))
    assert.throws(() => config(dir, { ILINK_POC_SESSION_DIR: join(dir, 'legacy-session') }), /不得同时设置/)
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'true', OPENCLAW_STATE_DIR: '' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('OpenClaw configuration path requires a private real parent and a private regular file when present', () => {
  const dir = directory(); try {
    const configPath = openclawConfigPath(dir)
    const parent = join(dir, 'openclaw-config')
    chmodSync(parent, 0o755)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录权限必须为 0700/)
    chmodSync(parent, 0o600)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录权限必须为 0700/)
    chmodSync(parent, 0o700)
    assert.doesNotThrow(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    const realParent = join(dir, 'real-config'); mkdirSync(realParent, { mode: 0o700 }); rmSync(parent, { recursive: true }); symlinkSync(realParent, parent)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录必须是非符号链接目录/)
    rmSync(parent, { recursive: true })
    mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o700)
    writeFileSync(configPath, '{}', { mode: 0o600 }); chmodSync(configPath, 0o644)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /权限必须不超过 0600/)
    chmodSync(configPath, 0o600); rmSync(configPath); symlinkSync(join(dir, 'target.json'), configPath)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /普通非符号链接文件/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('configuration rejects invalid boolean, port and timeout without silently coercing them', () => {
  const dir = directory(); try {
    assert.equal(config(dir).ILINK_REQUEST_TIMEOUT_MS, 30_000)
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'yes' }))
    assert.throws(() => config(dir, { ILINK_GATEWAY_PORT: '0' }))
    assert.throws(() => config(dir, { ILINK_REQUEST_TIMEOUT_MS: '100' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Gateway applies ILINK_REQUEST_TIMEOUT_MS as its complete Adapter window and preserves an uncertain single attempt', async () => {
  const dir = directory(); let calls = 0
  try {
    const state = new StateStore(dir)
    const adapter = {
      name: 'fake' as const,
      health: async () => ({ status: 'healthy' as const }),
      send: async (_request: unknown, signal: AbortSignal) => {
        calls += 1
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        return { status: 'sent' as const, providerMessageId: 'must-not-return-after-abort' }
      }
    }
    const service = new GatewayService(config(dir, { ILINK_REQUEST_TIMEOUT_MS: '1000' }), adapter, new IdempotencyStore(state))
    const item = { ...request(), gatewaySendTimeoutMs: 1_000, workerTimeoutMs: 6_001 }
    for (const result of [await service.deliver(item), await service.deliver(item)]) {
      assert.equal(result.status, 'result_unknown')
      assert.equal(result.errorCode, 'ILINK_SEND_TIMEOUT')
    }
    assert.equal(calls, 1)
    state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Gateway rejects a Worker 30s/40s timeout contract when this instance is actually configured for 60s, before Adapter work', async () => {
  const dir = directory(); let calls = 0
  try {
    const state = new StateStore(dir)
    const adapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async () => { calls += 1; return { status: 'sent' as const, providerMessageId: 'must-not-send' } } }
    const service = new GatewayService(config(dir, { ILINK_REQUEST_TIMEOUT_MS: '60000' }), adapter, new IdempotencyStore(state))
    assert.deepEqual(await service.deliver(request()), { status: 'permanent_failure', errorCode: 'ILINK_REQUEST_INVALID' })
    assert.equal(calls, 0)
    state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Gateway Secret must be an exact 0600 regular file', () => {
  const dir = directory(); const file = secretFile(dir)
  try {
    for (const mode of [0o400, 0o200, 0o000, 0o644]) {
      chmodSync(file, mode)
      assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: file, OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' }), /精确 0600/)
    }
    chmodSync(file, 0o600); const linked = join(dir, 'linked.secret'); symlinkSync(file, linked)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: linked, OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' }), /当前用户拥有/)
    const hardLinked = join(dir, 'hard-linked.secret'); linkSync(file, hardLinked)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: hardLinked, OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' }), /当前用户拥有/)
    const actualParent = join(dir, 'actual-secret-parent'); mkdirSync(actualParent, { mode: 0o700 }); const ancestorLink = join(dir, 'linked-secret-parent'); symlinkSync(actualParent, ancestorLink)
    const ancestorSecret = join(ancestorLink, 'gateway.secret'); writeFileSync(ancestorSecret, 'b'.repeat(48), { mode: 0o600 }); chmodSync(ancestorSecret, 0o600)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: ancestorSecret, OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' }), /当前用户拥有/)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: join(process.cwd(), 'src', 'config.ts'), OPENCLAW_PILOT_USER_ID: '1', ILINK_POC_RECIPIENT_EXTERNAL_ID: 'recipient' }), /仓库外/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recipient map keeps live=false multi-recipient resolution and takes precedence over the legacy single recipient', async () => {
  const dir = directory(); try {
    const mapFile = recipientMapFile(dir, {
      '1': { target: 'first-user@im.wechat', enabled: true },
      '2': { target: 'second-user@im.wechat', enabled: true },
      '3': { target: 'disabled-user@im.wechat', enabled: false }
    })
    const cfg = config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: mapFile })
    assert.equal(cfg.recipientMap?.size, 3); assert.ok(cfg.deprecatedWarnings.some((warning) => warning.includes('OPENCLAW_RECIPIENT_MAP_FILE')))
    const state = new StateStore(dir); const deliveries: string[] = []
    const adapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async (input: { recipientExternalId: string }) => { deliveries.push(input.recipientExternalId); return { status: 'sent' as const, providerMessageId: 'map-receipt' } } }
    const service = new GatewayService(cfg, adapter, new IdempotencyStore(state))
    const first = await service.deliver({ ...request(), recipientUserId: 1 })
    const second = await service.deliver({ ...request(), recipientUserId: 2 })
    assert.deepEqual(first, { status: 'sent', providerMessageId: 'map-receipt' })
    assert.deepEqual(second, { status: 'sent', providerMessageId: 'map-receipt' })
    assert.deepEqual(deliveries, ['first-user@im.wechat', 'second-user@im.wechat'])
    assert.deepEqual(await service.deliver({ ...request(), recipientUserId: 3 }), { status: 'permanent_failure', errorCode: 'OPENCLAW_RECIPIENT_DISABLED' })
    assert.deepEqual(await service.deliver({ ...request(), recipientUserId: 4 }), { status: 'permanent_failure', errorCode: 'OPENCLAW_RECIPIENT_NOT_BOUND' })
    assert.deepEqual(deliveries, ['first-user@im.wechat', 'second-user@im.wechat'])
    writeFileSync(mapFile, JSON.stringify({ '1': { target: 'changed-user@im.wechat', enabled: false } }), { mode: 0o600 }); chmodSync(mapFile, 0o600)
    assert.deepEqual(await service.deliver({ ...request(), recipientUserId: 1 }), { status: 'sent', providerMessageId: 'map-receipt' })
    assert.deepEqual(deliveries, ['first-user@im.wechat', 'second-user@im.wechat', 'first-user@im.wechat'])
    state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recipient map file is repository-external, exact 0600 and strictly bounded', () => {
  const dir = directory(); try {
    const valid = recipientMapFile(dir, { '1': { target: 'valid@im.wechat', enabled: true } })
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: secretFile(dir) }), /未配置 OPENCLAW_RECIPIENT_MAP_FILE/)
    const mappedOnly = loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_STATE_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET_FILE: secretFile(dir), OPENCLAW_RECIPIENT_MAP_FILE: valid })
    assert.equal(mappedOnly.recipientMap?.get(1)?.target, 'valid@im.wechat')
    chmodSync(valid, 0o644); assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: valid }), /精确 0600/); chmodSync(valid, 0o600)
    const linked = join(dir, 'linked-recipients.json'); symlinkSync(valid, linked); assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: linked }), /仓库外且不得经过符号链接/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: 'relative.json' }), /必须为绝对路径/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: join(process.cwd(), 'test', 'fixtures', 'repository-map.json') }), /位于仓库外/)
    const oversized = recipientMapFile(dir, Object.fromEntries(Array.from({ length: 51 }, (_value, index) => [String(index + 1), { target: `user-${index + 1}@im.wechat`, enabled: true }])))
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: oversized }), /最多 50/)
    const invalid = recipientMapFile(dir, { '1': { target: 'not-a-wechat-target', enabled: 'true' } })
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: invalid }), /格式无效/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, []) }), /根必须是对象/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '1': { userId: 1, target: 'first@im.wechat', enabled: true } }) }), /格式无效/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '01': { target: 'first@im.wechat', enabled: true } }) }), /规范正整数/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '+1': { target: 'first@im.wechat', enabled: true } }) }), /规范正整数/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '1.0': { target: 'first@im.wechat', enabled: true } }) }), /规范正整数/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '0': { target: 'first@im.wechat', enabled: true } }) }), /规范正整数/)
    assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: recipientMapFile(dir, { '-1': { target: 'first@im.wechat', enabled: true } }) }), /规范正整数/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('offline recipient map inspection exposes aggregate counts only', () => {
  const dir = directory(); try {
    const mapFile = recipientMapFile(dir, {
      '7': { target: 'private-seven@im.wechat', enabled: true },
      '9': { target: 'private-nine@im.wechat', enabled: false },
    })
    assert.deepEqual(inspectRecipientMapFile(mapFile), { recipients: 2, enabled: 1, disabled: 1 })
    assert.ok(!JSON.stringify(inspectRecipientMapFile(mapFile)).includes('@im.wechat'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('single-account release gate requires exactly one enabled map entry without exposing map identifiers', () => {
  const dir = directory(); try {
    const oneEnabled = recipientMapFile(dir, {
      '7': { target: 'private-seven@im.wechat', enabled: true },
      '9': { target: 'private-nine@im.wechat', enabled: false },
    })
    const safe = runRecipientMapCheck(oneEnabled)
    assert.deepEqual(safe, { conclusion: 'SAFE', recipients: 2, enabled: 1, disabled: 1 })
    assert.ok(!JSON.stringify(safe).includes('@im.wechat'))
    const liveGateway = createGateway(config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: oneEnabled, ILINK_POC_LIVE_ENABLED: 'true' }))
    liveGateway.close()

    for (const mapping of [
      { '7': { target: 'private-seven@im.wechat', enabled: true }, '9': { target: 'private-nine@im.wechat', enabled: true } },
      { '7': { target: 'private-seven@im.wechat', enabled: false } },
    ]) {
      const mapFile = recipientMapFile(dir, mapping)
      assert.throws(() => runRecipientMapCheck(mapFile), /必须恰好一个 enabled=true/)
      assert.throws(() => config(dir, { OPENCLAW_RECIPIENT_MAP_FILE: mapFile, ILINK_POC_LIVE_ENABLED: 'true' }), /必须恰好一个 enabled=true/)
      const output: string[] = []
      assert.equal(runRecipientMapCheckProgram(mapFile, (line) => output.push(line)), 2)
      assert.deepEqual(output.map((line) => JSON.parse(line)), [{ conclusion: 'UNSAFE', code: 'OPENCLAW_RECIPIENT_MAP_CHECK_FAILED' }])
      assert.ok(!output.join('').includes('@im.wechat'))
      assert.ok(!output.join('').includes('private-seven'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ret=0 means sent even with no server message id and local receipt is stable and redacted', () => {
  const item = adapterRequest(); const first = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0 } }); const second = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0 } })
  assert.equal(first.status, 'sent'); assert.match(first.providerMessageId!, /^ilink-local:[a-f0-9]{64}$/); assert.equal(first.providerMessageId, second.providerMessageId)
  const supplied = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0, message_id: 'provider-secret-id' } }); assert.match(supplied.providerMessageId!, /^ilink-provider:[a-f0-9]{64}$/)
})

test('nonzero ret is never sent and preserves only safe classifications', () => {
  const item = adapterRequest()
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: { ret: -14, errmsg: 'sensitive upstream text' } }).errorCode, 'ILINK_SESSION_EXPIRED')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 403, body: { ret: 3 } }).errorCode, 'ILINK_ACCOUNT_RESTRICTED')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 429, body: { ret: 3 } }).status, 'retryable_failure')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 3 } }).errorCode, 'ILINK_PROVIDER_REJECTED')
})

test('only possibly committed requests become result_unknown', () => {
  const item = adapterRequest()
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: 'not-json' }).status, 'result_unknown')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 0, body: undefined, phase: 'before_request' }).status, 'permanent_failure')
})

test('adapter keeps live disabled offline and never invokes a transport', async () => {
  const dir = directory(); try {
    const transport = new MockOfficialSendTransport({ httpStatus: 200, body: { ret: 0 } }); const adapter = new ILinkAdapter(config(dir), readyRuntime(config(dir)), transport)
    assert.deepEqual(await adapter.health(), { status: 'healthy', channelStatus: 'disabled', code: 'ILINK_LIVE_DISABLED' })
    assert.equal((await adapter.send(adapterRequest(), new AbortController().signal)).errorCode, 'ILINK_LIVE_DISABLED')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('live adapter maps all channel health classes using fake official CLI', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' })
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'authenticated')).health()).status, 'healthy')
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'login_required')).health()).status, 'login_required')
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'expired')).health()).status, 'login_required')
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'restricted')).health()).status, 'restricted')
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'offline')).health()).status, 'offline')
    assert.equal((await new ILinkAdapter(cfg, readyRuntime(cfg, 'unknown')).health()).status, 'degraded')
    const unsupported = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result('', 1) }))
    assert.equal((await new ILinkAdapter(cfg, unsupported).health()).status, 'unsupported')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('request-before-submit failures remain explicit and never become result_unknown', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' })
    const adapter = new ILinkAdapter(cfg, readyRuntime(cfg), new MockOfficialSendTransport(undefined, new OfficialTransportError('ILINK_GATEWAY_OFFLINE', 'before_request')))
    const outcome = await adapter.send(adapterRequest(), new AbortController().signal)
    assert.equal(outcome.status, 'retryable_failure'); assert.equal(outcome.errorCode, 'ILINK_GATEWAY_OFFLINE')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing explicit official outbound capability remains a hard live gate', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); const blocked = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: {} })) }))
    const outcome = await new ILinkAdapter(cfg, blocked).send(adapterRequest(), new AbortController().signal)
    assert.deepEqual({ status: outcome.status, code: outcome.errorCode }, { status: 'permanent_failure', code: 'ILINK_SEND_CONTRACT_UNVERIFIED' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mock transport validates successful and unknown live send lifecycle without network', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); const sent = new ILinkAdapter(cfg, readyRuntime(cfg), new MockOfficialSendTransport({ httpStatus: 200, body: { ret: 0 } }))
    assert.equal((await sent.send(adapterRequest(), new AbortController().signal)).status, 'sent')
    const unknown = new ILinkAdapter(cfg, readyRuntime(cfg), new MockOfficialSendTransport(undefined, new OfficialTransportError('ignored', 'after_request')))
    assert.equal((await unknown.send(adapterRequest(), new AbortController().signal)).status, 'result_unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Hermes adapter uses only bounded JSON stdin/stdout and never exposes peer or secrets in argv', async () => {
  const dir = directory(); try {
    const cfg = hermesConfig(dir); const calls: Array<{ command: string; args: readonly string[]; stdin: string; env: NodeJS.ProcessEnv }> = []
    const fakeCli: HermesCommandRunner = { run: async (command, args, stdin, _timeout, env) => {
      calls.push({ command, args, stdin, env })
      const payload = JSON.parse(stdin) as Record<string, string>
      return { exitCode: 0, stdout: JSON.stringify({ status: 'sent', code: 'ILINK_SENT', responseShape: 'ret_zero', idempotencyKey: payload.idempotencyKey }) }
    } }
    const item = { ...adapterRequest(), recipientExternalId: 'hermes:1:1', recipientUserId: 1, recipientBindingGeneration: 1 }
    const result = await new HermesAdapter(cfg, fakeCli).send(item, new AbortController().signal)
    assert.equal(result.status, 'sent'); assert.match(result.providerMessageId ?? '', /^hermes-local:[a-f0-9]{64}$/); assert.equal(calls.length, 1)
    assert.equal(calls[0].command, cfg.hermesLauncherPath)
    assert.deepEqual(calls[0].args, ['send-bound', '--config', cfg.hermesConfigPath!, '--state-dir', cfg.hermesStateDir!, '--vault-dir', cfg.hermesVaultDir!])
    assert.deepEqual(JSON.parse(calls[0].stdin), { userId: 1, generation: 1, text: `${item.message.title}\n${item.message.body}`, idempotencyKey: item.idempotencyKey })
    assert.equal(calls[0].args.join(' ').includes('peer-a'), false)
    assert.equal(calls[0].env.HERMES_SOURCE_DIR, cfg.hermesSourceDir); assert.equal(calls[0].env.HERMES_HOME, cfg.hermesStateDir)
    assert.equal(calls[0].env.HOME, cfg.hermesStateDir); assert.equal(calls[0].env.PYTHONPATH, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Hermes adapter treats startup, timeout and illegal output as unknown and never retryable', async () => {
  const dir = directory(); try {
    const cfg = hermesConfig(dir); const item = { ...adapterRequest(), recipientExternalId: 'hermes:1:1', recipientUserId: 1, recipientBindingGeneration: 1 }
    const variants = [
      { exitCode: null, stdout: '', spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      { exitCode: null, stdout: '', timedOut: true },
      { exitCode: 0, stdout: '{"status":"sent"}' },
      { exitCode: 0, stdout: JSON.stringify({ status: 'sent', code: 'ILINK_SENT', idempotencyKey: 'other-key' }) },
      { exitCode: 0, stdout: JSON.stringify({ status: 'sent', code: 'ILINK_SENT', responseShape: 'not_a_fixed_shape', idempotencyKey: item.idempotencyKey }) },
      { exitCode: 1, stdout: JSON.stringify({ status: 'permanent_failure', code: 'ILINK_PROVIDER_REJECTED', responseShape: 'ret_zero', idempotencyKey: item.idempotencyKey }) },
    ]
    for (const response of variants) {
      const adapter = new HermesAdapter(cfg, { run: async () => response })
      const outcome = await adapter.send(item, new AbortController().signal)
      assert.deepEqual({ status: outcome.status, errorCode: outcome.errorCode }, { status: 'result_unknown', errorCode: response.timedOut ? 'ILINK_SEND_TIMEOUT' : 'ILINK_SEND_RESULT_UNKNOWN' })
    }
    const explicit = new HermesAdapter(cfg, { run: async (_command, _args, stdin) => ({ exitCode: 1, stdout: JSON.stringify({ status: 'permanent_failure', code: 'ILINK_PROVIDER_REJECTED', responseShape: 'ret_nonzero', idempotencyKey: (JSON.parse(stdin) as { idempotencyKey: string }).idempotencyKey }) }) })
    assert.deepEqual(await explicit.send(item, new AbortController().signal), { status: 'permanent_failure', errorCode: 'ILINK_PROVIDER_REJECTED', latencyMs: 0 })
    assert.deepEqual(await new HermesAdapter({ ...cfg, ILINK_POC_LIVE_ENABLED: false }).health(), { status: 'healthy', channelStatus: 'disabled', code: 'ILINK_HERMES_DISABLED' })
    assert.equal(createConfiguredAdapter(config(dir)).name, 'ilink')
    assert.equal(createConfiguredAdapter(cfg).name, 'hermes')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Hermes strict stdout contract accepts only the atomic fixed response-shape enum without leaking values', async () => {
  const dir = directory(); try {
    const cfg = hermesConfig(dir); const item = { ...adapterRequest(), recipientExternalId: 'hermes:1:1', recipientUserId: 1, recipientBindingGeneration: 1 }
    const valid = [
      { exitCode: 0, status: 'sent', code: 'ILINK_SENT', responseShape: 'empty_object' },
      { exitCode: 0, status: 'sent', code: 'ILINK_SENT', responseShape: 'ret_zero_errcode_zero' },
      { exitCode: 1, status: 'permanent_failure', code: 'ILINK_PROVIDER_REJECTED', responseShape: 'both_codes_nonzero' },
      { exitCode: 1, status: 'result_unknown', code: 'ILINK_SEND_RESULT_UNKNOWN', responseShape: 'conflicting_codes' },
    ] as const
    for (const expected of valid) {
      const { exitCode, ...response } = expected
      const adapter = new HermesAdapter(cfg, { run: async (_command, _args, stdin) => ({ exitCode, stdout: JSON.stringify({ ...response, idempotencyKey: (JSON.parse(stdin) as { idempotencyKey: string }).idempotencyKey }) }) })
      const outcome = await adapter.send(item, new AbortController().signal)
      assert.equal(outcome.status, expected.status)
      assert.equal(outcome.errorCode, expected.code)
    }
    for (const invalid of [
      { status: 'sent', code: 'ILINK_SENT', responseShape: 'ret_zero', extra: 'forbidden' },
      { status: 'sent', code: 'ILINK_SENT', responseShape: 'token=should-not-parse' },
      { status: 'result_unknown', code: 'ILINK_SEND_RESULT_UNKNOWN', responseShape: 'ret_nonzero' },
    ]) {
      const adapter = new HermesAdapter(cfg, { run: async (_command, _args, stdin) => ({ exitCode: 0, stdout: JSON.stringify({ ...invalid, idempotencyKey: (JSON.parse(stdin) as { idempotencyKey: string }).idempotencyKey }) }) })
      const outcome = await adapter.send(item, new AbortController().signal)
      assert.deepEqual({ status: outcome.status, errorCode: outcome.errorCode }, { status: 'result_unknown', errorCode: 'ILINK_SEND_RESULT_UNKNOWN' })
      assert.equal(JSON.stringify(outcome).includes('should-not-parse'), false)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Hermes command runner SIGKILLs and reaps timeout or oversized-output children', async () => {
  const dir = directory()
  const runHostileChild = async (mode: 'timeout' | 'oversize') => {
    const marker = join(dir, `${mode}.pid`)
    const program = mode === 'timeout'
      ? `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`
      : `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write('x'.repeat(9000));setInterval(()=>{},1000)`
    const result = await hermesCommandRunner.run(process.execPath, ['-e', program], '{}', mode === 'timeout' ? 80 : 2_000, process.env, new AbortController().signal)
    assert.equal(mode === 'timeout' ? result.timedOut : result.invalidOutput, true)
    const pid = Number(readFileSync(marker, 'utf8')); assert.ok(Number.isSafeInteger(pid) && pid > 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(existsSync(`/proc/${pid}`), false, 'runner must return only after child close/reap')
  }
  try { await runHostileChild('timeout'); await runHostileChild('oversize') } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Hermes Gateway forwards only user and generation to the vault overlay and preserves one terminal attempt across concurrent and restart calls', async () => {
  const dir = directory(); const item = request(); let calls = 0; let release: (() => void) | undefined
  const delayed = new Promise<void>((resolve) => { release = resolve })
  const adapter = {
    name: 'hermes' as const, attemptPolicy: 'single_attempt' as const,
    health: async () => ({ status: 'degraded' as const, channelStatus: 'enabled' as const }),
    send: async (request: { recipientExternalId: string; recipientUserId?: number; recipientBindingGeneration?: number }) => { calls += 1; assert.equal(request.recipientExternalId, 'hermes:1:1'); assert.equal(request.recipientUserId, 1); assert.equal(request.recipientBindingGeneration, 1); await delayed; return { status: 'sent' as const, providerMessageId: 'hermes-receipt' } }
  }
  try {
    const state = new StateStore(dir); const service = new GatewayService(hermesConfig(dir), adapter, new IdempotencyStore(state)); const first = service.deliver(item); const second = service.deliver(item); release!()
    const results = await Promise.all([first, second]); assert.equal(calls, 1); assert.ok(results.some((value) => value.status === 'sent')); assert.ok(results.some((value) => value.status === 'deduplicated'))
    assert.equal((await service.deliver({ ...item, recipientUserId: 2 })).errorCode, 'ILINK_IDEMPOTENCY_CONFLICT')
    state.close()
    const reopened = new StateStore(dir); const afterRestart = new GatewayService(hermesConfig(dir), adapter, new IdempotencyStore(reopened))
    assert.deepEqual(await afterRestart.deliver(item), { status: 'deduplicated', providerMessageId: 'hermes-receipt', errorCode: 'ILINK_DUPLICATE_SUPPRESSED' }); assert.equal(calls, 1)
    const noRetryAdapter = { ...adapter, send: async () => { calls += 1; return { status: 'retryable_failure' as const, errorCode: 'ILINK_GATEWAY_OFFLINE' } } }
    const unknownItem = { ...request(), idempotencyKey: `hermes-unknown-${randomUUID()}` }
    const unknown = new GatewayService(hermesConfig(dir), noRetryAdapter, new IdempotencyStore(reopened)); assert.equal((await unknown.deliver(unknownItem)).status, 'result_unknown'); assert.equal((await unknown.deliver(unknownItem)).status, 'result_unknown'); assert.equal(calls, 2)
    reopened.close()
    const afterUnknownRestart = new StateStore(dir); const afterUnknown = new GatewayService(hermesConfig(dir), noRetryAdapter, new IdempotencyStore(afterUnknownRestart))
    assert.equal((await afterUnknown.deliver(unknownItem)).status, 'result_unknown'); assert.equal(calls, 2); afterUnknownRestart.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official CLI transport uses exact fixed send argv and fails closed on non-ret output', async () => {
  const dir = directory(); try {
    const cfg = config(dir); let args: readonly string[] = []
    const fake = runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: ['send'] })) })
    const observed: OfficialCommandRunner = { ...fake, run: async (command, value, timeout) => { args = value; return fake.run(command, value, timeout) } }
    const transport = new OpenClawCliTransport(new OfficialRuntime(cfg, observed), 'openclaw-weixin'); const item = adapterRequest()
    await assert.rejects(() => transport.send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    assert.deepEqual(args, ['message', 'send', '--channel', 'openclaw-weixin', '--target', 'test-recipient-1', '--message', `${SYNTHETIC_MESSAGE.title}\n\n${SYNTHETIC_MESSAGE.body}`, '--json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official CLI transport accepts only the observed 2026.7.1 structured send confirmation', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const item = adapterRequest()
    const sendKey = `message send --channel openclaw-weixin --target test-recipient-1 --message ${SYNTHETIC_MESSAGE.title}\n\n${SYNTHETIC_MESSAGE.body} --json`
    const make = (send: CommandResult) => new OpenClawCliTransport(new OfficialRuntime(cfg, runner({ [sendKey]: send })), 'openclaw-weixin')
    await assert.rejects(() => make(result(JSON.stringify({ ret: 0 }))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    assert.equal(classifyOfficialResponse(item, await make(result(JSON.stringify({ ret: -14 }), 1)).send(item, new AbortController().signal)).errorCode, 'ILINK_SESSION_EXPIRED')
    const confirmed = classifyOfficialResponse(item, await make(result(openClawMessageSendSuccessFixture)).send(item, new AbortController().signal))
    assert.deepEqual({ status: confirmed.status, providerMessageId: confirmed.providerMessageId }, { status: 'sent', providerMessageId: 'openclaw-2026-7-1-2-fixture-message-id' })
    assert.equal(classifyOfficialResponse(item, await make(result(`普通日志\n${openClawMessageSendSuccessFixture}\n普通日志`)).send(item, new AbortController().signal)).status, 'sent')
    assert.equal(classifyOfficialResponse(item, await make(result(`普通日志 {花括号噪声}\n${openClawMessageSendSuccessFixture}\n普通日志 {花括号噪声}`)).send(item, new AbortController().signal)).status, 'sent')
    assert.equal(classifyOfficialResponse(item, await make(result(`\u001b[32m${openClawMessageSendSuccessFixture}\u001b[0m`)).send(item, new AbortController().signal)).status, 'sent')
    assert.equal(classifyOfficialResponse(item, await make({ ...result(openClawMessageSendSuccessFixture), stderr: 'warning: plugin emitted a diagnostic\n' }).send(item, new AbortController().signal)).status, 'sent')
    await assert.rejects(() => make({ ...result(openClawMessageSendSuccessFixture), stderr: 'Error: outbound action failed\n' }).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    const missingId = JSON.parse(openClawMessageSendSuccessFixture) as Record<string, unknown>; delete missingId.messageId
    await assert.rejects(() => make(result(JSON.stringify(missingId))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result('{"action":"send","channel":"openclaw-weixin"')).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result(JSON.stringify({ ...JSON.parse(openClawMessageSendSuccessFixture), action: 'poll' }))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result(`${openClawMessageSendSuccessFixture}\n${openClawMessageSendSuccessFixture}`)).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result(`普通日志\n{不是 JSON}\n${openClawMessageSendSuccessFixture}`)).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    const unknownTarget = classifyOfficialResponse(item, await make(result(JSON.stringify({ ret: 1, error: 'Unknown target' }), 1)).send(item, new AbortController().signal))
    assert.deepEqual({ status: unknownTarget.status, errorCode: unknownTarget.errorCode }, { status: 'permanent_failure', errorCode: 'ILINK_PROVIDER_REJECTED' })
    const stderrUnknownTarget = classifyOfficialResponse(item, await make({ ...result('', 1), stderr: openClawUnknownTargetFixture }).send(item, new AbortController().signal))
    assert.deepEqual({ status: stderrUnknownTarget.status, errorCode: stderrUnknownTarget.errorCode }, { status: 'permanent_failure', errorCode: 'ILINK_PROVIDER_REJECTED' })
    await assert.rejects(() => make({ ...result('', 1), stderr: 'warning: Error: Unknown target test-recipient-1 for openclaw-weixin.' }).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make({ ...result(openClawMessageSendSuccessFixture), timedOut: true }).send(item, new AbortController().signal), /ILINK_SEND_TIMEOUT/)
    await assert.rejects(() => make(result('', 1)).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('idempotency deduplicates sent results and blocks conflicts and result_unknown resend', async () => {
  const dir = directory(); try {
    const state = new StateStore(dir); const service = new GatewayService(config(dir), new FakeAdapter(), new IdempotencyStore(state)); const item = request()
    assert.equal((await service.deliver(item)).status, 'sent'); assert.equal((await service.deliver(item)).status, 'deduplicated')
    assert.equal((await service.deliver({ ...item, recipientUserId: 2 })).errorCode, 'OPENCLAW_RECIPIENT_NOT_ALLOWED')
    const unknown = new GatewayService(config(dir), new FakeAdapter('result_unknown'), new IdempotencyStore(state)); const second = request(); assert.equal((await unknown.deliver(second)).status, 'result_unknown'); assert.equal((await unknown.deliver(second)).status, 'result_unknown'); state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deduplicated delivery must return its original persisted receipt', async () => {
  const dir = directory(); try {
    const state = new StateStore(dir); const item = request(); const service = new GatewayService(config(dir), new FakeAdapter(), new IdempotencyStore(state))
    const first = await service.deliver(item); assert.equal(first.status, 'sent'); assert.ok(first.providerMessageId)
    const duplicate = await service.deliver(item); assert.deepEqual(duplicate, { status: 'deduplicated', providerMessageId: first.providerMessageId, errorCode: 'ILINK_DUPLICATE_SUPPRESSED' })
    const missing = new GatewayService(config(dir), new FakeAdapter('duplicate'), new IdempotencyStore(state)); const missingResult = await missing.deliver({ ...item, idempotencyKey: `different-${item.idempotencyKey}` })
    assert.deepEqual(missingResult, { status: 'permanent_failure', errorCode: 'ILINK_DEDUPLICATED_RECEIPT_MISSING' }); state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('retryable failure can atomically reacquire the same key after Gateway restart without allowing duplicate sends', async () => {
  const dir = directory(); const item = request(); let calls = 0
  const adapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async () => {
    calls += 1
    return calls === 1 ? { status: 'retryable_failure' as const, errorCode: 'ILINK_GATEWAY_OFFLINE' } : { status: 'sent' as const, providerMessageId: 'original-receipt' }
  } }
  try {
    const firstState = new StateStore(dir); const first = new GatewayService(config(dir), adapter, new IdempotencyStore(firstState))
    assert.equal((await first.deliver(item)).status, 'retryable_failure'); firstState.close()
    const secondState = new StateStore(dir); const second = new GatewayService(config(dir), adapter, new IdempotencyStore(secondState))
    assert.deepEqual(await second.deliver(item), { status: 'sent', providerMessageId: 'original-receipt' }); assert.equal(calls, 2)
    assert.deepEqual(await second.deliver(item), { status: 'deduplicated', providerMessageId: 'original-receipt', errorCode: 'ILINK_DUPLICATE_SUPPRESSED' }); assert.equal(calls, 2); secondState.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent and terminal idempotency requests never invoke the adapter twice', async () => {
  const dir = directory(); const item = request(); let calls = 0; let release: (() => void) | undefined
  const delayed = new Promise<void>((resolve) => { release = resolve })
  const adapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async () => { calls += 1; await delayed; return { status: 'sent' as const, providerMessageId: 'receipt' } } }
  try {
    const state = new StateStore(dir); const service = new GatewayService(config(dir), adapter, new IdempotencyStore(state))
    const first = service.deliver(item); const second = service.deliver(item); release!()
    const results = await Promise.all([first, second]); assert.equal(calls, 1); assert.ok(results.some((result) => result.status === 'sent')); assert.ok(results.some((result) => result.status === 'result_unknown'))
    state.close()
    for (const terminal of ['result_unknown', 'permanent_failure'] as const) {
      let terminalCalls = 0; const terminalState = new StateStore(dir); const terminalAdapter = { name: 'fake' as const, health: async () => ({ status: 'healthy' as const }), send: async () => { terminalCalls += 1; return { status: terminal, errorCode: 'terminal' } } }
      const terminalService = new GatewayService(config(dir), terminalAdapter, new IdempotencyStore(terminalState)); const terminalItem = { ...item, idempotencyKey: `${terminal}-${item.idempotencyKey}` }
      await terminalService.deliver(terminalItem); await terminalService.deliver(terminalItem); assert.equal(terminalCalls, 1); terminalState.close()
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('synthetic CLI requires explicit valid idempotency key and has no free body or recipient arguments', () => {
  assert.throws(() => requiredIdempotencyKey([]), /ILINK_IDEMPOTENCY_KEY_REQUIRED/)
  assert.throws(() => requiredIdempotencyKey(['--idempotency-key', 'short']), /ILINK_IDEMPOTENCY_KEY_INVALID/)
  assert.throws(() => requiredIdempotencyKey(['--idempotency-key', 'phase5a-test-0001', '--recipient', 'other']), /ILINK_CLI_ARGUMENT_INVALID/)
  assert.deepEqual(requiredIdempotencyKey(['--idempotency-key', 'phase5a-test-0001', '--expect-deduplicated']), { key: 'phase5a-test-0001', expectDeduplicated: true })
})

test('gateway health reports disabled channel separately and degrades after an uncertain outcome', async () => {
  const dir = directory(); try {
    const state = new StateStore(dir); const cfg = config(dir); const service = new GatewayService(cfg, new ILinkAdapter(cfg, readyRuntime(cfg)), new IdempotencyStore(state))
    assert.deepEqual({ status: (await service.health()).status, channel: (await service.health()).channelStatus }, { status: 'healthy', channel: 'disabled' })
    const failing = new GatewayService(cfg, new FakeAdapter('result_unknown'), new IdempotencyStore(state)); await failing.deliver(request()); assert.equal((await failing.health()).status, 'degraded'); state.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('HTTP gateway retains HMAC, replay, schema and local-only safety', async (t) => {
  const dir = directory(); t.after(() => rmSync(dir, { recursive: true, force: true })); const cfg = config(dir); const gateway = createGateway(cfg, new FakeAdapter()); t.after(() => gateway.close())
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve)); const address = gateway.server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/deliveries`
  const body = JSON.stringify(request()); const timestamp = String(Date.now()); const nonce = freshNonce(); const headers = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': sign(cfg.gatewaySecret, canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body))) }
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200); assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 401)
  assert.equal(deliveryRequestSchema.safeParse({ deliveryId: randomUUID() }).success, false)
})

test('state store preserves nonce and idempotency state across a reopen', () => {
  const dir = directory(); try {
    const now = Date.now(); const nonce = freshNonce(); const first = new StateStore(dir); assert.equal(first.useNonce(nonce, now + 10_000, now), true); first.close()
    const second = new StateStore(dir); assert.equal(second.useNonce(nonce, now + 10_000, now), false); second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
