import { localService } from './common.js'
const { service, store } = localService()
try { console.log(JSON.stringify(await service.health())) } finally { store.close() }
