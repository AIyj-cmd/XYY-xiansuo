import { localService } from './common.js'
const { service, store } = localService()
try { const health = await service.health(); console.log(JSON.stringify({ adapter: health.adapter, liveEnabled: health.liveEnabled, sessionStatus: health.sessionStatus, status: health.status, code: health.code })) } finally { store.close() }
