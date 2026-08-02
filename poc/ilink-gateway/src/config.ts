import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
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

const configSchema = z.object({
  ILINK_POC_LIVE_ENABLED: bool,
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
  ILINK_GATEWAY_RATE_LIMIT_PER_MINUTE: positiveInt(1, 120, 30)
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
  const rawOpenclawConfigPath = env.OPENCLAW_CONFIG_PATH
  if (!rawOpenclawConfigPath || !absolutePath.safeParse(rawOpenclawConfigPath).success) throw new Error('iLink Gateway 配置无效：OPENCLAW_CONFIG_PATH 必须为绝对路径')
  const openclawConfigPath = resolve(rawOpenclawConfigPath)
  ensurePrivateOpenClawConfigPath(openclawConfigPath)
  const gatewaySecret = readSecretFile(parsed.data.ILINK_GATEWAY_SECRET_FILE)
  const recipientMap = parsed.data.OPENCLAW_RECIPIENT_MAP_FILE === undefined ? undefined : readRecipientMapFile(parsed.data.OPENCLAW_RECIPIENT_MAP_FILE)
  const hasLegacyRecipientConfig = parsed.data.OPENCLAW_PILOT_USER_ID !== undefined || parsed.data.ILINK_POC_RECIPIENT_EXTERNAL_ID !== undefined
  if (!recipientMap && (parsed.data.OPENCLAW_PILOT_USER_ID === undefined || parsed.data.ILINK_POC_RECIPIENT_EXTERNAL_ID === undefined)) throw new Error('iLink Gateway 配置无效：未配置 OPENCLAW_RECIPIENT_MAP_FILE 时必须同时设置旧单接收人配置')
  if (hasLegacyRecipientConfig) warnings.push(recipientMap ? '旧单接收人配置已废弃且被 OPENCLAW_RECIPIENT_MAP_FILE 忽略；未输出用户或接收人标识' : '旧单接收人配置已废弃；请迁移至 OPENCLAW_RECIPIENT_MAP_FILE，未输出用户或接收人标识')
  if (parsed.data.ILINK_POC_LIVE_ENABLED && !openclawStateDir) throw new Error('iLink Gateway 配置无效：live 模式需要 OPENCLAW_STATE_DIR')
  return { ...parsed.data, stateDir, openclawStateDir, openclawConfigPath, gatewaySecret, recipientMap, deprecatedWarnings: warnings }
}

function readSecretFile(path: string): string {
  const resolved = resolve(path); let state: ReturnType<typeof lstatSync>
  try { state = lstatSync(resolved) } catch { throw new Error('ILINK_GATEWAY_SECRET_FILE 必须是存在的仓库外文件') }
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error('ILINK_GATEWAY_SECRET_FILE 必须是权限精确 0600 的普通文件')
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

/**
 * Offline operator check for the repository-external recipient map.  It
 * deliberately returns aggregate counts only: target values never reach
 * stdout, logs, or a process argument.
 */
export function inspectRecipientMapFile(path: string): { recipients: number; enabled: number; disabled: number } {
  const recipientMap = readRecipientMapFile(path)
  let enabled = 0
  for (const recipient of recipientMap.values()) if (recipient.enabled) enabled += 1
  return { recipients: recipientMap.size, enabled, disabled: recipientMap.size - enabled }
}

export function ensurePrivateDirectory(path: string, variable: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`${variable} 必须是非符号链接目录`)
  if ((state.mode & 0o077) !== 0) throw new Error(`${variable} 权限必须为 0700`)
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
