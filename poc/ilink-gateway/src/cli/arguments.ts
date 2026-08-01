export function hasOnlyArguments(args: readonly string[], allowed: readonly string[]): boolean { return args.every((arg) => allowed.includes(arg)) }

export function requiredIdempotencyKey(args: readonly string[]): { key: string; expectDeduplicated: boolean } {
  const expectDeduplicated = args.includes('--expect-deduplicated')
  const indexes = args.map((arg, index) => arg === '--idempotency-key' ? index : -1).filter((index) => index >= 0)
  if (indexes.length !== 1 || indexes[0] === args.length - 1) throw new Error('ILINK_IDEMPOTENCY_KEY_REQUIRED')
  const key = args[indexes[0] + 1]
  if (args.length !== 2 + (expectDeduplicated ? 1 : 0) || (expectDeduplicated && args.at(-1) !== '--expect-deduplicated')) throw new Error('ILINK_CLI_ARGUMENT_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(key)) throw new Error('ILINK_IDEMPOTENCY_KEY_INVALID')
  return { key, expectDeduplicated }
}
