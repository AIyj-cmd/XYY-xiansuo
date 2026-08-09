#!/usr/bin/env node
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Git records only the executable bit.  These are the complete, immutable
// runtime-launcher allowlist; this tool deliberately accepts no paths or other
// input so it cannot be repurposed to change a secret, vault, or user file.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const runtimeLaunchers = Object.freeze([
  join(repositoryRoot, 'poc/hermes-weixin-transport/run-hermes-weixin-transport.sh'),
  join(repositoryRoot, 'poc/hermes-weixin-transport/run-account-manager.sh'),
  join(repositoryRoot, 'poc/ilink-gateway/run-hermes-gateway.sh')
])

function fail(message) { throw new Error(`运行启动器权限规范化失败：${message}`) }

function currentUid() {
  const uid = process.getuid?.()
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) fail('当前运行平台无法校验文件属主')
  return uid
}

function assertSafeRegularFile(state, label) {
  if (!state.isFile() || state.uid !== currentUid() || state.nlink !== 1) {
    fail(`${label} 必须是当前用户拥有、单硬链接的普通文件`)
  }
}

function openAndVerifyLauncher(path) {
  if (typeof constants.O_NOFOLLOW !== 'number') fail('当前运行平台不支持 O_NOFOLLOW')
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    fail('固定白名单启动器无法以 O_NOFOLLOW 打开')
  }
  try {
    assertSafeRegularFile(fstatSync(fd), '固定白名单启动器')
    return { path, fd }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function normalizeLaunchers() {
  const opened = []
  try {
    // No permission is changed until every fixed allowlist entry has been
    // opened with O_NOFOLLOW and passed the descriptor-based safety checks.
    for (const path of runtimeLaunchers) opened.push(openAndVerifyLauncher(path))
    for (const launcher of opened) fchmodSync(launcher.fd, 0o755)
    for (const launcher of opened) {
      const after = fstatSync(launcher.fd)
      assertSafeRegularFile(after, '固定白名单启动器')
      if ((after.mode & 0o777) !== 0o755) fail('固定白名单启动器无法设为 0755')
    }
  } finally {
    for (const launcher of opened.reverse()) closeSync(launcher.fd)
  }
  // Verify the named entry after the descriptor is closed.  Any replacement
  // race remains fail-closed in the Gateway's requireRepositoryLauncher gate.
  for (const path of runtimeLaunchers) {
    const finalState = lstatSync(path)
    assertSafeRegularFile(finalState, '固定白名单启动器')
    if (finalState.isSymbolicLink() || (finalState.mode & 0o777) !== 0o755) fail('固定白名单启动器关闭后复核失败')
  }
}

if (process.argv.length !== 2) fail('不接受路径或其他参数；仅处理固定白名单')
normalizeLaunchers()
