import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import { SchedulerLoopSnapshot } from '../server/services/workshop/runtime/scheduler-loop/snapshot'
import type { AgentInfo, AgentInterface, SupervisionSnapshot } from '../server/services/workshop/agents/agent-interface'
import type { SchedulerDecision } from '../server/services/workshop/runtime/scheduler-loop/types'

function gate<T = void>() {
  return Promise.withResolvers<T>()
}

const makeRoot = () => ({
  id: 'root', channelId: 'channel', title: 'Root', parentId: null, assigneeId: 'lead', state: 'WAITING',
  assignmentGeneration: 1, executionLeaseId: 'lease-1', executionLeaseAgentId: 'lead', executionLeaseRevokedAt: undefined as string | undefined,
})

const makeSnapshot = (): SupervisionSnapshot => ({
  tick: 1,
  now: Date.now(),
  activeRootId: 'root',
  queuedRootIds: [],
  tasks: [
    makeRoot(),
    { id: 'child', title: 'Child', parentId: 'root', assigneeId: 'worker', state: 'FAILED', retryCount: 0 },
  ],
  members: [{ agentId: 'worker', name: 'Worker', role: 'worker', state: 'idle', queued: 0 }],
  pendingChildren: {},
  mail: [],
} as never)

class TestScheduler extends SchedulerLoopSnapshot {
  recoveryCalls = 0
  executed: SchedulerDecision[] = []
  onExecute?: (decision: SchedulerDecision) => void
  readonly snapshot = makeSnapshot()

  constructor(lead: AgentRuntime) {
    super({ channelId: 'channel' } as never, lead, { tickMs: 60_000 })
  }

  begin(): void {
    this.start()
    this.wake()
  }

  async waitForRound(): Promise<void> {
    await this.activeRound
  }

  protected collectSnapshot(): SupervisionSnapshot { return this.snapshot }
  protected checkLoopCompletion(): void {}
  protected execute(decision: SchedulerDecision): void {
    this.executed.push(decision)
    this.onExecute?.(decision)
  }

  protected pickWorker(): undefined { return undefined }
  protected refreshIdle(): void {}
  protected ruleEngine(): SchedulerDecision[] {
    this.recoveryCalls++
    return [{ kind: 'reassign', taskId: 'child', toAgentId: 'worker' }]
  }
}

class TestRuntime extends AgentRuntime {
  readonly states: string[] = []
  override refreshStatus(): void { this.states.push(this.getState()) }
  protected override queueContext(): never { return {} as never }
}

function fixture() {
  const recallStarted = gate()
  const recall = gate<string | undefined>()
  const root = makeRoot()
  let harnessCalls = 0
  const runtime = new TestRuntime(
    { id: 'lead', channelId: 'channel', name: 'Lead', role: 'lead', harness: 'mock' } as AgentInfo,
    { async supervise() {
      harnessCalls++
      return []
    } } as unknown as AgentInterface,
    {
      mailbox: { close() {} } as never,
      taskEngine: { get: (id: string) => id === root.id ? root : undefined } as never,
      bus: { notifyAgent() {} } as never,
      workspace: {} as never,
      memory: { recall: () => {
        recallStarted.resolve()
        return recall.promise
      } } as never,
    },
  )
  const scheduler = new TestScheduler(runtime)
  return {
    runtime, scheduler, root, recall, recallStarted,
    get harnessCalls() { return harnessCalls },
  }
}

test('scheduler stop during recall returns without recovery or a stuck busy lead', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    f.scheduler.begin()
    await f.recallStarted.promise
    assert.equal(f.runtime.getState(), 'busy')
    assert.equal(f.runtime.getSupervisionStatus().activeRootId, 'root')
    await f.scheduler.stopAndWait()
    assert.equal(f.runtime.getState(), 'idle')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
    assert.equal(f.harnessCalls, 0)
    assert.equal(f.scheduler.recoveryCalls, 0)
    assert.deepEqual(f.scheduler.executed, [])
    f.recall.resolve('late memory')
    await Promise.resolve()
    assert.equal(f.harnessCalls, 0)
  }
  finally {
    f.recall.resolve(undefined)
    f.scheduler.stop()
  }
})

test('root cancellation during recall aborts the attempt without stale recovery', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    f.scheduler.begin()
    await f.recallStarted.promise
    assert.equal(f.runtime.abortTask('other-root'), false)
    f.root.state = 'CANCELED'
    assert.equal(f.runtime.abortTask('root'), true)
    await f.scheduler.waitForRound()
    assert.equal(f.runtime.getState(), 'idle')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
    assert.equal(f.harnessCalls, 0)
    assert.equal(f.scheduler.recoveryCalls, 0)
    assert.deepEqual(f.scheduler.executed, [])
    f.recall.resolve('late memory')
    await Promise.resolve()
    assert.equal(f.harnessCalls, 0)
  }
  finally {
    f.recall.resolve(undefined)
    f.scheduler.stop()
  }
})

test('lead runtime stop during recall prevents scheduler recovery and preserves stopped state', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    f.scheduler.begin()
    await f.recallStarted.promise
    await f.runtime.stop()
    await f.scheduler.waitForRound()
    assert.equal(f.runtime.getState(), 'stopped')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
    assert.equal(f.harnessCalls, 0)
    assert.equal(f.scheduler.recoveryCalls, 0)
    assert.deepEqual(f.scheduler.executed, [])
  }
  finally {
    f.recall.resolve(undefined)
    f.scheduler.stop()
  }
})

for (const outcome of ['null', 'error', 'decisions'] as const) {
  test(`stop and restart discard late supervision ${outcome}`, { timeout: 5000 }, async () => {
    const entered = gate()
    const result = gate<SchedulerDecision[] | null>()
    const root = makeRoot()
    const lead = {
      agentId: 'lead',
      taskEngine: { get: () => root },
      getState: () => 'idle',
      withExecLock: (fn: () => Promise<void>) => fn(),
      supervise: () => {
        entered.resolve()
        return result.promise
      },
    } as unknown as AgentRuntime
    const scheduler = new TestScheduler(lead)
    try {
      scheduler.begin()
      await entered.promise
      const round = scheduler.waitForRound()
      scheduler.stop()
      scheduler.start()
      if (outcome === 'error') result.reject(new Error('late failure'))
      else result.resolve(outcome === 'null' ? null : [{ kind: 'cancel', taskId: 'root' }])
      await round
      assert.equal(scheduler.recoveryCalls, 0)
      assert.deepEqual(scheduler.executed, [])
    }
    finally { scheduler.stop() }
  })
}

test('stop while waiting for the execution lock prevents a late round', { timeout: 5000 }, async () => {
  const lockEntered = gate()
  const releaseLock = gate()
  let supervisionCalls = 0
  const lead = {
    agentId: 'lead',
    taskEngine: { get: () => makeRoot() },
    getState: () => 'idle',
    withExecLock: async (fn: () => Promise<void>) => {
      lockEntered.resolve()
      await releaseLock.promise
      await fn()
    },
    supervise: async () => {
      supervisionCalls++
      return []
    },
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  try {
    scheduler.begin()
    await lockEntered.promise
    const round = scheduler.waitForRound()
    scheduler.stop()
    scheduler.start()
    releaseLock.resolve()
    await round
    assert.equal(supervisionCalls, 0)
    assert.equal(scheduler.recoveryCalls, 0)
    assert.deepEqual(scheduler.executed, [])
  }
  finally {
    releaseLock.resolve()
    scheduler.stop()
  }
})

test('a restarted scheduler can supervise the same snapshot after an interrupted round', { timeout: 5000 }, async () => {
  const entered = gate()
  const firstResult = gate<SchedulerDecision[] | null>()
  let calls = 0
  const lead = {
    agentId: 'lead',
    taskEngine: { get: () => makeRoot() },
    getState: () => 'idle',
    withExecLock: (fn: () => Promise<void>) => fn(),
    supervise: () => {
      calls++
      entered.resolve()
      return calls === 1 ? firstResult.promise : Promise.resolve([])
    },
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  try {
    scheduler.begin()
    await entered.promise
    const firstRound = scheduler.waitForRound()
    scheduler.stop()
    firstResult.resolve(null)
    await firstRound
    scheduler.begin()
    await scheduler.waitForRound()
    assert.equal(calls, 2)
    assert.equal(scheduler.recoveryCalls, 1)
  }
  finally { scheduler.stop() }
})

for (const outcome of ['null', 'empty', 'error', 'decisions'] as const) {
  for (const changed of ['generation', 'lease', 'assignee', 'lease owner', 'revocation', 'channel'] as const) {
    test(`deferred ${outcome} is discarded after root ${changed} changes`, { timeout: 5000 }, async () => {
      const entered = gate()
      const result = gate<SchedulerDecision[] | null>()
      const root = makeRoot()
      const lead = {
        agentId: 'lead', taskEngine: { get: () => root }, getState: () => 'idle',
        withExecLock: (fn: () => Promise<void>) => fn(),
        supervise: () => {
          entered.resolve()
          return result.promise
        },
      } as unknown as AgentRuntime
      const scheduler = new TestScheduler(lead)
      try {
        scheduler.begin()
        await entered.promise
        const round = scheduler.waitForRound()
        if (changed === 'generation') root.assignmentGeneration++
        else if (changed === 'lease') root.executionLeaseId = 'lease-2'
        else if (changed === 'assignee') root.assigneeId = 'other'
        else if (changed === 'lease owner') root.executionLeaseAgentId = 'other'
        else if (changed === 'revocation') root.executionLeaseRevokedAt = '2026-01-01'
        else root.channelId = 'other'
        if (outcome === 'error') result.reject(new Error('late error'))
        else result.resolve(outcome === 'null' ? null : outcome === 'empty' ? [] : [{ kind: 'cancel', taskId: 'child' }])
        await round
        assert.equal(scheduler.recoveryCalls, 0)
        assert.deepEqual(scheduler.executed, [])
      }
      finally { scheduler.stop() }
    })
  }
}

test('same-agent reassignment during first decision fences later decisions', { timeout: 5000 }, async () => {
  const root = makeRoot()
  const lead = {
    agentId: 'lead', taskEngine: { get: () => root }, getState: () => 'idle',
    withExecLock: (fn: () => Promise<void>) => fn(),
    supervise: async () => [{ kind: 'cancel', taskId: 'child' }, { kind: 'cancel', taskId: 'root' }],
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  scheduler.onExecute = () => {
    root.assignmentGeneration++
    root.executionLeaseId = 'lease-2'
  }
  try {
    scheduler.begin()
    await scheduler.waitForRound()
    assert.deepEqual(scheduler.executed, [{ kind: 'cancel', taskId: 'child' }])
  }
  finally { scheduler.stop() }
})

for (const outcome of ['null', 'empty', 'error', 'decisions'] as const) {
  test(`aborted supervision ${outcome} does not run recovery or decisions`, { timeout: 5000 }, async () => {
    const entered = gate()
    const result = gate<SchedulerDecision[] | null>()
    const root = makeRoot()
    let status = { attemptId: 'previous', lastDecisionKind: 'none' }
    const lead = {
      agentId: 'lead', taskEngine: { get: () => root }, getState: () => 'idle',
      getSupervisionStatus: () => status,
      withExecLock: (fn: () => Promise<void>) => fn(),
      supervise: () => {
        entered.resolve()
        return result.promise
      },
    } as unknown as AgentRuntime
    const scheduler = new TestScheduler(lead)
    try {
      scheduler.begin()
      await entered.promise
      const round = scheduler.waitForRound()
      status = { attemptId: 'new', lastDecisionKind: 'aborted' }
      if (outcome === 'error') result.reject(new Error('aborted'))
      else result.resolve(outcome === 'null' ? null : outcome === 'empty' ? [] : [{ kind: 'cancel', taskId: 'child' }])
      await round
      assert.equal(scheduler.recoveryCalls, 0)
      assert.deepEqual(scheduler.executed, [])
    }
    finally { scheduler.stop() }
  })
}

test('real runtime abort with an unchanged root does not trigger scheduler fallback', { timeout: 5000 }, async () => {
  const entered = gate()
  const finish = gate<undefined>()
  const root = makeRoot()
  const runtime = new TestRuntime(
    { id: 'lead', channelId: 'channel', name: 'Lead', role: 'lead', harness: 'mock' } as AgentInfo,
    { async supervise() {
      entered.resolve()
      await finish.promise
      return []
    } } as unknown as AgentInterface,
    { mailbox: {} as never, taskEngine: { get: () => root } as never, bus: {} as never, workspace: {} as never },
  )
  const scheduler = new TestScheduler(runtime)
  try {
    scheduler.begin()
    await entered.promise
    const round = scheduler.waitForRound()
    assert.equal(runtime.abortTask('root'), true)
    finish.resolve(undefined)
    await round
    assert.equal(runtime.getSupervisionStatus().lastDecisionKind, 'aborted')
    assert.equal(scheduler.recoveryCalls, 0)
    assert.deepEqual(scheduler.executed, [])
    assert.equal(runtime.getState(), 'idle')
  }
  finally {
    finish.resolve(undefined)
    scheduler.stop()
  }
})

test('same-agent lease replacement triggers supervision on the next unchanged task state', { timeout: 5000 }, async () => {
  const root = makeRoot()
  let calls = 0
  const lead = {
    agentId: 'lead', taskEngine: { get: () => root }, getState: () => 'idle',
    withExecLock: (fn: () => Promise<void>) => fn(),
    supervise: async () => {
      calls++
      return [{ kind: 'wait', rootId: 'root' }]
    },
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  try {
    scheduler.begin()
    await scheduler.waitForRound()
    root.assignmentGeneration++
    root.executionLeaseId = 'lease-2'
    Object.assign(scheduler.snapshot.tasks[0]!, root)
    scheduler.wake()
    await scheduler.waitForRound()
    assert.equal(calls, 2)
    assert.equal(scheduler.executed.length, 2)
  }
  finally { scheduler.stop() }
})

test('genuine supervision error still runs recovery with a valid root', { timeout: 5000 }, async () => {
  const root = makeRoot()
  const lead = {
    agentId: 'lead', taskEngine: { get: () => root }, getState: () => 'idle',
    withExecLock: (fn: () => Promise<void>) => fn(),
    supervise: async () => { throw new Error('harness failure') },
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  try {
    scheduler.begin()
    await scheduler.waitForRound()
    assert.equal(scheduler.recoveryCalls, 1)
    assert.deepEqual(scheduler.executed, [{ kind: 'reassign', taskId: 'child', toAgentId: 'worker' }])
  }
  finally { scheduler.stop() }
})

test('ordinary empty supervision still runs recovery while active', { timeout: 5000 }, async () => {
  const entered = gate()
  const lead = {
    agentId: 'lead',
    taskEngine: { get: () => makeRoot() },
    getState: () => 'idle',
    withExecLock: (fn: () => Promise<void>) => fn(),
    supervise: async () => {
      entered.resolve()
      return []
    },
  } as unknown as AgentRuntime
  const scheduler = new TestScheduler(lead)
  try {
    scheduler.begin()
    await entered.promise
    await scheduler.waitForRound()
    assert.equal(scheduler.recoveryCalls, 1)
    assert.equal(scheduler.executed.length, 1)
  }
  finally { scheduler.stop() }
})
