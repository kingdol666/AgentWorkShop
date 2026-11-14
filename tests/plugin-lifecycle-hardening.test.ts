/**
 * 插件生命周期加固回归(2026-11-14 P1):
 *  ① servicesExt.provide 的 owner 清理(重载/停用后旧插件服务不可再获取);
 *  ② DAQ frame processor 按 owner 清理;
 *  ③ rollbackPartialLoad 等待异步 dispose 完成;
 *  ④ kv 重试定时器受 dispose 防护(旧实例不再写盘)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('servicesExt.unregisterOwner 只清该插件 provide 的条目,宿主核心服务不受影响', async () => {
  const { servicesExt } = await import('../server/services/workshop/plugins/host/services.mjs')
  servicesExt.owners ??= new Map()
  servicesExt.register('context.runtime', async () => ({ core: true }))
  servicesExt.provide('old-plugin', 'secret', async () => ({ stale: true }))
  servicesExt.provide('new-plugin', 'data', async () => ({ fresh: true }))
  assert.ok(servicesExt.names().includes('old-plugin.secret'))
  servicesExt.unregisterOwner('old-plugin')
  assert.equal(servicesExt.names().includes('old-plugin.secret'), false, '旧插件服务必须被清理')
  assert.ok(servicesExt.names().includes('new-plugin.data'), '其他插件服务不受影响')
  assert.ok(servicesExt.names().includes('context.runtime'), '宿主核心服务不受影响')
  await assert.rejects(() => servicesExt.get('old-plugin.secret'))
})

test('clearPluginFrameProcessors 只清该 owner 注册的帧处理器', async () => {
  const frames = await import('../server/services/workshop/daq/frames')
  frames.registerFrameProcessor({ name: 'sec-test-a', applies: 'any', process: f => f }, 'sec-plugin-a')
  frames.registerFrameProcessor({ name: 'sec-test-b', applies: 'any', process: f => f }, 'sec-plugin-b')
  assert.ok(frames.listFrameProcessors().includes('sec-test-a'))
  frames.clearPluginFrameProcessors('sec-plugin-a')
  assert.equal(frames.listFrameProcessors().includes('sec-test-a'), false, '该 owner 的处理器已清理')
  assert.ok(frames.listFrameProcessors().includes('sec-test-b'), '其他 owner 的处理器保留')
  frames.clearPluginFrameProcessors('sec-plugin-b')
  assert.equal(frames.listFrameProcessors().includes('sec-test-b'), false)
})

test('rollbackPartialLoad 等待异步 dispose 完成(不提前继续)', async () => {
  const { rollbackPartialLoad } = await import('../server/services/workshop/plugins/host/rollback.mjs')
  const host = {
    routes: { unregisterPlugin: () => 0 },
    disposables: new Map(),
    hookOffs: new Map(),
    plugins: new Map(),
    logger: { warn() {}, error() {} },
  }
  let finished = false
  host.disposables.set('async-plugin', [
    () => new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true
        resolve()
      }, 80)
    }),
  ])
  await rollbackPartialLoad(host, 'async-plugin')
  assert.equal(finished, true, 'rollback 必须等异步 dispose 完成才返回')
  assert.equal(host.disposables.has('async-plugin'), false)
})

test('kv 重试受 dispose 防护:dispose 后 flushKvAttempt 不再写盘', async () => {
  // 直接消费 SDK 内部行为:创建 createPluginContext 后 dispose,
  // 再模拟旧的 pending 重试(等价于 dispose 前已排程)不会覆盖 dispose 后的新内容。
  const home = mkdtempSync(join(tmpdir(), 'aw-kv-fence-'))
  try {
    const { createPluginContext } = await import('../sdk/context.mjs')
    const disposables: Array<() => unknown> = []
    const ctx = await createPluginContext({
      name: 'kv-fence-test',
      scope: 'builtin',
      dir: home,
      paths: { dataDir: home, home, configRoot: home },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      hooks: { on: () => () => {} },
      emitter: { on() {}, emit: async () => {} },
      onDispose: (fn: () => unknown) => {
        disposables.push(fn)
        return fn
      },
    })
    ctx.kv.set('marker', 'v1')
    // 立即 dispose(防抖/重试排程清空 + 同步落盘)
    for (const fn of disposables) await fn()
    const afterDispose = JSON.parse(readFileSync(join(home, 'plugins', 'kv-fence-test', 'kv.json'), 'utf8'))
    assert.equal(afterDispose.marker, 'v1', 'dispose 同步落盘保留最后一态')
    // dispose 后再 set 不应再写盘(旧实例已死;新实例是新 kv 上下文)
    ctx.kv.set('marker', 'v2-stale')
    const reread = JSON.parse(readFileSync(join(home, 'plugins', 'kv-fence-test', 'kv.json'), 'utf8'))
    assert.equal(reread.marker, 'v1', 'dispose 后旧实例的 set 不得覆盖已落盘状态')
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
})
