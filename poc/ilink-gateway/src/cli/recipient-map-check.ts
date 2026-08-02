import { inspectRecipientMapFile } from '../config.js'

/**
 * Read-only offline validation for an administrator-maintained mapping file.
 * It neither loads the Gateway Secret nor connects to OpenClaw or WeChat.
 */
export function runRecipientMapCheck(path = process.env.OPENCLAW_RECIPIENT_MAP_FILE): Record<string, unknown> {
  if (!path) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须设置为仓库外绝对路径')
  return { conclusion: 'SAFE', ...inspectRecipientMapFile(path) }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(runRecipientMapCheck()))
