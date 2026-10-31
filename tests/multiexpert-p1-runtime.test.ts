/**
 * 2026-10-28 多专家审查整改 · 运行时域 P1:
 *  C-P1-1 停机窗口不假送达(Mailbox 闭箱返回 false + route 不计入 delivered);
 *  C-P1-2 人类调用作用域收口(失败路径/精确匹配/无条件清除);
 *  C-P1-3 工具活性信号覆盖全引擎(统一分发入口打点)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mx-runtime-'))
delete process.env.AW_BENCH_MODE

const { Mailbox } = await import('../server/services/workshop/runtime/mailbox')
const { ChannelRuntime } = await import('../server/services/workshop/runtime/channel-runtime')
const { settleInvocationScope } = await import('../server/services/workshop/runtime/permission-scope')
const { dispatchHostTool, toolActivityAt, resetToolActivity } = await import('../server/services/workshop/agents/host-tool-bridge')

function msg(target: string, id = 'm-1') {
  return {
    messageId: id,
    contextId: 'ch-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello' }],
    metadata: { 'x-aw-target-agent': target, 'x-aw-from-label': 'tester' },
  } as never
}

test('C-P1-1:信箱关闭后 enqueue 返回 false(消息未落库,调用方可如实报未送达)', () => {
  const created: string[] = []
  const repo = {
    create: (row: { id: string }) => { created.push(row.id) },
  } as never
  const box = new Mailbox(repo, 'ch-1', 'ag-1', () => {})
  assert.equal(box.enqueue(msg('ag-1', 'm-ok')), true)
  assert.deepEqual(created, ['m-ok'])
  box.close()
  assert.equal(box.enqueue(msg('ag-1', 'm-dropped')), false, '闭箱必须如实返回 false')
  assert.deepEqual(created, ['m-ok'], '闭箱后不得落库(否则就是假送达 + 永久丢失)')
})

test('C-P1-1:停机窗口 route 不把闭箱成员计入 delivered', () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => ({ id: 'ag-1', enabled: 1 }) } as never,
  } as never, () => {})
  let accepting = false
  cr.addAgent({
    agentId: 'ag-1',
    role: 'worker',
    channelId: 'ch-1',
    name: 'w',
    enqueue: () => accepting,
    getState: () => 'idle',
    wakeMailbox: () => {},
    injectSteer: async () => 'deferred',
  } as never)
  assert.deepEqual(cr.route(msg('ag-1')), [], '闭箱成员不得报告送达')
  accepting = true
  assert.deepEqual(cr.route(msg('ag-1', 'm-2')), ['ag-1'])
})

test('lead scheduler shutdown waits for every loop even if the channel pointer was overwritten', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => undefined } as never,
  } as never, () => {})
  const stopped: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const loop = (name: string, hold = false) => ({
    start() {},
    wake() {},
    stop() {},
    async stopAndWait() {
      stopped.push(name)
      if (hold) await firstGate
    },
    setLoopResubmitCallback() {},
  })

  const first = loop('orphan', true)
  const visible = loop('visible')
  cr.scheduler = first
  cr.scheduler = visible
  assert.equal(cr.scheduler, visible)

  // Simulate a lost public pointer after replacement; registry fallback still finds an orphan loop.
  ;(cr as unknown as { schedulerLoop: typeof first | null }).schedulerLoop = null
  assert.equal(cr.scheduler, first)
  const stopping = cr.stopSchedulersAndWait()
  assert.equal(cr.schedulerStoppingInProgress, true)
  await Promise.resolve()
  assert.deepEqual(stopped.sort(), ['orphan', 'visible'])

  releaseFirst()
  const releaseStarts = await stopping
  assert.equal(cr.scheduler, null)
  assert.equal(cr.schedulerStoppingInProgress, true, 'replacement stays gated until owner teardown finishes')
  releaseStarts()
  assert.equal(cr.schedulerStoppingInProgress, false)

  const restarted = loop('restarted')
  cr.scheduler = restarted
  assert.equal(cr.scheduler, restarted, 'a fully stopped ChannelRuntime accepts a fresh scheduler')
  await restarted.stopAndWait()
  cr.scheduler = null
  assert.equal(cr.scheduler, null, 'clearing an already-stopped loop removes its registry entry')
  const afterClear = loop('after-clear')
  cr.scheduler = afterClear
  assert.equal(cr.scheduler, afterClear, 'a cleared ChannelRuntime accepts another fresh scheduler')
  const releaseAfterClear = await cr.stopSchedulersAndWait()
  releaseAfterClear()
  assert.deepEqual(stopped.sort(), ['after-clear', 'orphan', 'restarted', 'visible'])
})

test('overlapping scheduler teardowns keep starts gated until the final owner releases', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => undefined } as never,
  } as never, () => {})

  const [releaseFirst, releaseSecond] = await Promise.all([
    cr.stopSchedulersAndWait(),
    cr.stopSchedulersAndWait(),
  ])
  assert.equal(cr.schedulerStoppingInProgress, true)

  releaseFirst()
  assert.equal(cr.schedulerStoppingInProgress, true, 'one teardown cannot reopen another teardown\'s gate')

  releaseSecond()
  assert.equal(cr.schedulerStoppingInProgress, false, 'the final teardown owner reopens scheduler starts')

  const restarted = {
    start() {},
    wake() {},
    stop() {},
    async stopAndWait() {},
    setLoopResubmitCallback() {},
  }
  cr.scheduler = restarted
  assert.equal(cr.scheduler, restarted, 'scheduler restart is allowed after all teardown leases release')
  const releaseRestarted = await cr.stopSchedulersAndWait()
  releaseRestarted()
})

test('a rejected scheduler stop stays fail-closed until a successful retry and lease release', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => undefined } as never,
  } as never, () => {})
  let stopAttempts = 0
  cr.scheduler = {
    start() {},
    wake() {},
    stop() {},
    async stopAndWait() {
      stopAttempts += 1
      if (stopAttempts === 1) throw new Error('transient stop failure')
    },
    setLoopResubmitCallback() {},
  }

  const failedAttempts = await Promise.allSettled([
    cr.stopSchedulersAndWait(),
    cr.stopSchedulersAndWait(),
  ])
  assert.equal(stopAttempts, 1, 'concurrent callers share one stop barrier')
  assert.deepEqual(failedAttempts.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(cr.schedulerStoppingInProgress, true, 'a rejected stop leaves a stale fail-closed hold')

  const releaseRetry = await cr.stopSchedulersAndWait()
  assert.equal(stopAttempts, 2, 'a later barrier retries the still-tracked loop')
  assert.equal(cr.scheduler, null)
  assert.equal(cr.schedulerStoppingInProgress, true, 'successful retry clears stale failure but retains its active lease')

  releaseRetry()
  assert.equal(cr.schedulerStoppingInProgress, false, 'the final active lease release reopens starts')
})

test('C-P1-2:作用域收口 —— 同调用清除/不同调用保留/无 id 无条件清除', () => {
  const map = new Map<string, { invocationId?: string | null }>()
  map.set('ag-1', { invocationId: 'd-1' })
  assert.equal(settleInvocationScope(map, 'ag-1', 'd-2'), false, '别的调用的收口不得误删本次作用域')
  assert.equal(map.has('ag-1'), true)
  assert.equal(settleInvocationScope(map, 'ag-1', 'd-1'), true)
  assert.equal(map.has('ag-1'), false)

  map.set('ag-2', { invocationId: 'd-9' })
  assert.equal(settleInvocationScope(map, 'ag-2', null), true, '失败路径(无 deliveryId)必须能兜底清除')
  assert.equal(map.has('ag-2'), false)
  assert.equal(settleInvocationScope(map, 'nobody'), false, '无作用域时安全返回')
})

test('C-P1-3:仅走统一分发入口(omp 原生路径同源)也刷新工具活性', async () => {
  resetToolActivity()
  assert.equal(toolActivityAt('ag-omp'), null)
  const before = Date.now()
  // 未知工具会在内部分发里失败 —— 活性打点必须先于一切校验,失败调用同样证明 agent 在推进
  await dispatchHostTool({
    identity: { agentId: 'ag-omp', channelId: 'ch-1', role: 'worker', name: 'w' },
    state: { lastPollAt: 0, replyContext: null } as never,
    getWorkspace: () => null,
  }, { toolName: 'definitely-unknown-tool', arguments: {} }).catch(() => undefined)
  const at = toolActivityAt('ag-omp')
  assert.ok(at != null && at >= before, 'omp 原生/pi/MCP 共用的分发入口必须打点')
  assert.equal(toolActivityAt('ag-other'), null, '打点必须按 agent 隔离')
})
