import { loadConfig, type GatewayConfig } from '../config.js'
import { OfficialRuntime, type OfficialSessionResult } from '../official-runtime.js'

export function publicSession(result: OfficialSessionResult): Record<string, unknown> {
  return { installed: result.state !== 'unsupported', loggedIn: result.state === 'authenticated', sessionStatus: result.state, requiresHumanLogin: result.requiresHumanLogin, code: result.code }
}
export async function runOfficialSessionStatus(runtime?: OfficialRuntime, config?: GatewayConfig): Promise<Record<string, unknown>> {
  config ??= loadConfig()
  return publicSession(await (runtime ?? new OfficialRuntime(config)).sessionStatus())
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runOfficialSessionStatus()))
