import { localService } from './common.js'
import { syntheticRequest } from '../message-policy.js'
import { requiredIdempotencyKey } from './arguments.js'
const { service, store, config } = localService()
try {
  const { key, expectDeduplicated } = requiredIdempotencyKey(process.argv.slice(2))
  const result = await service.deliver(syntheticRequest(Number(config.OPENCLAW_PILOT_USER_ID), key))
  if (expectDeduplicated && result.status !== 'deduplicated') process.exitCode = 2
  console.log(JSON.stringify(result))
} catch (error) {
  process.exitCode = 2
  console.log(JSON.stringify({ code: error instanceof Error ? error.message : 'ILINK_CLI_ARGUMENT_INVALID' }))
} finally { store.close() }
