import { lstatSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const bool = z.enum(['true', 'false']).optional().default('false').transform((value) => value === 'true')
const positiveInt = (min: number, max: number, fallback: number) => z.string().optional().default(String(fallback)).transform((value, ctx) => {
  if (!/^\d+$/.test(value)) { ctx.addIssue({ code: 'custom', message: '必须是整数' }); return z.NEVER }
  const result = Number(value)
  if (result < min || result > max) { ctx.addIssue({ code: 'custom', message: `必须在 ${min} 至 ${max} 之间` }); return z.NEVER }
  return result
})

const configSchema = z.object({
  ILINK_GATEWAY_HOST: z.string().optional().default('127.0.0.1').refine((value) => value === '127.0.0.1' || value === '::1', 'PoC Gateway 只允许本地监听'),
  ILINK_GATEWAY_PORT: positiveInt(1024, 65535, 38115),
  ILINK_GATEWAY_STATE_DIR: z.string().optional().default('./state'),
  ILINK_GATEWAY_SECRET: z.string().min(32, 'Gateway Secret 至少 32 个字符'),
  ILINK_GATEWAY_PREVIOUS_SECRET: z.string().min(32).optional(),
  ILINK_POC_ADAPTER: z.enum(['fake', 'ilink']).optional().default('fake'),
  ILINK_POC_LIVE_ENABLED: bool,
  ILINK_POC_RECIPIENT_EXTERNAL_ID: z.string().min(1).max(256),
  ILINK_POC_ALLOWED_DETAIL_URL: z.string().url().optional(),
  ILINK_POC_API_BASE_URL: z.string().url().optional(),
  ILINK_POC_APP_ID: z.string().min(1).max(200).optional(),
  ILINK_POC_CLIENT_VERSION: positiveInt(1, 4_294_967_295, 1),
  ILINK_POC_CHANNEL_VERSION: z.string().min(1).max(64).optional().default('0.1.0'),
  ILINK_POC_BOT_AGENT: z.string().min(1).max(256).regex(/^[\x20-\x7E]+$/).optional().default('XYY-xiansuo-iLink-PoC/0.1.0'),
  ILINK_POC_TIMEOUT_MS: positiveInt(1000, 60000, 10000),
  ILINK_GATEWAY_CLOCK_SKEW_SECONDS: positiveInt(30, 600, 300),
  ILINK_GATEWAY_RATE_LIMIT_PER_MINUTE: positiveInt(1, 120, 30)
}).strict()

export type GatewayConfig = z.output<typeof configSchema> & { stateDir: string; sessionPath: string }

const knownKeys = Object.keys(configSchema.shape)

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const unknownManaged = Object.keys(env).filter((key) => key.startsWith('ILINK_') && !knownKeys.includes(key))
  if (unknownManaged.length) throw new Error(`iLink Gateway 配置无效：不支持的受管配置 ${unknownManaged.join(', ')}`)
  const projected = Object.fromEntries(knownKeys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]))
  const parsed = configSchema.safeParse(projected)
  if (!parsed.success) throw new Error(`iLink Gateway 配置无效：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
  const stateDir = resolve(parsed.data.ILINK_GATEWAY_STATE_DIR)
  const config = { ...parsed.data, stateDir, sessionPath: join(stateDir, 'session.json') }
  if (config.ILINK_POC_LIVE_ENABLED && config.ILINK_POC_ADAPTER !== 'ilink') throw new Error('ILINK_POC_LIVE_ENABLED=true 时 adapter 必须为 ilink')
  if (config.ILINK_POC_LIVE_ENABLED && (!config.ILINK_POC_API_BASE_URL || !config.ILINK_POC_APP_ID)) {
    throw new Error('iLink live 模式需要显式的 API base URL 和 App ID；会话凭证只能由受控 state/session.json 提供，本轮不会自动登录或生成二维码')
  }
  return config
}

export function ensurePrivateStateDirectory(config: GatewayConfig): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
  const state = lstatSync(config.stateDir)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('ILINK_GATEWAY_STATE_DIR 必须是非符号链接目录')
  if ((state.mode & 0o077) !== 0) throw new Error('ILINK_GATEWAY_STATE_DIR 权限必须为 0700')
}
