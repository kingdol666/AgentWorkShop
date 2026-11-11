/**
 * R-1/R-2 生命周期增强回归(2026-11-01)
 *
 * R-1:AgentRuntime.stop() waits for consumption/finalization and dispose before returning,
 *      so manager shutdown can close the database without late finalized-statement writes.
 * R-2:daqPushRearm —— driverConfig 变更后:退避清空 + 订阅回收 + 死连接驱逐;
 *      健康连接绝不驱逐;退避中的节点 PATCH 后下一拍即可重试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { AgentRuntimeLifecycle } = await import('../server/services/workshop/runtime/agent-runtime/lifecycle')
const { evictMqttPoolConn, mqttKey, mqttPool } = await import('../server/services/workshop/daq/drivers/mqtt')

function makeMinimalRuntime(impl: Record<string, unknown>): AgentRuntimeLifecycle {
  // 最小 deps:只用到 abortController/mailbox/bus;不 start() 消费循环。
  const rt = Object.create(AgentRuntimeLifecycle.prototype) as AgentRuntimeLifecycle & Record<string, unknown>
  rt.agentId = 'test-agent-r1'
  rt.agentRole = 'worker'
  rt.channelId = 'ch-test'
  rt.state = 'idle'
  rt.started = false
  rt.abortController = null
  rt.loopPromise = null
  rt.impl = impl
  rt.deps = {
    mailbox: { close: () => {} },
    bus: { notifyAgent: () => {} },
  } as unknown as AgentRuntimeLifecycle['deps']
  rt.queueContext = () => ({})
  return rt
}

test('shutdown waits for runtime cleanup before database close', () => {
  const lifecycle = readFileSync(new URL('../server/services/workshop/runtime/agent-runtime/lifecycle.ts', import.meta.url), 'utf8')
  const observe = readFileSync(new URL('../server/services/workshop/runtime/manager/runtime-observe.ts', import.meta.url), 'utf8')
  const plugin = readFileSync(new URL('../server/plugins/workshop.ts', import.meta.url), 'utf8')
  assert.match(lifecycle, /await this\.disposeInBackground\(\)/)
  assert.match(lifecycle, /await this\.loopPromise/)
  assert.match(lifecycle, /await this\.postSettlePromise/)
  assert.match(observe, /await Promise\.all\(\[\.\.\.this\.agentIndex\.values\(\)\]\.map\(a => a\.stop\(\)\)\)/)
  assert.match(plugin, /await manager\.shutdown\(\)\s+db\.close\(\)/)
})

test('R-1: stop waits for the consume loop before disposing the harness', async () => {
  let releaseLoop!: () => void
  const loop = new Promise<void>((resolve) => {
    releaseLoop = resolve
  })
  let disposed = false
  const rt = makeMinimalRuntime({
    async dispose() {
      disposed = true
    },
  }) as unknown as AgentRuntimeLifecycle & { stop(): Promise<void> }
  ;(rt as unknown as { loopPromise: Promise<void> | null }).loopPromise = loop
  const stopping = rt.stop()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false, 'consume loop 未结束时不得 dispose harness')
  releaseLoop()
  await stopping
  assert.equal(disposed, true, 'stop 返回前必须完成 harness dispose')
})

test('R-1: stop waits for slow dispose so DB cannot close early', async () => {
  let disposeStarted = 0
  let disposeFinished = 0
  const slowImpl = {
    async dispose() {
      disposeStarted++
      await new Promise(r => setTimeout(r, 40))
      disposeFinished++
    },
  }
  const rt = makeMinimalRuntime(slowImpl) as unknown as { stop(): Promise<void> }
  await rt.stop()
  assert.equal(disposeStarted, 1, 'stop() 返回前必须开始 dispose')
  assert.equal(disposeFinished, 1, 'stop() 返回前 dispose 必须完成')
})
test('R-1: dispose 抛错不冒泡(后台容错)', async () => {
  const badImpl = {
    async dispose() {
      throw new Error('boom')
    },
  }
  const rt = makeMinimalRuntime(badImpl) as unknown as { stop(): Promise<void> }
  await rt.stop()
  await new Promise(r => setTimeout(r, 80))
  // 不抛即通过(unhandled rejection 会让 node:test 进程崩)
  assert.ok(true)
})

test('R-2: evictMqttPoolConn 只驱逐未连接条目,健康连接不碰', () => {
  const cfg = { host: '127.0.0.1', port: '59999', topic: 't' } // 无真实 broker
  const fakeConn = { client: { end: () => {} }, connected: false, topics: new Map(), key: '', lastError: null }
  const key = mqttKey(cfg)
  // 注入一个"未连接"的僵尸条目 → 应被驱逐
  ;(mqttPool as Map<string, unknown>).set(key, fakeConn)
  assert.equal(evictMqttPoolConn(cfg), true, '僵尸条目应被驱逐')
  assert.equal((mqttPool as Map<string, unknown>).has(key), false, '驱逐后条目移除')
  // 健康条目 → 不驱逐
  const healthy = { client: { end: () => {} }, connected: true, topics: new Map(), key, lastError: null }
  ;(mqttPool as Map<string, unknown>).set(key, healthy)
  assert.equal(evictMqttPoolConn(cfg), false, '健康连接绝不驱逐')
  assert.equal((mqttPool as Map<string, unknown>).has(key), true, '健康条目保留')
  ;(mqttPool as Map<string, unknown>).delete(key)
})
