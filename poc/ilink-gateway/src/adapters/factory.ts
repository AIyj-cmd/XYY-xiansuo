import type { ChannelAdapter } from '../types.js'
import type { GatewayConfig } from '../config.js'
import { HermesAdapter } from './hermes-adapter.js'
import { ILinkAdapter } from './ilink-adapter.js'

/** Explicit config selection only; no adapter may fall back to another transport. */
export function createConfiguredAdapter(config: GatewayConfig): ChannelAdapter {
  return config.ILINK_POC_TRANSPORT === 'hermes' ? new HermesAdapter(config) : new ILinkAdapter(config)
}
