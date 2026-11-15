import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { withBuildLock } = await import('../cli/core/build-lock.mjs')

test('withBuildLock excludes a concurrent writer and releases after completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-lock-'))
  let releaseBarrier = () => {}
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })
  let entered = false
  const first = withBuildLock(root, async () => {
    entered = true
    await barrier
  })
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(() => withBuildLock(root, () => {}, { timeoutMs: 25 }), /Timed out waiting for build lock/)
  releaseBarrier()
  await first
  let secondEntered = false
  await withBuildLock(root, () => {
    secondEntered = true
  })
  assert.equal(secondEntered, true)
})

test('withBuildLock refuses to mutate output while a service process is alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-live-service-'))
  const runtime = join(root, '.runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'aw.lock'), JSON.stringify({ pid: process.pid, mode: 'test' }))
  let called = false
  await assert.rejects(() => withBuildLock(root, () => {
    called = true
  }), /stop the service first/)
  assert.equal(called, false)
})

test('withBuildLock removes its lock when the build callback fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-lock-fail-'))
  await assert.rejects(() => withBuildLock(root, () => {
    throw new Error('injected build failure')
  }), /injected build failure/)
  let entered = false
  await withBuildLock(root, () => {
    entered = true
  })
  assert.equal(entered, true)
})

test('withBuildLock reclaims a fresh lock whose holder pid is dead', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-lock-dead-'))
  const runtime = join(root, '.runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'build.lock'), JSON.stringify({
    pid: 0x7ffffff0,
    nonce: 'dead-holder',
    startedAt: new Date().toISOString(),
    appRoot: root,
  }))
  let entered = false
  // 旧实现要求「pid 已死 且 锁龄 > 24h」才回收,残锁会把构建挡到超时;这里必须快速进入。
  await withBuildLock(root, () => {
    entered = true
  }, { timeoutMs: 3000 })
  assert.equal(entered, true)
})

test('withBuildLock keeps an empty young lock (writer is mid-acquire) but reclaims it after grace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-lock-empty-'))
  const runtime = join(root, '.runtime')
  mkdirSync(runtime, { recursive: true })
  const lockPath = join(runtime, 'build.lock')
  writeFileSync(lockPath, '')
  await assert.rejects(() => withBuildLock(root, () => {}, { timeoutMs: 700 }), /Timed out waiting for build lock/)
  const old = new Date(Date.now() - 120_000)
  utimesSync(lockPath, old, old)
  let entered = false
  await withBuildLock(root, () => {
    entered = true
  }, { timeoutMs: 3000 })
  assert.equal(entered, true)
})
