import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRequest, freshNonce, sha256, sign } from '../src/auth.js'
import { loadConfig, ensurePrivateSessionDirectory, ensurePrivateStateDirectory, type GatewayConfig } from '../src/config.js'
import { IdempotencyStore } from '../src/idempotency-store.js'
import { GatewayService } from '../src/gateway-service.js'
import { OfficialRuntime, type CommandResult, type OfficialCommandRunner, hasVerifiedOutboundSendCapability, satisfiesDeclaredCompatibility } from '../src/official-runtime.js'
import { ILinkAdapter, MockOfficialSendTransport, OfficialTransportError, OpenClawCliTransport, classifyOfficialResponse } from '../src/adapters/ilink-adapter.js'
import { FakeAdapter } from '../src/adapters/fake-adapter.js'
import { StateStore } from '../src/state-store.js'
import { createGateway } from '../src/server.js'
import { deliveryRequestSchema } from '../src/types.js'
import { requiredIdempotencyKey } from '../src/cli/arguments.js'
import { runLogin } from '../src/cli/login.js'
import { publicPrereq } from '../src/cli/prereq-check.js'
import { publicSession } from '../src/cli/official-session-status.js'

function directory(): string { const value = mkdtempSync(join(tmpdir(), 'xiansuo-ilink-')); chmodSync(value, 0o700); return value }
function openclawConfigPath(dir: string): string { const parent = join(dir, 'openclaw-config'); mkdirSync(parent, { recursive: true, mode: 0o700 }); chmodSync(parent, 0o700); return join(parent, 'openclaw.json') }
function config(dir: string, extra: Record<string, string> = {}): GatewayConfig {
  return loadConfig({ ILINK_POC_STATE_DIR: dir, ILINK_POC_SESSION_DIR: join(dir, 'sessions'), OPENCLAW_CONFIG_PATH: openclawConfigPath(dir), ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1', ...extra })
}
function request() { return { deliveryId: randomUUID(), idempotencyKey: `phase5a-test-${randomUUID()}`, recipientExternalId: 'test-recipient-1', message: { title: '【测试通知】', body: '这是一条XYY-xiansuo渠道隔离测试消息。\n不包含真实客户或业务数据。' } } }
function result(stdout = '', exitCode = 0): CommandResult { return { stdout, stderr: '', exitCode } }
function runner(responses: Record<string, CommandResult>, interactiveExit = 0): OfficialCommandRunner {
  const key = (args: readonly string[]) => args.join(' ')
  return { run: async (_command, args) => responses[key(args)] ?? result('', 1), interactive: async () => interactiveExit }
}
function readyRuntime(cfg: GatewayConfig, session = 'authenticated'): OfficialRuntime {
  return new OfficialRuntime(cfg, runner({ '--version': result('OpenClaw 2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: { actions: ['send'] } })), 'channels status --channel openclaw-weixin --probe --timeout 5000 --json': result(JSON.stringify({ status: session })) }))
}

test('HMAC canonical signature remains deterministic', () => {
  const canonical = canonicalRequest('POST', '/deliveries', '1700000000000', freshNonce(), sha256('body'))
  assert.equal(sign('a'.repeat(48), canonical).length, 64)
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
    for (const environment of environments) { assert.equal(environment.OPENCLAW_STATE_DIR, cfg.sessionDir); assert.equal(environment.OPENCLAW_CONFIG_PATH, cfg.openclawConfigPath) }
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
    const privatePlugin = (name: string) => { const root = join(cfg.sessionDir!, 'plugins', name); mkdirSync(root, { recursive: true, mode: 0o700 }); return root }
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
    const cfg = loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'test-recipient-1' })
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
    assert.throws(() => ensurePrivateStateDirectory(config(linked)), /ILINK_POC_STATE_DIR/)
    const cfg = config(parent); ensurePrivateStateDirectory(cfg); ensurePrivateSessionDirectory(cfg); chmodSync(cfg.sessionDir!, 0o755); assert.throws(() => ensurePrivateSessionDirectory(cfg), /0700/)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('configuration accepts only frozen names, absolute paths and a non-conflicting legacy alias', () => {
  const dir = directory(); try {
    const configPath = openclawConfigPath(dir)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: 'relative', OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: 'relative', ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    assert.throws(() => config(dir, { ILINK_UNKNOWN: 'x' }))
    assert.throws(() => config(dir, { ILINK_GATEWAY_STATE_DIR: '/tmp/one', ILINK_POC_STATE_DIR: '/tmp/two' }))
    const alias = loadConfig({ ILINK_GATEWAY_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' })
    assert.equal(alias.stateDir, dir); assert.equal(alias.deprecatedWarnings.length, 1)
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'true', ILINK_POC_SESSION_DIR: '' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('OpenClaw configuration path requires a private real parent and a private regular file when present', () => {
  const dir = directory(); try {
    const configPath = openclawConfigPath(dir)
    const parent = join(dir, 'openclaw-config')
    chmodSync(parent, 0o755)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录权限必须为 0700/)
    chmodSync(parent, 0o600)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录权限必须为 0700/)
    chmodSync(parent, 0o700)
    assert.doesNotThrow(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }))
    const realParent = join(dir, 'real-config'); mkdirSync(realParent, { mode: 0o700 }); rmSync(parent, { recursive: true }); symlinkSync(realParent, parent)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /父目录必须是非符号链接目录/)
    rmSync(parent, { recursive: true })
    mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o700)
    writeFileSync(configPath, '{}', { mode: 0o600 }); chmodSync(configPath, 0o644)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /权限必须不超过 0600/)
    chmodSync(configPath, 0o600); rmSync(configPath); symlinkSync(join(dir, 'target.json'), configPath)
    assert.throws(() => loadConfig({ ILINK_POC_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath, ILINK_GATEWAY_SECRET: 'a'.repeat(48), ILINK_POC_RECIPIENT_EXTERNAL_ID: 'r' }), /普通非符号链接文件/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('configuration rejects invalid boolean, port and timeout without silently coercing them', () => {
  const dir = directory(); try {
    assert.throws(() => config(dir, { ILINK_POC_LIVE_ENABLED: 'yes' }))
    assert.throws(() => config(dir, { ILINK_GATEWAY_PORT: '0' }))
    assert.throws(() => config(dir, { ILINK_REQUEST_TIMEOUT_MS: '100' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ret=0 means sent even with no server message id and local receipt is stable and redacted', () => {
  const item = request(); const first = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0 } }); const second = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0 } })
  assert.equal(first.status, 'sent'); assert.match(first.providerMessageId!, /^ilink-local:[a-f0-9]{64}$/); assert.equal(first.providerMessageId, second.providerMessageId)
  const supplied = classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 0, message_id: 'provider-secret-id' } }); assert.match(supplied.providerMessageId!, /^ilink-provider:[a-f0-9]{64}$/)
})

test('nonzero ret is never sent and preserves only safe classifications', () => {
  const item = request()
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: { ret: -14, errmsg: 'sensitive upstream text' } }).errorCode, 'ILINK_SESSION_EXPIRED')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 403, body: { ret: 3 } }).errorCode, 'ILINK_ACCOUNT_RESTRICTED')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 429, body: { ret: 3 } }).status, 'retryable_failure')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: { ret: 3 } }).errorCode, 'ILINK_PROVIDER_REJECTED')
})

test('only possibly committed requests become result_unknown', () => {
  const item = request()
  assert.equal(classifyOfficialResponse(item, { httpStatus: 200, body: 'not-json' }).status, 'result_unknown')
  assert.equal(classifyOfficialResponse(item, { httpStatus: 0, body: undefined, phase: 'before_request' }).status, 'permanent_failure')
})

test('adapter keeps live disabled offline and never invokes a transport', async () => {
  const dir = directory(); try {
    const transport = new MockOfficialSendTransport({ httpStatus: 200, body: { ret: 0 } }); const adapter = new ILinkAdapter(config(dir), readyRuntime(config(dir)), transport)
    assert.deepEqual(await adapter.health(), { status: 'healthy', channelStatus: 'disabled', code: 'ILINK_LIVE_DISABLED' })
    assert.equal((await adapter.send(request(), new AbortController().signal)).errorCode, 'ILINK_LIVE_DISABLED')
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
    const outcome = await adapter.send(request(), new AbortController().signal)
    assert.equal(outcome.status, 'retryable_failure'); assert.equal(outcome.errorCode, 'ILINK_GATEWAY_OFFLINE')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing explicit official outbound capability remains a hard live gate', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); const blocked = new OfficialRuntime(cfg, runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ capabilities: {} })) }))
    const outcome = await new ILinkAdapter(cfg, blocked).send(request(), new AbortController().signal)
    assert.deepEqual({ status: outcome.status, code: outcome.errorCode }, { status: 'permanent_failure', code: 'ILINK_SEND_CONTRACT_UNVERIFIED' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mock transport validates successful and unknown live send lifecycle without network', async () => {
  const dir = directory(); try {
    const cfg = config(dir, { ILINK_POC_LIVE_ENABLED: 'true' }); const sent = new ILinkAdapter(cfg, readyRuntime(cfg), new MockOfficialSendTransport({ httpStatus: 200, body: { ret: 0 } }))
    assert.equal((await sent.send(request(), new AbortController().signal)).status, 'sent')
    const unknown = new ILinkAdapter(cfg, readyRuntime(cfg), new MockOfficialSendTransport(undefined, new OfficialTransportError('ignored', 'after_request')))
    assert.equal((await unknown.send(request(), new AbortController().signal)).status, 'result_unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official CLI transport uses exact fixed send argv and fails closed on non-ret output', async () => {
  const dir = directory(); try {
    const cfg = config(dir); let args: readonly string[] = []
    const fake = runner({ '--version': result('2026.8.1'), 'plugins info openclaw-weixin --json': result(JSON.stringify({ version: '2.4.6', engines: { openclaw: '>=2026.3.22' } })), 'channels capabilities --channel openclaw-weixin --timeout 5000 --json': result(JSON.stringify({ actions: ['send'] })) })
    const observed: OfficialCommandRunner = { ...fake, run: async (command, value, timeout) => { args = value; return fake.run(command, value, timeout) } }
    const transport = new OpenClawCliTransport(new OfficialRuntime(cfg, observed), 'openclaw-weixin'); const item = request()
    await assert.rejects(() => transport.send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    assert.deepEqual(args, ['message', 'send', '--channel', 'openclaw-weixin', '--target', 'test-recipient-1', '--message', '【测试通知】\n\n这是一条XYY-xiansuo渠道隔离测试消息。\n不包含真实客户或业务数据。', '--json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('official CLI transport treats raw ret separately from strict runtime confirmations', async () => {
  const dir = directory(); try {
    const cfg = config(dir); const item = request()
    const make = (send: CommandResult) => new OpenClawCliTransport(new OfficialRuntime(cfg, runner({ 'message send --channel openclaw-weixin --target test-recipient-1 --message 【测试通知】\n\n这是一条XYY-xiansuo渠道隔离测试消息。\n不包含真实客户或业务数据。 --json': send })), 'openclaw-weixin')
    assert.equal(classifyOfficialResponse(item, await make(result(JSON.stringify({ ret: 0 }))).send(item, new AbortController().signal)).status, 'sent')
    assert.equal(classifyOfficialResponse(item, await make(result(JSON.stringify({ ret: -14 }), 1)).send(item, new AbortController().signal)).errorCode, 'ILINK_SESSION_EXPIRED')
    const confirmed = classifyOfficialResponse(item, await make(result(JSON.stringify({ ok: true, result: { messageId: 'stable-provider-id', channelId: 'provider-target-id' } }))).send(item, new AbortController().signal))
    assert.equal(confirmed.status, 'sent'); assert.match(confirmed.providerMessageId!, /^ilink-runtime:[a-f0-9]{64}$/)
    await assert.rejects(() => make(result(JSON.stringify({ ok: true, channel: 'wrong-channel', result: { messageId: 'stable-provider-id' } }))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result(JSON.stringify({ ok: true, channel: 'openclaw-weixin', result: {} }))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make(result(JSON.stringify({ ok: true, result: { messageId: 'stable-provider-id', channel: 'unknown-channel' } }))).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
    await assert.rejects(() => make({ ...result('', 1), timedOut: true }).send(item, new AbortController().signal), /ILINK_SEND_TIMEOUT/)
    await assert.rejects(() => make(result('', 1)).send(item, new AbortController().signal), /ILINK_SEND_RESULT_UNKNOWN/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('idempotency deduplicates sent results and blocks conflicts and result_unknown resend', async () => {
  const dir = directory(); try {
    const state = new StateStore(dir); const service = new GatewayService(config(dir), new FakeAdapter(), new IdempotencyStore(state)); const item = request()
    assert.equal((await service.deliver(item)).status, 'sent'); assert.equal((await service.deliver(item)).status, 'deduplicated')
    assert.equal((await service.deliver({ ...item, recipientExternalId: 'different' })).errorCode, 'ILINK_RECIPIENT_MISMATCH')
    const unknown = new GatewayService(config(dir), new FakeAdapter('result_unknown'), new IdempotencyStore(state)); const second = request(); assert.equal((await unknown.deliver(second)).status, 'result_unknown'); assert.equal((await unknown.deliver(second)).status, 'result_unknown'); state.close()
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
  const body = JSON.stringify(request()); const timestamp = String(Date.now()); const nonce = freshNonce(); const headers = { 'content-type': 'application/json', 'x-ilink-gateway-timestamp': timestamp, 'x-ilink-gateway-nonce': nonce, 'x-ilink-gateway-signature': sign(cfg.ILINK_GATEWAY_SECRET, canonicalRequest('POST', '/deliveries', timestamp, nonce, sha256(body))) }
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200); assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 401)
  assert.equal(deliveryRequestSchema.safeParse({ deliveryId: randomUUID() }).success, false)
})

test('state store preserves nonce and idempotency state across a reopen', () => {
  const dir = directory(); try {
    const now = Date.now(); const nonce = freshNonce(); const first = new StateStore(dir); assert.equal(first.useNonce(nonce, now + 10_000, now), true); first.close()
    const second = new StateStore(dir); assert.equal(second.useNonce(nonce, now + 10_000, now), false); second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
