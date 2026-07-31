import { loadConfig, ensurePrivateStateDirectory } from '../config.js'
import { clearPocSession } from '../session.js'
const config = loadConfig()
ensurePrivateStateDirectory(config)
console.log(JSON.stringify({ cleared: clearPocSession(config) }))
