import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { ensurePrivateDirectory, ensurePrivateOpenClawConfigPath, ensurePrivateSessionDirectory, ensurePrivateStateDirectory, type GatewayConfig } from './config.js'

export type PrereqResult = {
  conclusion: 'READY' | 'NOT_READY'
  code?: string
  openclawInstalled: boolean
  openclawVersion?: string
  pluginInstalled: boolean
  pluginVersion?: string
  pluginCompatibility?: string
  compatible: boolean
}
export type OfficialSessionState = 'authenticated' | 'login_required' | 'expired' | 'restricted' | 'unsupported' | 'unknown' | 'offline'
export type OfficialSessionResult = { state: OfficialSessionState; code?: string; requiresHumanLogin: boolean }
export type CommandResult = { exitCode: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException; timedOut?: boolean }
export interface OfficialCommandRunner {
  run(command: string, args: readonly string[], timeoutMs: number, environment: NodeJS.ProcessEnv): Promise<CommandResult>
  interactive(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number | null>
}

export const childProcessRunner: OfficialCommandRunner = {
  run(command, args, timeoutMs, environment) {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: environment })
      let stdout = ''; let stderr = ''; let finished = false
      const finish = (value: CommandResult) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value) } }
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', (spawnError) => finish({ exitCode: null, stdout, stderr, spawnError }))
      child.on('close', (exitCode) => finish({ exitCode, stdout, stderr }))
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ exitCode: null, stdout, stderr, timedOut: true }) }, timeoutMs)
    })
  },
  interactive(command, args, environment) {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: 'inherit', shell: false, env: environment })
      child.on('error', () => resolve(null))
      child.on('close', (exitCode) => resolve(exitCode))
    })
  }
}

function versionFromText(value: string): string | undefined { return value.match(/\b(\d{4}\.\d{1,2}\.\d{1,2}(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] }
function parseJson(value: string): Record<string, unknown> | undefined {
  try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined } catch { return undefined }
}
function valueAt(object: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let value: unknown = object
  for (const key of path) value = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
  return value
}
function uniqueString(object: Record<string, unknown> | undefined, paths: readonly (readonly string[])[]): string | undefined {
  const values = paths.map((path) => valueAt(object, path)).filter((value): value is string => typeof value === 'string' && value.length > 0)
  return values.length > 0 && new Set(values).size === 1 ? values[0] : undefined
}
function uniqueCompatibility(object: Record<string, unknown> | undefined): string | undefined {
  const rangePaths: readonly (readonly string[])[] = [['engines', 'openclaw'], ['plugin', 'engines', 'openclaw'], ['manifest', 'engines', 'openclaw']]
  const minimumPaths: readonly (readonly string[])[] = [['openclaw', 'install', 'minHostVersion'], ['install', 'minHostVersion']]
  const values: string[] = []
  for (const path of rangePaths) {
    const raw = valueAt(object, path)
    if (raw === undefined) continue
    const normalized = typeof raw === 'string' && /^>=\d{4}\.\d{1,2}\.\d{1,2}$/.test(raw) ? raw : undefined
    if (!normalized) return undefined
    values.push(normalized)
  }
  for (const path of minimumPaths) {
    const raw = valueAt(object, path)
    if (raw === undefined) continue
    const normalized = typeof raw === 'string' && /^(?:>=)?\d{4}\.\d{1,2}\.\d{1,2}$/.test(raw) ? `>=${raw.replace(/^>=/, '')}` : undefined
    if (!normalized) return undefined
    values.push(normalized)
  }
  return values.length > 0 && new Set(values).size === 1 ? values[0] : undefined
}
function hasDeclaredCompatibility(object: Record<string, unknown> | undefined): boolean {
  const paths: readonly (readonly string[])[] = [['engines', 'openclaw'], ['plugin', 'engines', 'openclaw'], ['manifest', 'engines', 'openclaw'], ['openclaw', 'install', 'minHostVersion'], ['install', 'minHostVersion']]
  return paths.some((path) => valueAt(object, path) !== undefined)
}
const maxPluginPackageBytes = 64 * 1024
function pluginRootFromMetadata(metadata: Record<string, unknown> | undefined, sessionDir: string | undefined): string | undefined {
  if (!sessionDir) return undefined
  const paths: readonly (readonly string[])[] = [['rootDir'], ['plugin', 'rootDir'], ['install', 'installPath'], ['plugin', 'install', 'installPath']]
  const declared = paths.map((path) => valueAt(metadata, path)).filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (declared.length === 0 || declared.some((path) => !isAbsolute(path))) return undefined
  let stateRoot: string
  let roots: string[]
  try { stateRoot = realpathSync(sessionDir); roots = declared.map((path) => realpathSync(path)) } catch { return undefined }
  if (new Set(roots).size !== 1) return undefined
  const root = roots[0]
  const pathFromState = relative(stateRoot, root)
  if (pathFromState === '' || pathFromState === '..' || pathFromState.startsWith(`..${sep}`) || isAbsolute(pathFromState)) return undefined
  return root
}
/** Falls back only when the official CLI has no compatibility field at all, and only inside the isolated state root. */
function packageCompatibility(metadata: Record<string, unknown> | undefined, sessionDir: string | undefined): string | undefined {
  const root = pluginRootFromMetadata(metadata, sessionDir)
  if (!root) return undefined
  const packagePath = join(root, 'package.json')
  let fileState: ReturnType<typeof lstatSync>
  try { fileState = lstatSync(packagePath) } catch { return undefined }
  if (!fileState.isFile() || fileState.isSymbolicLink() || fileState.size > maxPluginPackageBytes) return undefined
  let parsed: Record<string, unknown> | undefined
  try { parsed = parseJson(readFileSync(packagePath, 'utf8')) } catch { return undefined }
  const minimum = valueAt(parsed, ['openclaw', 'install', 'minHostVersion'])
  return typeof minimum === 'string' && /^(?:>=)?\d{4}\.\d{1,2}\.\d{1,2}$/.test(minimum) ? `>=${minimum.replace(/^>=/, '')}` : undefined
}
function numericVersion(value: string): [number, number, number] | undefined {
  const match = value.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function declaredSendAction(value: unknown): boolean | undefined {
  if (value === true) return true
  if (value === false) return false
  if (Array.isArray(value) && value.every((action) => typeof action === 'string')) return value.includes('send') || value.includes('message.send')
  return undefined
}
/** Only public, explicit send declarations can prove the CLI bridge. `sendText` and free-form shapes are deliberately rejected. */
export function hasVerifiedOutboundSendCapability(payload: Record<string, unknown> | undefined, channel = 'openclaw-weixin'): boolean {
  if (!payload) return false
  if (payload.channels !== undefined) {
    if (!Array.isArray(payload.channels)) return false
    const matched = payload.channels.filter((entry): entry is Record<string, unknown> => {
      const value = asRecord(entry)
      return value?.channel === channel
    })
    if (matched.length !== 1) return false
    const plugin = asRecord(matched[0].plugin)
    return plugin?.id === channel && declaredSendAction(matched[0].actions) === true
  }
  const roots = [payload, asRecord(payload.capabilities)].filter((value): value is Record<string, unknown> => value !== undefined)
  const declarations: boolean[] = []
  for (const root of roots) {
    const rootSend = declaredSendAction(root.send); if (rootSend !== undefined) declarations.push(rootSend)
    const actions = root.actions
    if (Array.isArray(actions)) { const action = declaredSendAction(actions); if (action !== undefined) declarations.push(action) }
    const actionObject = asRecord(actions); if (actionObject) { const action = declaredSendAction(actionObject.send); if (action !== undefined) declarations.push(action) }
  }
  return declarations.length > 0 && declarations.every(Boolean)
}

/** Only accepts a plainly declared minimum date-version. Ambiguous plugin ranges remain NOT_READY. */
export function satisfiesDeclaredCompatibility(openclawVersion: string, compatibility: string): boolean | undefined {
  const match = compatibility.trim().match(/^>=\s*(\d{4}\.\d{1,2}\.\d{1,2})(?:\s*)$/)
  const actual = numericVersion(openclawVersion); const minimum = match?.[1] === undefined ? undefined : numericVersion(match[1])
  return actual && minimum ? compareVersion(actual, minimum) >= 0 : undefined
}

export class OfficialRuntime {
  constructor(private readonly config: GatewayConfig, private readonly runner: OfficialCommandRunner = childProcessRunner) {}
  private environment(): NodeJS.ProcessEnv {
    ensurePrivateOpenClawConfigPath(this.config.openclawConfigPath)
    const sessionDir = this.config.sessionDir ?? `${this.config.stateDir}/openclaw-offline`
    if (this.config.sessionDir) ensurePrivateSessionDirectory(this.config)
    else {
      ensurePrivateStateDirectory(this.config)
      ensurePrivateDirectory(sessionDir, 'ILINK_POC_OFFLINE_OPENCLAW_DIR')
    }
    // Explicitly overwrite, rather than inherit, any parent OpenClaw state/config location.
    return { ...process.env, OPENCLAW_STATE_DIR: sessionDir, OPENCLAW_CONFIG_PATH: this.config.openclawConfigPath }
  }
  private async run(args: readonly string[], timeoutMs: number): Promise<CommandResult> { return this.runner.run(this.config.ILINK_OPENCLAW_BIN, args, timeoutMs, this.environment()) }
  async prereqCheck(): Promise<PrereqResult> {
    let version: CommandResult
    try { version = await this.run(['--version'], this.config.ILINK_SESSION_CHECK_TIMEOUT_MS) } catch { return { conclusion: 'NOT_READY', code: 'ILINK_SESSION_PATH_INVALID', openclawInstalled: false, pluginInstalled: false, compatible: false } }
    if (version.spawnError || version.exitCode !== 0) return { conclusion: 'NOT_READY', code: 'ILINK_OPENCLAW_NOT_INSTALLED', openclawInstalled: false, pluginInstalled: false, compatible: false }
    const openclawVersion = versionFromText(version.stdout)
    if (!openclawVersion) return { conclusion: 'NOT_READY', code: 'ILINK_VERSION_UNSUPPORTED', openclawInstalled: true, pluginInstalled: false, compatible: false }
    const plugin = await this.run(['plugins', 'info', this.config.ILINK_OPENCLAW_CHANNEL, '--json'], this.config.ILINK_SESSION_CHECK_TIMEOUT_MS)
    if (plugin.spawnError || plugin.exitCode !== 0) return { conclusion: 'NOT_READY', code: 'ILINK_PLUGIN_NOT_INSTALLED', openclawInstalled: true, openclawVersion, pluginInstalled: false, compatible: false }
    const metadata = parseJson(plugin.stdout)
    const pluginVersion = uniqueString(metadata, [['version'], ['plugin', 'version'], ['manifest', 'version']])
    const pluginCompatibility = uniqueCompatibility(metadata) ?? (hasDeclaredCompatibility(metadata) ? undefined : packageCompatibility(metadata, this.config.sessionDir))
    const compatible = pluginCompatibility === undefined ? undefined : satisfiesDeclaredCompatibility(openclawVersion, pluginCompatibility)
    if (!pluginVersion || !pluginCompatibility || compatible !== true) return { conclusion: 'NOT_READY', code: 'ILINK_VERSION_UNSUPPORTED', openclawInstalled: true, openclawVersion, pluginInstalled: true, pluginVersion, pluginCompatibility, compatible: false }
    const capabilities = await this.run(['channels', 'capabilities', '--channel', this.config.ILINK_OPENCLAW_CHANNEL, '--timeout', String(this.config.ILINK_SESSION_CHECK_TIMEOUT_MS), '--json'], this.config.ILINK_SESSION_CHECK_TIMEOUT_MS)
    if (capabilities.spawnError || capabilities.exitCode !== 0 || !hasVerifiedOutboundSendCapability(parseJson(capabilities.stdout), this.config.ILINK_OPENCLAW_CHANNEL)) return { conclusion: 'NOT_READY', code: 'ILINK_SEND_CONTRACT_UNVERIFIED', openclawInstalled: true, openclawVersion, pluginInstalled: true, pluginVersion, pluginCompatibility, compatible: false }
    return { conclusion: 'READY', openclawInstalled: true, openclawVersion, pluginInstalled: true, pluginVersion, pluginCompatibility, compatible: true }
  }
  async sessionStatus(): Promise<OfficialSessionResult> {
    const prereq = await this.prereqCheck()
    if (prereq.conclusion !== 'READY') return { state: 'unsupported', code: prereq.code ?? 'ILINK_VERSION_UNSUPPORTED', requiresHumanLogin: false }
    const result = await this.run(['channels', 'status', '--channel', this.config.ILINK_OPENCLAW_CHANNEL, '--probe', '--timeout', String(this.config.ILINK_SESSION_CHECK_TIMEOUT_MS), '--json'], this.config.ILINK_SESSION_CHECK_TIMEOUT_MS)
    if (result.spawnError) return { state: 'offline', code: 'ILINK_GATEWAY_OFFLINE', requiresHumanLogin: false }
    const payload = parseJson(result.stdout); const raw = uniqueString(payload, [['status'], ['session', 'status'], ['channel', 'status']])?.toLowerCase()
    if (result.exitCode !== 0 || !raw) return { state: 'unknown', code: 'ILINK_SESSION_STATUS_UNKNOWN', requiresHumanLogin: false }
    if (['authenticated', 'logged_in', 'ready'].includes(raw)) return { state: 'authenticated', requiresHumanLogin: false }
    if (['login_required', 'not_logged_in', 'unauthenticated'].includes(raw)) return { state: 'login_required', code: 'ILINK_LOGIN_REQUIRED', requiresHumanLogin: true }
    if (['expired', 'session_expired'].includes(raw)) return { state: 'expired', code: 'ILINK_SESSION_EXPIRED', requiresHumanLogin: true }
    if (['restricted', 'blocked', 'account_restricted'].includes(raw)) return { state: 'restricted', code: 'ILINK_ACCOUNT_RESTRICTED', requiresHumanLogin: false }
    if (['offline', 'unreachable'].includes(raw)) return { state: 'offline', code: 'ILINK_GATEWAY_OFFLINE', requiresHumanLogin: false }
    return { state: 'unknown', code: 'ILINK_SESSION_STATUS_UNKNOWN', requiresHumanLogin: false }
  }
  async login(): Promise<{ code?: string; exitCode?: number | null }> {
    const prereq = await this.prereqCheck()
    if (prereq.conclusion !== 'READY') return { code: prereq.code ?? 'ILINK_VERSION_UNSUPPORTED' }
    const exitCode = await this.runner.interactive(this.config.ILINK_OPENCLAW_BIN, ['channels', 'login', '--channel', this.config.ILINK_OPENCLAW_CHANNEL], this.environment())
    return exitCode === 0 ? { exitCode } : { code: 'ILINK_OFFICIAL_LOGIN_FAILED', exitCode }
  }
  async sendSynthetic(recipientExternalId: string, message: string): Promise<CommandResult> {
    return this.run(['message', 'send', '--channel', this.config.ILINK_OPENCLAW_CHANNEL, '--target', recipientExternalId, '--message', message, '--json'], this.config.ILINK_REQUEST_TIMEOUT_MS)
  }
}
