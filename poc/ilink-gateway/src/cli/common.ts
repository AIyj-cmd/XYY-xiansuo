import { loadConfig, ensurePrivateStateDirectory } from '../config.js'
import { StateStore } from '../state-store.js'
import { ILinkAdapter } from '../adapters/ilink-adapter.js'
import { GatewayService } from '../gateway-service.js'
import { IdempotencyStore } from '../idempotency-store.js'

export function localService() {
  const config = loadConfig(); ensurePrivateStateDirectory(config)
  const store = new StateStore(config.stateDir)
  for (const warning of config.deprecatedWarnings) console.warn(`WARNING: ${warning}`)
  const adapter = new ILinkAdapter(config)
  return { service: new GatewayService(config, adapter, new IdempotencyStore(store)), store, config }
}
