import { inspectRecipientMapFile } from '../config.js'

/**
 * Read-only offline validation for an administrator-maintained mapping file.
 * It neither loads the Gateway Secret nor connects to OpenClaw or WeChat.
 */
export function runRecipientMapCheck(path = process.env.OPENCLAW_RECIPIENT_MAP_FILE): Record<string, unknown> {
  if (!path) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 必须设置为仓库外绝对路径')
  const inspection = inspectRecipientMapFile(path)
  if (inspection.enabled !== 1) throw new Error('OPENCLAW_RECIPIENT_MAP_FILE 发布检查失败：必须恰好一个 enabled=true')
  return { conclusion: 'SAFE', ...inspection }
}

export function runRecipientMapCheckProgram(path = process.env.OPENCLAW_RECIPIENT_MAP_FILE, write: (line: string) => void = console.log): number {
  try {
    write(JSON.stringify(runRecipientMapCheck(path)))
    return 0
  } catch {
    // A release gate must not reveal a map key or target when it fails.
    write(JSON.stringify({ conclusion: 'UNSAFE', code: 'OPENCLAW_RECIPIENT_MAP_CHECK_FAILED' }))
    return 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = runRecipientMapCheckProgram()
