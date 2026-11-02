/**
 * R-1/R-2 生命周期增强回归(2026-11-01)
 *
 * R-1:AgentRuntime.stop() 不再同步等待宽限+dispose —— 调用方在墓碑动作
 *      (abort/mailbox close/广播)完成后立即返回,dispose 全程后台。
 *      用假 impl 计数 dispose 调用与时间,断言 stop() 先于 dispose 完成。
 * R-2:daqPushRearm —— driverConfig 变更后:退避清空 + 订阅回收 + 死连接驱逐;
 *      健康连接绝不驱逐;退避中的节点 PATCH 后下一拍即可重试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

test('R-1: stop() 立即返回,dispose 在后台完成(慢 dispose 不阻塞调用方)', async () => {
  let disposeStarted = 0
  let disposeFinished = 0
  const slowImpl = {
    async dispose() {
      disposeStarted++
      await new Promise(r => setTimeout(r, 400))
      disposeFinished++
    },
  }
  const rt = makeMinimalRuntime(slowImpl) as unknown as { stop(): Promise<void> }
  const t0 = Date.now()
  await rt.stop()
  const stopWall = Date.now() - t0
  // stop() 不再等待 400ms 的 dispose —— 远小于 dispose 耗时即证明后台化
  assert.ok(stopWall < 200, `stop() 应立即返回,实测 ${stopWall}ms`)
  assert.equal(disposeStarted, 0, 'stop() 返回时 dispose 尚未开始(已移交后台)')
  // 后台收尾最终完成
  await new Promise(r => setTimeout(r, 700))
  assert.equal(disposeFinished, 1, '后台 dispose 应完成一次')
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
