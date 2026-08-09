import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const toolSource = join(process.cwd(), 'scripts/normalize-runtime-launchers.mjs')
const launcherPaths = [
  'poc/hermes-weixin-transport/run-hermes-weixin-transport.sh',
  'poc/hermes-weixin-transport/run-account-manager.sh',
  'poc/ilink-gateway/run-hermes-gateway.sh'
]

function fixture(forceUnsafeMode = true) {
  const root = mkdtempSync(join(tmpdir(), 'xiansuo-launcher-normalizer-'))
  const tool = join(root, 'poc/ilink-gateway/scripts/normalize-runtime-launchers.mjs')
  mkdirSync(dirname(tool), { recursive: true, mode: 0o700 }); cpSync(toolSource, tool)
  for (const relative of launcherPaths) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o777 })
    if (forceUnsafeMode) chmodSync(path, 0o775)
  }
  return { root, tool, launcher: (index: number) => join(root, launcherPaths[index]) }
}

function run(tool: string, args: string[] = [], preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), tool, ...args], { encoding: 'utf8' })
}

function mode(subject: ReturnType<typeof fixture>, index: number): number { return lstatSync(subject.launcher(index)).mode & 0o777 }
function hashes(subject: ReturnType<typeof fixture>): string[] {
  return launcherPaths.map((_path, index) => createHash('sha256').update(readFileSync(subject.launcher(index))).digest('hex'))
}
function assertUntouchedPrefix(subject: ReturnType<typeof fixture>) {
  assert.equal(mode(subject, 0), 0o775); assert.equal(mode(subject, 1), 0o775)
}

test('normalizer recovers launcher modes from supported umasks to 0755', () => {
  for (const umask of [0o000, 0o002, 0o022, 0o077]) {
    const oldUmask = process.umask(umask); let subject: ReturnType<typeof fixture>
    try { subject = fixture(false) } finally { process.umask(oldUmask) }
    try {
      const before = hashes(subject)
      const result = run(subject.tool)
      assert.equal(result.status, 0, `umask ${umask.toString(8)}: ${result.stderr}`)
      for (let index = 0; index < launcherPaths.length; index++) assert.equal(mode(subject, index), 0o755)
      assert.deepEqual(hashes(subject), before)
    } finally { rmSync(subject.root, { recursive: true, force: true }) }
  }
})

test('normalizer is idempotent and leaves launcher content unchanged', () => {
  const subject = fixture()
  try {
    const before = hashes(subject)
    assert.equal(run(subject.tool).status, 0)
    assert.equal(run(subject.tool).status, 0)
    for (let index = 0; index < launcherPaths.length; index++) assert.equal(mode(subject, index), 0o755)
    assert.deepEqual(hashes(subject), before)
  } finally { rmSync(subject.root, { recursive: true, force: true }) }
})

test('normalizer leaves every launcher unchanged when a later launcher is a symbolic link', () => {
  const subject = fixture(); const outside = join(subject.root, 'outside.sh')
  try {
    writeFileSync(outside, '#!/usr/bin/env bash\n', { mode: 0o777 }); chmodSync(outside, 0o775)
    rmSync(subject.launcher(2)); symlinkSync(outside, subject.launcher(2))
    const result = run(subject.tool)
    assert.notEqual(result.status, 0); assert.match(result.stderr, /O_NOFOLLOW/)
    assertUntouchedPrefix(subject); assert.equal(lstatSync(subject.launcher(2)).isSymbolicLink(), true)
    assert.equal(lstatSync(outside).mode & 0o777, 0o775)
  } finally { rmSync(subject.root, { recursive: true, force: true }) }
})

test('normalizer leaves every launcher unchanged when a later launcher is multiply linked', () => {
  const subject = fixture(); const outside = join(subject.root, 'outside.sh')
  try {
    writeFileSync(outside, '#!/usr/bin/env bash\n', { mode: 0o777 }); chmodSync(outside, 0o775)
    rmSync(subject.launcher(2)); linkSync(outside, subject.launcher(2))
    const result = run(subject.tool)
    assert.notEqual(result.status, 0); assert.match(result.stderr, /单硬链接/)
    assertUntouchedPrefix(subject); assert.equal(lstatSync(outside).nlink, 2); assert.equal(lstatSync(outside).mode & 0o777, 0o775)
  } finally { rmSync(subject.root, { recursive: true, force: true }) }
})

test('normalizer leaves every launcher unchanged when a later launcher is missing or non-regular', async (context) => {
  await context.test('missing', () => {
    const subject = fixture()
    try {
      rmSync(subject.launcher(2))
      const result = run(subject.tool)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /O_NOFOLLOW/); assertUntouchedPrefix(subject)
    } finally { rmSync(subject.root, { recursive: true, force: true }) }
  })
  await context.test('directory', () => {
    const subject = fixture()
    try {
      rmSync(subject.launcher(2)); mkdirSync(subject.launcher(2), { mode: 0o700 })
      const result = run(subject.tool)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /普通文件/); assertUntouchedPrefix(subject)
    } finally { rmSync(subject.root, { recursive: true, force: true }) }
  })
})

test('normalizer leaves every launcher unchanged when a later launcher has another UID', () => {
  const subject = fixture(); const preload = join(subject.root, 'other-uid.mjs')
  try {
    writeFileSync(preload, "import fs from 'node:fs'\nimport { syncBuiltinESMExports } from 'node:module'\nconst original = fs.fstatSync\nlet calls = 0\nfs.fstatSync = (fd) => { const state = original(fd); calls += 1; if (calls !== 3) return state; return Object.assign(Object.create(state), { uid: state.uid + 1 }) }\nsyncBuiltinESMExports()\n", { mode: 0o600 })
    const result = run(subject.tool, [], preload)
    assert.notEqual(result.status, 0); assert.match(result.stderr, /当前用户拥有/); assertUntouchedPrefix(subject)
    assert.equal(mode(subject, 2), 0o775)
  } finally { rmSync(subject.root, { recursive: true, force: true }) }
})

test('normalizer check rejects caller-supplied paths and leaves non-whitelisted files untouched', () => {
  const subject = fixture(); const outside = join(subject.root, 'not-a-runtime-launcher.sh')
  try {
    writeFileSync(outside, '#!/usr/bin/env bash\n', { mode: 0o777 }); chmodSync(outside, 0o775)
    const result = run(subject.tool, ['--path', outside])
    assert.notEqual(result.status, 0); assert.match(result.stderr, /不接受路径或其他参数/)
    assert.equal(lstatSync(outside).mode & 0o777, 0o775)
    for (let index = 0; index < launcherPaths.length; index++) assert.equal(mode(subject, index), 0o775)
  } finally { rmSync(subject.root, { recursive: true, force: true }) }
})
