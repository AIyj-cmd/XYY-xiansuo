import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { GatewayConfig } from './config.js'

const sessionSchema = z.object({
  botToken: z.string().min(1).max(8192),
  contextToken: z.string().min(1).max(8192),
  recipientExternalId: z.string().min(1).max(256),
  expiresAt: z.string().datetime().optional()
}).strict()
export type PocSession = z.infer<typeof sessionSchema>

function assertSessionPath(config: GatewayConfig): void {
  const expected = resolve(config.stateDir, 'session.json')
  if (resolve(config.sessionPath) !== expected || dirname(expected) !== resolve(config.stateDir)) throw new Error('ILINK_SESSION_PATH_INVALID')
}

export function readPocSession(config: GatewayConfig): PocSession {
  assertSessionPath(config)
  let stat
  try { stat = lstatSync(config.sessionPath) } catch { throw new Error('ILINK_SESSION_MISSING') }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('ILINK_SESSION_PATH_INVALID')
  if ((stat.mode & 0o077) !== 0) throw new Error('ILINK_SESSION_PERMISSION_INVALID')
  const resolved = realpathSync(config.sessionPath)
  if (dirname(resolved) !== realpathSync(config.stateDir)) throw new Error('ILINK_SESSION_PATH_INVALID')
  let rawSession: unknown
  try {
    rawSession = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch {
    throw new Error('ILINK_SESSION_INVALID')
  }
  const parsed = sessionSchema.safeParse(rawSession)
  if (!parsed.success) throw new Error('ILINK_SESSION_INVALID')
  if (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now()) throw new Error('ILINK_SESSION_EXPIRED')
  return parsed.data
}

export function clearPocSession(config: GatewayConfig): boolean {
  assertSessionPath(config)
  let stat
  try { stat = lstatSync(config.sessionPath) } catch { return false }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('ILINK_SESSION_PATH_INVALID')
  if ((stat.mode & 0o077) !== 0) throw new Error('ILINK_SESSION_PERMISSION_INVALID')
  const resolved = realpathSync(config.sessionPath)
  if (dirname(resolved) !== realpathSync(config.stateDir)) throw new Error('ILINK_SESSION_PATH_INVALID')
  unlinkSync(resolved)
  return true
}
