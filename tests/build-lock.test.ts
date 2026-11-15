import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
