import { loadConfig, type GatewayConfig } from '../config.js'
import { OfficialRuntime, type PrereqResult } from '../official-runtime.js'

export function publicPrereq(result: PrereqResult): Record<string, unknown> {
  return { conclusion: result.conclusion, code: result.code, openclawInstalled: result.openclawInstalled, openclawVersion: result.openclawVersion, pluginInstalled: result.pluginInstalled, pluginVersion: result.pluginVersion, pluginCompatibility: result.pluginCompatibility, compatible: result.compatible }
}

export async function runPrereqCheck(runtime?: OfficialRuntime, config?: GatewayConfig): Promise<Record<string, unknown>> {
  config ??= loadConfig()
  return publicPrereq(await (runtime ?? new OfficialRuntime(config)).prereqCheck())
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runPrereqCheck()))
