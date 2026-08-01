import { readFileSync } from 'node:fs'
import { loadConfig, type GatewayConfig } from '../config.js'
import { runOfflinePilotControl, type PilotCliInput } from '../pilot-control.js'

type Command = PilotCliInput['command']
type ParsedFlags = ReadonlyMap<string, string | true>

const commandFlags: Record<Command, { required: readonly string[]; optional: readonly string[] }> = {
  'legacy-import': { required: ['--operator-uid', '--run-id', '--delivery-request-id', '--manifest-hash'], optional: ['--key-file', '--stdin'] },
  confirm: { required: ['--operator-uid', '--previous-key-hash', '--confirmation'], optional: ['--actual-received-count'] },
  prepare: { required: ['--operator-uid', '--run-id', '--generation', '--delivery-request-id', '--manifest-hash'], optional: ['--previous-key-hash', '--key-file', '--stdin'] },
  authorize: { required: ['--operator-uid', '--run-id', '--generation', '--authorization-id', '--expires-at'], optional: [] },
  cancel: { required: ['--operator-uid', '--run-id', '--generation'], optional: [] },
  reconcile: { required: ['--operator-uid'], optional: [] }
}
const commands = new Set<Command>(Object.keys(commandFlags) as Command[])
const valueFlags = new Set(['--operator-uid', '--run-id', '--generation', '--previous-key-hash', '--manifest-hash', '--delivery-request-id', '--authorization-id', '--expires-at', '--confirmation', '--actual-received-count', '--key-file'])
const failUsage = (): never => { throw new Error('ILINK_PILOT_CLI_USAGE') }

function parse(command: Command, values: readonly string[]): ParsedFlags {
  const policy = commandFlags[command]
  const allowed = new Set([...policy.required, ...policy.optional])
  const parsed = new Map<string, string | true>()
  for (let index = 1; index < values.length;) {
    const flag = values[index]
    if (!flag.startsWith('--') || !allowed.has(flag) || parsed.has(flag)) failUsage()
    if (flag === '--stdin') { parsed.set(flag, true); index += 1; continue }
    if (!valueFlags.has(flag)) failUsage()
    const supplied = values[index + 1]
    if (!supplied || supplied.startsWith('--')) failUsage()
    parsed.set(flag, supplied); index += 2
  }
  if (policy.required.some((flag) => !parsed.has(flag))) failUsage()
  if (parsed.has('--stdin') === parsed.has('--key-file') && (allowed.has('--stdin') || allowed.has('--key-file'))) failUsage()
  return parsed
}
function integer(value: string | true | undefined): number | undefined {
  if (value === undefined) return undefined
  if (value === true || !/^\d+$/.test(value)) failUsage()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) failUsage()
  return parsed
}
function stringValue(flags: ParsedFlags, flag: string): string | undefined {
  const value = flags.get(flag)
  return typeof value === 'string' ? value : undefined
}

export function runPilotControlCli(args = process.argv, stdin = '', config?: GatewayConfig, processes?: readonly string[]): Record<string, unknown> {
  const values = args.slice(2); const command = values[0] as Command
  if (!commands.has(command)) failUsage()
  const flags = parse(command, values)
  return runOfflinePilotControl(config ?? loadConfig(), {
    command,
    operatorUid: integer(flags.get('--operator-uid'))!,
    keyFile: stringValue(flags, '--key-file'),
    stdin: flags.has('--stdin') ? stdin : undefined,
    runId: stringValue(flags, '--run-id'),
    generation: integer(flags.get('--generation')),
    previousKeyHash: stringValue(flags, '--previous-key-hash') ?? null,
    manifestHash: stringValue(flags, '--manifest-hash'),
    deliveryRequestId: stringValue(flags, '--delivery-request-id'),
    authorizationId: stringValue(flags, '--authorization-id'),
    expiresAt: integer(flags.get('--expires-at')),
    confirmation: stringValue(flags, '--confirmation') as PilotCliInput['confirmation'],
    actualReceivedCount: integer(flags.get('--actual-received-count'))
  }, processes)
}
if (process.argv[1]?.endsWith('pilot-control.ts') || process.argv[1]?.endsWith('pilot-control.js')) {
  try { console.log(JSON.stringify(runPilotControlCli(process.argv, process.argv.includes('--stdin') ? readFileSync(0, 'utf8') : ''))) } catch (error) { process.exitCode = 2; console.log(JSON.stringify({ code: error instanceof Error ? error.message : 'ILINK_PILOT_CLI_INVALID' })) }
}
