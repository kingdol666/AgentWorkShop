import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const {
  stopIntentPath,
  writeStopIntent,
  readStopIntent,
  clearStopIntent,
  isIntentionalStop,
} = await import('../shared/config/stop-intent.mjs')

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'aw-stop-intent-'))
}

test('stop intent roundtrip only matches exit code 0 with the current token', () => {
  const root = tempRoot()
  assert.equal(writeStopIntent(root, 'token-abc'), true)
  assert.equal(readStopIntent(root), 'token-abc')
  assert.equal(stopIntentPath(root), join(resolve(root), '.runtime', 'stop-intent'))
  assert.equal(readFileSync(stopIntentPath(root), 'utf8'), 'token-abc')

  assert.equal(isIntentionalStop(root, 'token-abc', { exitCode: 0, signal: null }), true)
  // 崩溃/信号/令牌不符/无令牌:一律按崩溃处理
  assert.equal(isIntentionalStop(root, 'token-abc', { exitCode: 1, signal: null }), false)
  assert.equal(isIntentionalStop(root, 'token-abc', { exitCode: 0, signal: 'SIGTERM' }), false)
  assert.equal(isIntentionalStop(root, 'token-other', { exitCode: 0, signal: null }), false)
  assert.equal(isIntentionalStop(root, '', { exitCode: 0, signal: null }), false)
})

test('missing intent marker never suppresses a restart', () => {
  const root = tempRoot()
  assert.equal(readStopIntent(root), '')
  assert.equal(isIntentionalStop(root, 'token-abc', { exitCode: 0, signal: null }), false)
})

test('clearStopIntent removes the marker so a stale intention cannot leak', () => {
  const root = tempRoot()
  assert.equal(writeStopIntent(root, 'token-abc'), true)
  clearStopIntent(root)
  assert.equal(readStopIntent(root), '')
  // 幂等:再次清理不抛错
  clearStopIntent(root)
})

test('stop intent path is confined to the trusted config root', () => {
  const root = tempRoot()
  assert.equal(stopIntentPath('relative/path'), null)
  assert.equal(stopIntentPath(''), null)
  assert.equal(stopIntentPath(null), null)

  // 即使 configRoot 里带 ..,规范化后标记也只能落在该根自己的 .runtime 下
  const escaped = join(root, '..', 'elsewhere')
  const target = stopIntentPath(escaped)
  assert.equal(target, join(resolve(escaped), '.runtime', 'stop-intent'))
  assert.equal(writeStopIntent(root, ''), false)
  assert.equal(existsSync(join(root, '.runtime', 'stop-intent')), false)
})

test('a marker planted by an unrelated crash does not suppress restart', () => {
  const root = tempRoot()
  // 上一次运行残留的令牌:与本次启动令牌不同 → 仍按崩溃重启
  assert.equal(writeStopIntent(root, 'old-token'), true)
  assert.equal(isIntentionalStop(root, 'new-token', { exitCode: 0, signal: null }), false)
})
