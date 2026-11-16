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
const { ManagerRuntimeWiring } = await import('../server/services/workshop/runtime/manager/runtime-wiring')
const { ManagerAdminChannel } = await import('../server/services/workshop/runtime/manager/admin-channel')
const { TaskEngineViews } = await import('../server/services/workshop/runtime/task-engine/views')
const { runtimeKey } = await import('../server/services/workshop/runtime/manager/helpers')
const { settleInvocationScope } = await import('../server/services/workshop/runtime/permission-scope')
const { dispatchHostTool, toolActivityAt, resetToolActivity } = await import('../server/services/workshop/agents/host-tool-bridge')

type RuntimeTestManager = {
  ensureAgentRuntime: (channelId: string, agentId: string) => never
  ensureChannelActive: (channelId: string) => void
  unloadChannelAgents: (channelId: string) => Promise<boolean>
  stopAndDetach: (channelId: string, agentId: string) => Promise<void>
  removeChannel: (channelId: string) => Promise<void>
  rescueStaleRoots: (channelId: string) => Promise<void>
  stoppingAgents: Set<string>
  channelUnloads: Map<string, Promise<boolean>>
  channelRemovals: Map<string, Promise<void>>
  channels: Map<string, unknown>
  agentIndex: Map<string, unknown>
}

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

test('channel teardown fences routing before scheduler or agents finish stopping', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => ({ enabled: 1 }) } as never,
  } as never)
  let finishScheduler!: () => void
  const schedulerGate = new Promise<void>((resolve) => {
    finishScheduler = resolve
  })
  let finishAgent!: () => void
  const agentGate = new Promise<void>((resolve) => {
    finishAgent = resolve
  })
  const agent = {
    agentId: 'ag-1', role: 'worker', channelId: 'ch-1', name: 'worker',
    enqueue: () => true, getState: () => 'idle', wakeMailbox() {}, injectSteer() {},
    stop: async () => { await agentGate },
  }
  cr.addAgent(agent as never)
  cr.scheduler = {
    start() {}, wake() {}, stop() {}, setLoopResubmitCallback() {},
    stopAndWait: async () => { await schedulerGate },
  }
  const manager = Object.create(ManagerRuntimeWiring.prototype) as RuntimeTestManager
  Object.assign(manager, {
    channelUnloads: new Map(), channelRemovals: new Map(), channelAgentStops: new Map(), stoppingAgents: new Set(),
    channels: new Map([['ch-1', cr]]), buses: new Map([['ch-1', {}]]),
    agentIndex: new Map([[runtimeKey('ch-1', 'ag-1'), agent]]),
    clearInvocationScope() {},
    deps: { repos: { channelAgents: { findByChannelAgent: () => { throw new Error('must not rewire') } } } },
  })
  cr.setLoader(id => manager.ensureAgentRuntime('ch-1', id))
  const stopping = manager.unloadChannelAgents('ch-1') as Promise<boolean>
  assert.equal(manager.unloadChannelAgents('ch-1'), stopping, 'concurrent unload shares ownership')
  assert.equal(manager.stoppingAgents.has(runtimeKey('ch-1', 'ag-1')), true)
  assert.deepEqual(cr.route(msg('ag-1')), [])
  assert.deepEqual(cr.route(msg('new-agent')), [])
  finishScheduler()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(cr.route(msg('ag-1')), [], 'old runtime stays detached while stop is pending')
  finishAgent()
  assert.equal(await stopping, true)
  assert.equal(manager.stoppingAgents.size, 0)
  assert.equal(manager.channelUnloads.size, 0)
  assert.equal(manager.channels.has('ch-1'), false)
})

test('channel removal stays fenced across an overlapping unload and cascades only after all stops', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: { findByChannelAgent: () => ({ enabled: 1 }) } as never,
  } as never)
  let finishScheduler!: () => void
  const schedulerGate = new Promise<void>((resolve) => {
    finishScheduler = resolve
  })
  let finishAgent!: () => void
  const agentGate = new Promise<void>((resolve) => {
    finishAgent = resolve
  })
  const events: string[] = []
  const agent = {
    agentId: 'ag-1', role: 'worker', channelId: 'ch-1', name: 'worker',
    enqueue: () => true, getState: () => 'idle', wakeMailbox() {}, injectSteer() {},
    stop: async () => {
      events.push('stop')
      await agentGate
      events.push('stopped')
    },
  }
  cr.addAgent(agent as never)
  cr.scheduler = {
    start() {}, wake() {}, stop() {}, setLoopResubmitCallback() {},
    stopAndWait: async () => { await schedulerGate },
  }
  let exists = true
  const manager = Object.create(ManagerAdminChannel.prototype) as RuntimeTestManager
  Object.assign(manager, {
    channelUnloads: new Map(), channelRemovals: new Map(), channelAgentStops: new Map(),
    stoppingAgents: new Set(), channels: new Map([['ch-1', cr]]),
    buses: new Map([['ch-1', {}]]), agentIndex: new Map([[runtimeKey('ch-1', 'ag-1'), agent]]),
    deferredChannelRecycles: new Map(), clearInvocationScope() {},
    deps: { repos: {
      channelAgents: { findByChannelAgent: () => ({ enabled: 1 }) },
      channels: { findById: () => exists ? { enabled: 1, leadAgentId: 'ag-1' } : undefined, remove: () => {
        events.push('channel')
        exists = false
      } },
      memories: { deleteByChannel: () => { events.push('memory') } },
      schedules: { removeByChannel: () => { events.push('schedules') } },
      users: { unmountChannelEverywhere: () => { events.push('mounts') } },
    } },
  })
  cr.setLoader(id => manager.ensureAgentRuntime('ch-1', id))
  const unloading = manager.unloadChannelAgents('ch-1') as Promise<boolean>
  const competingRewire = unloading.then(() => {
    manager.channels.set('ch-1', {})
    manager.ensureChannelActive('ch-1')
    assert.equal(manager.ensureAgentRuntime('ch-1', 'ag-1'), undefined)
  })
  const removing = manager.removeChannel('ch-1') as Promise<void>
  const secondRemoval = manager.removeChannel('ch-1') as Promise<void>
  assert.deepEqual(cr.route(msg('ag-1')), [])
  assert.deepEqual(cr.route(msg('new-agent')), [])
  finishScheduler()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['stop'])
  assert.deepEqual(cr.route(msg('ag-1')), [])
  finishAgent()
  await Promise.all([competingRewire, removing, secondRemoval])
  assert.deepEqual(events, ['stop', 'stopped', 'memory', 'schedules', 'mounts', 'channel'])
  assert.equal(manager.channels.has('ch-1'), false)
  assert.equal(manager.agentIndex.size, 0)
  assert.equal(manager.channelRemovals.size, 0)
  assert.equal(manager.ensureAgentRuntime('ch-1', 'ag-1'), undefined)
})

test('direct channel removal detaches all agents synchronously before stopping', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: {} as never,
  } as never)
  let finishAgent!: () => void
  const gate = new Promise<void>((resolve) => {
    finishAgent = resolve
  })
  const agent = {
    agentId: 'ag-1', role: 'worker', channelId: 'ch-1', name: 'worker',
    enqueue: () => true, getState: () => 'idle', wakeMailbox() {}, injectSteer() {},
    stop: async () => { await gate },
  }
  cr.addAgent(agent as never)
  const manager = Object.create(ManagerAdminChannel.prototype) as RuntimeTestManager
  Object.assign(manager, {
    channelUnloads: new Map(), channelRemovals: new Map(), channelAgentStops: new Map(),
    stoppingAgents: new Set(), channels: new Map([['ch-1', cr]]),
    buses: new Map([['ch-1', {}]]), agentIndex: new Map([[runtimeKey('ch-1', 'ag-1'), agent]]),
    deferredChannelRecycles: new Map(), clearInvocationScope() {},
    deps: { repos: { memories: { deleteByChannel() {} }, channels: { remove() {} } } },
  })
  cr.setLoader(id => manager.ensureAgentRuntime('ch-1', id))
  const removing = manager.removeChannel('ch-1') as Promise<void>
  assert.deepEqual(cr.route(msg('ag-1')), [])
  assert.deepEqual(cr.route(msg('new-agent')), [])
  finishAgent()
  await removing
})

test('failed channel removal keeps database rows and can be retried', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: {} as never,
  } as never)
  let attempts = 0
  const agent = {
    agentId: 'ag-1', role: 'worker', channelId: 'ch-1', name: 'worker',
    stop: async () => {
      attempts++
      if (attempts === 1) throw new Error('stop failed')
    },
  }
  cr.addAgent(agent as never)
  const events: string[] = []
  const manager = Object.create(ManagerAdminChannel.prototype) as RuntimeTestManager
  Object.assign(manager, {
    channelUnloads: new Map(), channelRemovals: new Map(), channelAgentStops: new Map(),
    stoppingAgents: new Set(), channels: new Map([['ch-1', cr]]),
    buses: new Map([['ch-1', {}]]), agentIndex: new Map([[runtimeKey('ch-1', 'ag-1'), agent]]),
    deferredChannelRecycles: new Map(), clearInvocationScope() {},
    deps: { repos: {
      memories: { deleteByChannel: () => { events.push('memory') } },
      channels: { remove: () => { events.push('channel') } },
    } },
  })
  await assert.rejects(manager.removeChannel('ch-1'), /stop failed/)
  assert.deepEqual(events, [])
  assert.equal(manager.channelRemovals.size, 0)
  assert.equal(cr.getAgents().length, 1)
  await manager.removeChannel('ch-1')
  assert.deepEqual(events, ['memory', 'channel'])
  assert.equal(attempts, 2)
})

test('channel removal waits for an already detached agent stop', async () => {
  const cr = new ChannelRuntime('ch-1', {
    taskEngine: { get: () => undefined } as never,
    subscriptionRepo: {} as never,
    channelAgents: {} as never,
  } as never)
  let finishAgent!: () => void
  const agentGate = new Promise<void>((resolve) => {
    finishAgent = resolve
  })
  const events: string[] = []
  const agent = {
    agentId: 'ag-1', role: 'worker', channelId: 'ch-1', name: 'worker',
    stop: async () => {
      events.push('stop')
      await agentGate
      events.push('stopped')
    },
  }
  cr.addAgent(agent as never)
  const manager = Object.create(ManagerAdminChannel.prototype) as RuntimeTestManager
  Object.assign(manager, {
    channelUnloads: new Map(), channelRemovals: new Map(), channelAgentStops: new Map(),
    stoppingAgents: new Set(), channels: new Map([['ch-1', cr]]),
    buses: new Map([['ch-1', {}]]), agentIndex: new Map([[runtimeKey('ch-1', 'ag-1'), agent]]),
    deferredChannelRecycles: new Map(), clearInvocationScope() {},
    deps: { repos: {
      memories: { deleteByChannel: () => { events.push('memory') } },
      channels: { remove: () => { events.push('channel') } },
    } },
  })
  const stopping = manager.stopAndDetach('ch-1', 'ag-1') as Promise<void>
  const removing = manager.removeChannel('ch-1') as Promise<void>
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['stop'], 'database cleanup must wait for the detached runtime')
  finishAgent()
  await Promise.all([stopping, removing])
  assert.deepEqual(events, ['stop', 'stopped', 'memory', 'channel'])
})

test('rescue assignment uses the freshly reread execution fence', async () => {
  const old = {
    id: 'root-1', channelId: 'ch-1', assigneeId: 'lead-1', state: 'SUBMITTED',
    createdAt: new Date(Date.now() - 600_000).toISOString(), title: 'root',
    assignmentGeneration: 1, executionLeaseId: 'old-lease',
  }
  const fresh = { ...old, assignmentGeneration: 2, executionLeaseId: 'new-lease' }
  let delivered: { metadata: Record<string, unknown> } | undefined
  const manager = Object.create(ManagerRuntimeWiring.prototype) as RuntimeTestManager
  Object.assign(manager, {
    rescueSeen: new Map(),
    deps: { repos: {
      channels: { list: () => [{ id: 'ch-1', enabled: 1, leadAgentId: 'lead-1' }] },
      tasks: { listRoots: () => [old], findById: () => fresh },
    } },
    getTaskEngine: () => ({ list: () => [], refreshDeadline() {}, isLegacyRecoveryBlocked: () => false }),
    runtimeOf: () => undefined,
    ensureChannelActive() {},
    route: (_id: string, message: { metadata: Record<string, unknown> }) => {
      delivered = message
      return ['lead-1']
    },
  })
  await manager.rescueStaleRoots('ch-1')
  assert.ok(delivered)
  assert.equal(delivered.metadata['x-aw-assignment-generation'], 2)
  assert.equal(delivered.metadata['x-aw-execution-lease-id'], 'new-lease')
})

test('rescue respects terminal FIFO holds and independent earlier roots', async () => {
  for (const blocked of [true, false]) {
    const head = {
      id: 'candidate', channelId: 'ch-1', assigneeId: 'lead-1', state: 'SUBMITTED',
      createdAt: '2020-01-01T00:00:00Z', title: 'root', rootQueueSeq: blocked ? 2 : 1,
      assignmentGeneration: 1, executionLeaseId: 'lease', closeReason: null, parentId: null,
    }
    const held = { ...head, id: 'held', state: 'FAILED', rootQueueSeq: blocked ? 1 : 2, closeReason: '[LEGACY_EXECUTION_RECOVERY_REQUIRED]' }
    const tasks = [held, head]
    const view = Object.create(TaskEngineViews.prototype) as InstanceType<typeof TaskEngineViews>
    Object.assign(view, { repos: { tasks: { findById: (id: string) => tasks.find(t => t.id === id), listByChannelMeta: () => tasks } } })
    const events: string[] = []
    const manager = Object.create(ManagerRuntimeWiring.prototype) as RuntimeTestManager
    Object.assign(manager, {
      rescueSeen: new Map(),
      deps: { repos: {
        channels: { list: () => [{ id: 'ch-1', enabled: 1, leadAgentId: 'lead-1' }] },
        tasks: { listRoots: () => tasks, findById: () => head },
      } },
      getTaskEngine: () => ({
        isLegacyRecoveryBlocked: (id: string) => view.isLegacyRecoveryBlocked(id),
        list: () => [], refreshDeadline: () => { events.push('deadline') },
      }),
      runtimeOf: () => undefined,
      ensureChannelActive: () => { events.push('activate') },
      route: () => {
        events.push('route')
        return ['lead-1']
      },
    })
    await manager.rescueStaleRoots('ch-1')
    assert.deepEqual(events, blocked ? [] : ['activate', 'deadline', 'route'])
  }
})

test('rescue rechecks recovery holds after stopping a lead', async () => {
  const head = {
    id: 'candidate', channelId: 'ch-1', assigneeId: 'lead-1', state: 'SUBMITTED',
    createdAt: '2020-01-01T00:00:00Z', title: 'root', closeReason: null,
  }
  let blocked = false
  const events: string[] = []
  const manager = Object.create(ManagerRuntimeWiring.prototype) as RuntimeTestManager
  Object.assign(manager, {
    rescueSeen: new Map(),
    deps: { repos: {
      channels: { list: () => [{ id: 'ch-1', enabled: 1, leadAgentId: 'lead-1' }] },
      tasks: { listRoots: () => [head], findById: () => head },
    } },
    getTaskEngine: () => ({
      isLegacyRecoveryBlocked: () => blocked,
      list: () => [], refreshDeadline: () => { events.push('deadline') },
    }),
    runtimeOf: () => ({ getState: () => 'idle' }),
    stopAndDetach: async () => { blocked = true },
    ensureChannelActive: () => { events.push('activate') },
    route: () => {
      events.push('route')
      return ['lead-1']
    },
  })
  await manager.rescueStaleRoots('ch-1')
  assert.deepEqual(events, [])
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
