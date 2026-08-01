import { ensurePrivateSessionDirectory, ensurePrivateStateDirectory, loadConfig, type GatewayConfig } from '../config.js'
import { OfficialRuntime } from '../official-runtime.js'

export async function runLogin(args: readonly string[], runtime?: OfficialRuntime, config?: GatewayConfig): Promise<Record<string, unknown>> {
  if (!args.includes('--confirm-live-login')) return { code: 'ILINK_LIVE_LOGIN_CONFIRMATION_REQUIRED', started: false }
  if (args.length !== 1) return { code: 'ILINK_CLI_ARGUMENT_INVALID', started: false }
  config ??= loadConfig()
  if (!config.ILINK_POC_LIVE_ENABLED) return { code: 'ILINK_LIVE_DISABLED', started: false }
  ensurePrivateStateDirectory(config)
  ensurePrivateSessionDirectory(config)
  const result = await (runtime ?? new OfficialRuntime(config)).login()
  return { code: result.code ?? 'OK', started: result.code === undefined, exitCode: result.exitCode }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runLogin(process.argv.slice(2))))
