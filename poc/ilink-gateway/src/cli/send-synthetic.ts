import { randomUUID } from 'node:crypto'
import { localService } from './common.js'
import { syntheticRequest } from '../message-policy.js'
const { service, store, config } = localService()
try { console.log(JSON.stringify(await service.deliver(syntheticRequest(config.ILINK_POC_RECIPIENT_EXTERNAL_ID, `synthetic-${randomUUID()}`)))) } finally { store.close() }
