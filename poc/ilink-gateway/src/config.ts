import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const bool = z.enum(['true', 'false']).optional().default('false').transform((value) => value === 'true')
const positiveInt = (min: number, max: number, fallback?: number) => z.string().optional().transform((value, ctx) => {
  if (value === undefined && fallback !== undefined) return fallback
  if (value === undefined || value === '') { ctx.addIssue({ code: 'custom', message: '不得为空' }); return z.NEVER }
  if (!/^\d+$/.test(value)) { ctx.addIssue({ code: 'custom', message: '必须是整数' }); return z.NEVER }
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) { ctx.addIssue({ code: 'custom', message: `必须在 ${min} 至 ${max} 之间` }); return z.NEVER }
  return result
})

const absolutePath = z.string().min(1).refine((value) => value.startsWith('/'), '必须为绝对路径')
const nonEmpty = z.string().min(1, '不得为空')
const recipientEntrySchema = z.object({
  target: z.string().min(1).max(256).regex(/^\S+@im\.wechat$/, 'target 必须以 @im.wechat 结尾'),
  enabled: z.boolean()
}).strict()
const hermesRecipientEntrySchema = z.object({
  peer: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.@-]+$/, 'peer 必须是固定 Hermes allowlist ID'),
  enabled: z.boolean()
}).strict()

const configSchema = z.object({
  ILINK_POC_LIVE_ENABLED: bool,
  ILINK_POC_TRANSPORT: z.enum(['openclaw', 'hermes']).optional().default('openclaw'),
  ILINK_OPENCLAW_BIN: nonEmpty.optional().default('openclaw'),
  ILINK_OPENCLAW_CHANNEL: z.literal('openclaw-weixin').optional().default('openclaw-weixin'),
  ILINK_POC_RECIPIENT_EXTERNAL_ID: z.string().min(1).max(256).optional(),
  ILINK_POC_STATE_DIR: absolutePath,
  OPENCLAW_STATE_DIR: absolutePath.optional(),
  ILINK_GATEWAY_HOST: z.string().optional().default('127.0.0.1').refine((value) => value === '127.0.0.1' || value === '::1', 'PoC Gateway 只允许本地监听'),
  ILINK_GATEWAY_PORT: positiveInt(1024, 65535, 38115),
  ILINK_GATEWAY_SECRET_FILE: absolutePath,
  OPENCLAW_PILOT_USER_ID: z.string().regex(/^[1-9]\d*$/, '只能为一个正整数').optional(),
  OPENCLAW_RECIPIENT_MAP_FILE: absolutePath.optional(),
  // This is the Gateway's complete outbound window: GatewayService aborts the
  // Adapter at it and OfficialRuntime gives the OpenClaw CLI the same limit.
  ILINK_REQUEST_TIMEOUT_MS: positiveInt(1_000, 120_000, 30_000),
  ILINK_SESSION_CHECK_TIMEOUT_MS: positiveInt(100, 60_000, 5_000),
  ILINK_GATEWAY_CLOCK_SKEW_SECONDS: positiveInt(30, 600, 300),
  ILINK_GATEWAY_RATE_LIMIT_PER_MINUTE: positiveInt(1, 120, 30),
  ILINK_HERMES_TRANSPORT_ENABLED: bool,
  ILINK_HERMES_SOURCE_DIR: absolutePath.optional(),
  ILINK_HERMES_PYTHON: absolutePath.optional(),
  ILINK_HERMES_PRIVATE_ROOT: absolutePath.optional(),
  ILINK_HERMES_CONFIG_FILE: absolutePath.optional(),
  ILINK_HERMES_STATE_DIR: absolutePath.optional(),
  // Hermes has no peer map or separate CLI vault argument: the manager config
  // is its single opaque accountRef-to-vault authority.
}).strict()

const legacyAliases: Record<string, keyof z.input<typeof configSchema>> = {
  ILINK_GATEWAY_STATE_DIR: 'ILINK_POC_STATE_DIR',
  ILINK_POC_SESSION_DIR: 'OPENCLAW_STATE_DIR',
  ILINK_POC_TIMEOUT_MS: 'ILINK_REQUEST_TIMEOUT_MS'
}
const knownKeys = new Set([...Object.keys(configSchema.shape), ...Object.keys(legacyAliases)])

export type GatewayConfig = z.output<typeof configSchema> & {
  stateDir: string
  openclawStateDir?: string
  openclawConfigPath: string
  gatewaySecret: string
  recipientMap?: ReadonlyMap<number, { target: string; enabled: boolean }>
  hermesSourceDir?: string
  hermesPython?: string
  hermesPrivateRoot?: string
  hermesPathIdentity?: Readonly<{ privateRoot: string; source: string; python: string }>
  hermesConfigPath?: string
  hermesStateDir?: string
  hermesLauncherPath?: string
  hermesManagerEnabled?: boolean
  deprecatedWarnings: string[]
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const unknownManaged = Object.keys(env).filter((key) => key.startsWith('ILINK_') && !knownKeys.has(key))
  if (unknownManaged.length) throw new Error(`iLink Gateway 配置无效：不支持的受管配置 ${unknownManaged.join(', ')}`)
  const warnings: string[] = []
  const projected: Record<string, string | undefined> = {}
  for (const key of Object.keys(configSchema.shape)) projected[key] = env[key]
  for (const [oldKey, newKey] of Object.entries(legacyAliases)) {
    if (env[oldKey] !== undefined && env[newKey] !== undefined) throw new Error(`iLink Gateway 配置无效：${oldKey} 与 ${newKey} 不得同时设置`)
    if (env[oldKey] !== undefined) {
      projected[newKey] = env[oldKey]
      warnings.push(`${oldKey} 已废弃；请改用 ${newKey}，将在阶段五A实况PoC结束后移除`)
    }
  }
  const parsed = configSchema.safeParse(projected)
  if (!parsed.success) throw new Error(`iLink Gateway 配置无效：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
  const stateDir = resolve(parsed.data.ILINK_POC_STATE_DIR)
  const openclawStateDir = parsed.data.OPENCLAW_STATE_DIR === undefined ? undefined : resolve(parsed.data.OPENCLAW_STATE_DIR)
  const gatewaySecret = readSecretFile(parsed.data.ILINK_GATEWAY_SECRET_FILE)
  if (parsed.data.ILINK_POC_TRANSPORT === 'hermes') {
    return loadHermesConfig(parsed.data, stateDir, gatewaySecret, warnings)
  }
  const rawOpenclawConfigPath = env.OPENCLAW_CONFIG_PATH
  if (!rawOpenclawConfigPath || !absolutePath.safeParse(rawOpenclawConfigPath).success) throw new Error('iLink Gateway 配置无效：OPENCLAW_CONFIG_PATH 必须为绝对路径')
  const openclawConfigPath = resolve(rawOpenclawConfigPath)
  ensurePrivateOpenClawConfigPath(openclawConfigPath)
  const recipientMap = parsed.data.OPENCLAW_RECIPIENT_MAP_FILE === undefined ? undefined : readRecipientMapFile(parsed.data.OPENCLAW_RECIPIENT_MAP_FILE)
  const hasLegacyRecipientConfig = parsed.data.OPENCLAW_PILOT_USER_ID !== undefined || parsed.data.ILINK_POC_RECIPIENT_EXTERNAL_ID !== undefined
  if (!recipientMap && (parsed.data.OPENCLAW_PILOT_USER_ID === undefined || parsed.data.ILINK_POC_RECIPIENT_EXTERNAL_ID === undefined)) throw new Error('iLink Gateway 配置无效：未配置 OPENCLAW_RECIPIENT_MAP_FILE 时必须同时设置旧单接收人配置')
  if (hasLegacyRecipientConfig) warnings.push(recipientMap ? '旧单接收人配置已废弃且被 OPENCLAW_RECIPIENT_MAP_FILE 忽略；未输出用户或接收人标识' : '旧单接收人配置已废弃；请迁移至 OPENCLAW_RECIPIENT_MAP_FILE，未输出用户或接收人标识')
  // Keep parsing and live=false Fake/compatibility coverage for the existing
  // mapping shape, but freeze an actual live Gateway to one approved recipient.
  if (parsed.data.ILINK_POC_LIVE_ENABLED && recipientMap && enabledRecipientCount(recipientMap) !== 1) {
    throw new Error('iLink Gateway 配置无效：OPENCLAW_RECIPIENT_MAP_FILE 在 live 模式必须恰好一个 enabled=true')
  }
  if (parsed.data.ILINK_POC_LIVE_ENABLED && !openclawStateDir) throw new Error('iLink Gateway 配置无效：live 模式需要 OPENCLAW_STATE_DIR')
  return { ...parsed.data, stateDir, openclawStateDir, openclawConfigPath, gatewaySecret, recipientMap, deprecatedWarnings: warnings }
}

function loadHermesConfig(parsed: z.output<typeof configSchema>, stateDir: string, gatewaySecret: string, warnings: string[]): GatewayConfig {
  if (!parsed.ILINK_HERMES_PRIVATE_ROOT || !parsed.ILINK_HERMES_SOURCE_DIR || !parsed.ILINK_HERMES_PYTHON || !parsed.ILINK_HERMES_CONFIG_FILE || !parsed.ILINK_HERMES_STATE_DIR) throw new Error('iLink Gateway 配置无效：Hermes transport 缺少私有根、固定源码、Python、配置或状态路径')
  // The Gateway ledger is itself persistent Hermes-mode state.  Unlike the
  // long-standing OpenClaw compatibility path, Hermes must never put it in
  // the checkout (or reach it through an ancestor link).
  requirePrivateExternalStateDirectory(stateDir, 'ILINK_POC_STATE_DIR')
  const hermesPrivateRoot = requireHermesPrivateRoot(parsed.ILINK_HERMES_PRIVATE_ROOT)
  const hermesSourceDir = requireHermesSourceDirectory(parsed.ILINK_HERMES_SOURCE_DIR, hermesPrivateRoot)
  const hermesPython = requireHermesPython(parsed.ILINK_HERMES_PYTHON, hermesPrivateRoot, hermesSourceDir)
  const hermesConfigPath = requirePrivateExternalFile(parsed.ILINK_HERMES_CONFIG_FILE, 'ILINK_HERMES_CONFIG_FILE')
  const hermesStateDir = requireSafeDirectory(parsed.ILINK_HERMES_STATE_DIR, 'ILINK_HERMES_STATE_DIR', true, true)
  ensurePrivateDirectory(hermesStateDir, 'ILINK_HERMES_STATE_DIR')
  const hermesLauncherPath = join(repositoryRoot, 'poc/hermes-weixin-transport/run-hermes-weixin-transport.sh')
  requireRepositoryLauncher(hermesLauncherPath)
  const hermesManagerEnabled = validateHermesManagerConfig(hermesConfigPath)
  const hermesPathIdentity = captureHermesPathIdentity(hermesPrivateRoot, hermesSourceDir, hermesPython)
  return { ...parsed, stateDir, gatewaySecret, hermesPrivateRoot, hermesSourceDir, hermesPython, hermesPathIdentity, hermesConfigPath, hermesStateDir, hermesLauncherPath, hermesManagerEnabled, openclawConfigPath: '', deprecatedWarnings: warnings }
}

/** Read a private manager config structurally only. It never contacts manager. */
function validateHermesManagerConfig(path: string): boolean {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('ILINK_HERMES_CONFIG_FILE 必须是合法 JSON') }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') throw new Error('ILINK_HERMES_CONFIG_FILE 格式无效')
  const record = raw as Record<string, unknown>
  const required = ['host', 'port', 'vault_dir', 'vault_key', 'manager_secret', 'server_url', 'internal_secret']
  const allowed = new Set([...required, 'enabled'])
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) throw new Error('ILINK_HERMES_CONFIG_FILE 字段无效')
  if (record.host !== '127.0.0.1' || record.port !== 38117 || record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new Error('ILINK_HERMES_CONFIG_FILE 必须固定为 loopback:38117 且 enabled 为布尔值')
  if (typeof record.vault_dir !== 'string' || !record.vault_dir.startsWith('/') || typeof record.server_url !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(record.server_url)) throw new Error('ILINK_HERMES_CONFIG_FILE 路径无效')
  return record.enabled === true
}

/** Purely local readiness contract.  Do not call adapter.health(): Hermes
 * health must not poll, spawn its launcher, or contact a manager/provider. */
export function hermesGatewayReadiness(config: GatewayConfig): Record<string, unknown> {
  if (config.ILINK_POC_TRANSPORT !== 'hermes') return { service: 'xiansuo-hermes-gateway', status: 'not_ready', transport: config.ILINK_POC_TRANSPORT }
  if (!config.hermesLauncherPath || !config.hermesPrivateRoot || !config.hermesSourceDir || !config.hermesPython || !config.hermesPathIdentity || !config.hermesConfigPath || !config.hermesStateDir || config.ILINK_GATEWAY_HOST !== '127.0.0.1' || config.ILINK_GATEWAY_PORT !== 38116) throw new Error('Hermes Gateway readiness 配置无效')
  requirePrivateExternalStateDirectory(config.stateDir, 'ILINK_POC_STATE_DIR')
  requirePrivateExternalFile(config.hermesConfigPath, 'ILINK_HERMES_CONFIG_FILE')
  const privateRoot = requireHermesPrivateRoot(config.hermesPrivateRoot)
  const source = requireHermesSourceDirectory(config.hermesSourceDir, privateRoot)
  const python = requireHermesPython(config.hermesPython, privateRoot, source)
  assertHermesPathIdentity(config.hermesPathIdentity, privateRoot, source, python)
  requireSafeDirectory(config.hermesStateDir, 'ILINK_HERMES_STATE_DIR', true)
  requireRepositoryLauncher(config.hermesLauncherPath)
  return { service: 'xiansuo-hermes-gateway', status: 'ready', transport: 'hermes', liveEnabled: config.ILINK_POC_LIVE_ENABLED, transportEnabled: config.ILINK_HERMES_TRANSPORT_ENABLED, managerEnabled: config.hermesManagerEnabled === true, checks: { config: 'ok', ledger: 'ok', launcher: 'ok', managerConfig: 'ok', timeout: 'ok' } }
}

function readSecretFile(path: string): string {
  const resolved = requirePrivateExternalFile(path, 'ILINK_GATEWAY_SECRET_FILE')
  const secret = readFileSync(resolved, 'utf8').trim()
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('Gateway Secret 至少 32 个字符')
  return secret
}

function readRecipientMapFile(path: string): ReadonlyMap<number, { target: string; enabled: boolean }> {
  const resolved = resolve(path)
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${sep}`)) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须位于仓库外')
  let actual: string
  try { actual = realpathSync(resolved) } catch { throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须是存在的仓库外文件') }
  if (actual !== resolved || actual === repositoryRoot || actual.startsWith(`${repositoryRoot}${sep}`)) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须位于仓库外且不得经过符号链接')
  let state: ReturnType<typeof lstatSync>
  try { state = lstatSync(resolved) } catch { throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须是存在的仓库外文件') }
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须是权限精确 0600 的普通文件')
  let raw: unknown
  try { raw = JSON.parse(readFileSync(resolved, 'utf8')) } catch { throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须是合法 JSON') }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 格式无效：根必须是对象')
  const entries = Object.entries(raw)
  if (entries.length > 50) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 格式无效：最多 50 个接收人')
  const recipientMap = new Map<number, { target: string; enabled: boolean }>()
  for (const [key, value] of entries) {
    if (!/^[1-9]\d*$/.test(key)) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 格式无效：用户 ID 键必须为规范正整数')
    const userId = Number(key)
    if (!Number.isSafeInteger(userId)) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 格式无效：用户 ID 键超出安全整数范围')
    const parsed = recipientEntrySchema.safeParse(value)
    if (!parsed.success) throw new Error(`OPENCLAW_RECIPIENT_MAP_FILE 格式无效：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
    recipientMap.set(userId, parsed.data)
  }
  return recipientMap
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) throw new Error('当前运行环境无法校验文件属主')
  return uid
}

function requireSafeDirectory(path: string, variable: string, outsideRepository = false, mayCreate = false): string {
  const resolved = resolve(path)
  if (outsideRepository && (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${sep}`))) throw new Error(`${variable} 必须位于仓库外`)
  if (mayCreate) {
    ensurePrivateDirectory(resolved, variable)
    return resolved
  }
  let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error(`${variable} 必须是存在的绝对非符号链接目录`) }
  if (!state.isDirectory() || state.isSymbolicLink() || actual !== resolved) throw new Error(`${variable} 必须是存在的绝对非符号链接目录`)
  return resolved
}

function requirePrivateExternalFile(path: string, variable: string): string {
  const resolved = resolve(path)
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${sep}`)) throw new Error(`${variable} 必须位于仓库外`)
  let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error(`${variable} 必须是存在的仓库外文件`) }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || (state.mode & 0o777) !== 0o600 || state.uid !== currentUid() || actual !== resolved) throw new Error(`${variable} 必须是当前用户拥有、权限精确 0600、无链接的仓库外普通文件`)
  return resolved
}
const systemTemporaryRoots = ['/tmp', '/var/tmp', '/dev/shm']
function isUnder(pathname: string, root: string): boolean { return pathname === root || pathname.startsWith(`${root}${sep}`) }
function rejectHermesUntrustedLocation(pathname: string, variable: string): void {
  if (isUnder(pathname, repositoryRoot) || systemTemporaryRoots.some((root) => isUnder(pathname, root))) throw new Error(`${variable} 不得位于仓库或系统临时目录`)
}
function requireHermesPrivateRoot(value: string): string {
  const resolved = resolve(value); let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error('ILINK_HERMES_PRIVATE_ROOT 必须是存在的私有目录') }
  rejectHermesUntrustedLocation(actual, 'ILINK_HERMES_PRIVATE_ROOT')
  if (!state.isDirectory() || state.isSymbolicLink() || actual !== resolved || state.uid !== currentUid() || (state.mode & 0o777) !== 0o700) throw new Error('ILINK_HERMES_PRIVATE_ROOT 必须由当前用户拥有、非链接且权限精确0700')
  requireHermesRootAncestors(resolved, 'ILINK_HERMES_PRIVATE_ROOT')
  return resolved
}
function requireHermesRootAncestors(privateRoot: string, variable: string): void {
  for (let cursor = privateRoot;; cursor = dirname(cursor)) {
    let state: ReturnType<typeof lstatSync>
    try { state = lstatSync(cursor) } catch { throw new Error(`${variable} 祖先目录不可用`) }
    if (!state.isDirectory() || state.isSymbolicLink() || (state.uid !== currentUid() && state.uid !== 0) || (state.mode & 0o022) !== 0) throw new Error(`${variable} 的祖先目录不安全`)
    if (cursor === dirname(cursor)) return
  }
}
function hermesPathIdentity(pathname: string): string {
  const state = lstatSync(pathname)
  return `${state.dev}:${state.ino}`
}
function captureHermesPathIdentity(privateRoot: string, source: string, python: string): Readonly<{ privateRoot: string; source: string; python: string }> {
  return { privateRoot: hermesPathIdentity(privateRoot), source: hermesPathIdentity(source), python: hermesPathIdentity(python) }
}
function assertHermesPathIdentity(expected: Readonly<{ privateRoot: string; source: string; python: string }>, privateRoot: string, source: string, python: string): void {
  const actual = captureHermesPathIdentity(privateRoot, source, python)
  if (actual.privateRoot !== expected.privateRoot || actual.source !== expected.source || actual.python !== expected.python) throw new Error('Hermes 路径在校验期间发生变化')
}
function requireHermesDescendant(value: string, privateRoot: string, variable: string, directory: boolean, exactMode?: number, allowRootOwner = false): string {
  const resolved = resolve(value); let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error(`${variable} 必须是存在的绝对非链接路径`) }
  rejectHermesUntrustedLocation(actual, variable)
  if (!isUnder(actual, privateRoot) || actual !== resolved) throw new Error(`${variable} 必须位于 ILINK_HERMES_PRIVATE_ROOT 内且不得经过符号链接`)
  if ((directory && !state.isDirectory()) || (!directory && !state.isFile()) || state.isSymbolicLink() || (state.uid !== currentUid() && (!allowRootOwner || state.uid !== 0)) || (!directory && state.nlink !== 1)) throw new Error(`${variable} 类型、属主或链接不安全`)
  if (exactMode !== undefined ? (state.mode & 0o777) !== exactMode : (state.mode & 0o022) !== 0) throw new Error(`${variable} 权限不安全`)
  let cursor = directory ? actual : dirname(actual)
  while (cursor !== privateRoot) {
    const ancestor = lstatSync(cursor)
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== currentUid() || (ancestor.mode & 0o022) !== 0) throw new Error(`${variable} 的私有根目录下祖先不安全`)
    cursor = dirname(cursor)
  }
  return actual
}
function requireHermesSourceDirectory(value: string, privateRoot: string): string { return requireHermesDescendant(value, privateRoot, 'ILINK_HERMES_SOURCE_DIR', true, 0o700) }
function requireHermesPython(value: string, privateRoot: string, sourceDir: string): string {
  const python = requireHermesDescendant(value, privateRoot, 'ILINK_HERMES_PYTHON', false, undefined, true)
  if ((lstatSync(python).mode & 0o100) === 0 || isUnder(python, sourceDir)) throw new Error('ILINK_HERMES_PYTHON 必须可执行且不得位于 Hermes 源码 checkout 内')
  return python
}

/** Hermes-mode Gateway ledger roots are external, private and link-free. */
function requirePrivateExternalStateDirectory(path: string, variable: string): string {
  const resolved = resolve(path)
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${sep}`)) throw new Error(`${variable} 必须位于仓库外`)
  const parent = dirname(resolved)
  const ancestors: string[] = []
  for (let cursor = parent;; cursor = dirname(cursor)) {
    ancestors.push(cursor)
    if (cursor === dirname(cursor)) break
  }
  for (const ancestor of ancestors.reverse()) {
    let state: ReturnType<typeof lstatSync>
    try { state = lstatSync(ancestor) } catch { throw new Error(`${variable} 祖先目录必须存在且不得经过符号链接`) }
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`${variable} 祖先目录必须是非符号链接目录`)
  }
  try { mkdirSync(resolved, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error(`${variable} 必须是存在的仓库外目录`) }
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== currentUid() || (state.mode & 0o777) !== 0o700 || actual !== resolved || actual === repositoryRoot || actual.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error(`${variable} 必须是当前用户拥有、权限精确 0700、无链接的仓库外目录`)
  }
  return resolved
}

function requireRepositoryLauncher(path: string): void {
  const resolved = resolve(path)
  let state: ReturnType<typeof lstatSync>; let actual: string
  try { state = lstatSync(resolved); actual = realpathSync(resolved) } catch { throw new Error('Hermes launcher 不存在') }
  if (actual !== resolved || !state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.uid !== currentUid() || (state.mode & 0o022) !== 0 || (state.mode & 0o100) === 0) throw new Error('Hermes launcher 必须是仓库内当前用户拥有、非链接且不可被组或其他用户写入的可执行普通文件')
}

function readHermesRecipientMapFile(path: string): ReadonlyMap<number, { target: string; enabled: boolean }> {
  const resolved = requirePrivateExternalFile(path, 'ILINK_HERMES_RECIPIENT_MAP_FILE')
  let raw: unknown
  try { raw = JSON.parse(readFileSync(resolved, 'utf8')) } catch { throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 必须是合法 JSON') }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：根必须是对象')
  const entries = Object.entries(raw)
  if (entries.length < 1 || entries.length > 10) throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：必须为 1 至 10 个接收人')
  const recipientMap = new Map<number, { target: string; enabled: boolean }>()
  const peers = new Set<string>()
  for (const [key, value] of entries) {
    if (!/^[1-9]\d*$/.test(key)) throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：用户 ID 键必须为规范正整数')
    const userId = Number(key)
    if (!Number.isSafeInteger(userId)) throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：用户 ID 键超出安全整数范围')
    const parsed = hermesRecipientEntrySchema.safeParse(value)
    if (!parsed.success) throw new Error(`ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
    if (peers.has(parsed.data.peer)) throw new Error('ILINK_HERMES_RECIPIENT_MAP_FILE 格式无效：peer 不能重复')
    peers.add(parsed.data.peer); recipientMap.set(userId, { target: parsed.data.peer, enabled: parsed.data.enabled })
  }
  return recipientMap
}

/**
 * Offline operator check for the repository-external recipient map.  It
 * deliberately returns aggregate counts only: target values never reach
 * stdout, logs, or a process argument.
 */
export function inspectRecipientMapFile(path: string): { recipients: number; enabled: number; disabled: number } {
  const recipientMap = readRecipientMapFile(path)
  const enabled = enabledRecipientCount(recipientMap)
  return { recipients: recipientMap.size, enabled, disabled: recipientMap.size - enabled }
}

function enabledRecipientCount(recipientMap: ReadonlyMap<number, { target: string; enabled: boolean }>): number {
  let enabled = 0
  for (const recipient of recipientMap.values()) if (recipient.enabled) enabled += 1
  return enabled
}

export function ensurePrivateDirectory(path: string, variable: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`${variable} 必须是非符号链接目录`)
  if ((state.mode & 0o777) !== 0o700 || state.uid !== currentUid() || realpathSync(resolve(path)) !== resolve(path)) throw new Error(`${variable} 权限必须为当前用户拥有的 0700 非符号链接目录`)
}

/** OpenClaw configuration remains outside the state directory and must never traverse a symlink. */
export function ensurePrivateOpenClawConfigPath(path: string): void {
  const parent = dirname(path)
  let parentState: ReturnType<typeof lstatSync>
  try { parentState = lstatSync(parent) } catch { throw new Error('OPENCLAW_CONFIG_PATH 父目录必须存在且权限为 0700') }
  if (!parentState.isDirectory() || parentState.isSymbolicLink()) throw new Error('OPENCLAW_CONFIG_PATH 父目录必须是非符号链接目录')
  if ((parentState.mode & 0o777) !== 0o700) throw new Error('OPENCLAW_CONFIG_PATH 父目录权限必须为 0700')
  let fileState: ReturnType<typeof lstatSync>
  try { fileState = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!fileState.isFile() || fileState.isSymbolicLink()) throw new Error('OPENCLAW_CONFIG_PATH 必须是普通非符号链接文件')
  if ((fileState.mode & 0o077) !== 0) throw new Error('OPENCLAW_CONFIG_PATH 权限必须不超过 0600')
}

export function ensurePrivateStateDirectory(config: GatewayConfig): void { ensurePrivateDirectory(config.stateDir, 'ILINK_POC_STATE_DIR') }
export function ensurePrivateOpenClawStateDirectory(config: GatewayConfig): void {
  if (!config.openclawStateDir) throw new Error('ILINK_SESSION_PATH_INVALID')
  ensurePrivateDirectory(config.openclawStateDir, 'OPENCLAW_STATE_DIR')
}
