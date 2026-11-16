import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentInfo, AgentInterface, AgentRunContext } from '../server/services/workshop/agents/agent-interface'
import type { A2AMessage } from '../server/services/workshop/types/a2a'
import type { ExecutionFence } from '../server/services/workshop/runtime/task-engine/lease'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-runtime-interruption-'))

const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createMessageRepo, isRecoveryBlockedMessage } = await import('../server/services/workshop/db/message.repo')
const { Mailbox } = await import('../server/services/workshop/runtime/mailbox')
const { LEGACY_RECOVERY_MARKER } = await import('../server/services/workshop/runtime/task-engine/legacy-recovery')
const { AgentRuntime } = await import('../server/services/workshop/runtime/agent-runtime/facade')
const { fenceMatches, fenceToMetadata, issueLeaseFields } = await import('../server/services/workshop/runtime/task-engine/lease')

function gate<T = void>() {
  return Promise.withResolvers<T>()
}

class ObservedRuntime extends AgentRuntime {
  readonly processed = gate<undefined>()
  readonly leaveProcessing = gate<undefined>()

  protected async processMessage(message: A2AMessage, claimToken: string): Promise<void> {
    try {
      await super.processMessage(message, claimToken)
    }
    finally {
      this.processed.resolve(undefined)
      await this.leaveProcessing.promise
    }
  }

  async fireWatchdog(messageId: string): Promise<void> {
    let fired = false
    await (this as unknown as { messageWatchdogTick: (message: { messageId: string }, watchdog: unknown) => Promise<void> })
      .messageWatchdogTick({ messageId }, {
        stallMs: 1, getLast: () => 0, bump() {},
        isFired: () => fired, markFired: () => { fired = true }, stop() {},
      })
    assert.equal(fired, true, 'watchdog must actually fire')
  }
}

const statusEvent: AgentEvent = {
  kind: 'status',
  status: {
    state: 'WORKING', timestamp: '2026-01-01T00:00:00.000Z',
    message: { messageId: 'status', contextId: 'ch', role: 'ROLE_AGENT', parts: [{ text: 'Partial status output from the worker.' }] },
  },
}
const artifactEvent: AgentEvent = {
  kind: 'artifact',
  artifact: { artifactId: 'artifact', name: 'output', parts: [{ text: 'Partial artifact output from the worker.' }] },
  lastChunk: true, totalChunks: 1,
}
const lateError: AgentEvent = { kind: 'error', error: { code: 'LATE_ERROR', message: 'error after abort' } }

function fixture(options: { initialState?: string, event?: AgentEvent, transitionGate?: Promise<void>, recallGate?: Promise<void>, lateError?: boolean, peer?: boolean, preflightError?: boolean, settlementError?: boolean, steerGate?: Promise<'steer' | 'deferred'>, recoveryHold?: boolean, invalidFence?: 'missing' | 'generation-only' | 'lease-only' | 'generation-mismatch' | 'lease-mismatch' | 'revoked' } = {}) {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const repo = createMessageRepo(db)
  // Mirrors runtime-wiring.ts: the blocked predicate reads the live tasks table,
  // so a hold that lands mid-run is picked up dynamically.
  const recoveryBlocked = options.recoveryHold
    ? (row: { taskId: string | null, metadataJson: string }) => isRecoveryBlockedMessage(row, (id) => {
        const held = db.prepare('SELECT close_reason FROM tasks WHERE id = ?').get(id) as { close_reason: string | null } | undefined
        return !!held && (held.close_reason ?? '').includes(LEGACY_RECOVERY_MARKER)
      })
    : undefined
  if (options.recoveryHold) {
    db.prepare(`INSERT INTO tasks (id, channel_id, assignee_id, title, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('task', 'ch', 'worker', 'Test', 'WORKING', new Date().toISOString(), new Date().toISOString())
  }
  const mailbox = new Mailbox(repo, 'ch', 'worker', () => {}, recoveryBlocked)
  const holdTask = (id: string) => {
    db.prepare(`UPDATE tasks SET close_reason = CASE
      WHEN COALESCE(close_reason, '') = '' THEN ? ELSE close_reason || ' ' || ? END WHERE id = ?`)
      .run(LEGACY_RECOVERY_MARKER, LEGACY_RECOVERY_MARKER, id)
  }
  const runStarted = gate<AgentRunContext>()
  const outputApplied = gate<undefined>()
  const transitionStarted = gate<undefined>()
  const recallStarted = gate<undefined>()
  const finishRun = gate<undefined>()
  const task = { id: 'task', channelId: 'ch', title: 'Test', state: options.initialState ?? 'WORKING', assigneeId: 'worker', parentId: 'parent', createdAt: new Date().toISOString(), ...issueLeaseFields(1, 'worker'), artifacts: [] as Array<{ name?: string, parts: Array<{ text: string }> }> }
  if (options.invalidFence === 'revoked') {
    Object.assign(task, { executionLeaseRevokedAt: new Date().toISOString() })
  }
  const transitions: string[] = []
  const applied: AgentEvent[] = []
  const emitted: AgentEvent[] = []
  const replies: unknown[] = []
  const harvested: unknown[] = []
  let runs = 0
  let completions = 0
  let driverCalls = 0
  let failSettlement = false
  const engine = {
    get: (id: string) => {
      if (options.preflightError || failSettlement) throw new Error('preflight or settlement failed')
      return id === task.id ? task : undefined
    },
    assertAssignmentFence: (id: string, fence?: ExecutionFence) => id === task.id && fenceMatches(task, fence),
    list: () => [task],
    queueViewOf: () => ({ current: task, queued: [], completed: [] }),
    async transition(_id: string, state: string) {
      transitions.push(state)
      if (state === 'WORKING' && options.transitionGate) {
        transitionStarted.resolve(undefined)
        await options.transitionGate
      }
      if (task.state !== 'CANCELED') task.state = state
      return task
    },
    applyEvent(_id: string, event: AgentEvent) {
      applied.push(event)
      if (event.kind === 'artifact') task.artifacts.push(event.artifact as typeof task.artifacts[number])
      if (event === options.event) outputApplied.resolve(undefined)
      if (event.kind === 'error') task.state = 'FAILED'
    },
    complete() {
      completions += 1
      task.state = 'COMPLETED'
      return task
    },
    onChildCompleted() {},
  }
  const impl = {
    steer: options.steerGate ? () => options.steerGate! : undefined,
    async* run(_request: unknown, context: AgentRunContext) {
      runs += 1
      await (context.workspace as unknown as { driverWrite: () => Promise<void> }).driverWrite()
      runStarted.resolve(context)
      if (options.event) yield options.event
      await finishRun.promise
      if (options.settlementError) failSettlement = true
      if (options.lateError) yield lateError
    },
  }
  const memory = {
    async recall() {
      recallStarted.resolve(undefined)
      await options.recallGate
      return undefined
    },
    async recordTaskOutcome(value: unknown) { harvested.push(value) },
    async recordPeerExchange(...value: unknown[]) { harvested.push(value) },
  }
  const runtime = new ObservedRuntime(
    { id: 'worker', channelId: 'ch', name: 'Worker', role: 'worker', harness: 'mock', config: {} } as AgentInfo,
    impl as unknown as AgentInterface,
    { mailbox, taskEngine: engine as never, bus: {
      emit: (event: AgentEvent) => {
        emitted.push(event)
        if (event === options.event && options.peer) outputApplied.resolve(undefined)
      },
      notifyAgent() {}, wakeScheduler() {},
    } as never,
    workspace: { async driverWrite() { driverCalls += 1 } } as never, memory: memory as never, platformReply: (reply: unknown) => replies.push(reply) },
  )
  const fenceMetadata = fenceToMetadata(task)
  if (options.invalidFence === 'missing' || options.invalidFence === 'lease-only') delete fenceMetadata['x-aw-assignment-generation']
  if (options.invalidFence === 'missing' || options.invalidFence === 'generation-only') delete fenceMetadata['x-aw-execution-lease-id']
  if (options.invalidFence === 'generation-mismatch') fenceMetadata['x-aw-assignment-generation'] = task.assignmentGeneration + 1
  if (options.invalidFence === 'lease-mismatch') fenceMetadata['x-aw-execution-lease-id'] = 'stale-lease'
  const message: A2AMessage = {
    messageId: 'message', contextId: 'ch', ...(options.peer ? {} : { taskId: 'task' }), role: 'ROLE_USER', parts: [{ text: 'Perform the task' }],
    metadata: { ...(options.peer ? { 'x-aw-from-agent': 'peer' } : { 'x-aw-task-kind': 'assign', ...fenceMetadata }), 'x-aw-require-reply': 'true', 'x-aw-from-label': 'requester' },
  }
  assert.equal(runtime.enqueue(message), true)
  const row = (id = message.messageId) => ({ ...db.prepare('SELECT state, attempts, consumed_at AS consumedAt FROM messages WHERE id = ?').get(id) })
  const claimToken = (id: string) => (db.prepare('SELECT claim_token AS token FROM messages WHERE id = ?').get(id) as { token: string | null }).token
  async function cleanup() {
    finishRun.resolve(undefined)
    const stopping = runtime.stop()
    runtime.leaveProcessing.resolve(undefined)
    await stopping
    db.close()
  }
  return { runtime, task, transitions, applied, emitted, replies, harvested, runStarted, outputApplied, transitionStarted, recallStarted, finishRun, row, claimToken, repo, holdTask, cleanup,
    get runs() { return runs },
    get driverCalls() { return driverCalls },
    get completions() { return completions },
  }
}

function assertNoSettlement(f: ReturnType<typeof fixture>, state = 'WORKING') {
  assert.equal(f.completions, 0, 'must not implicitly complete')
  assert.ok(!f.transitions.includes('FAILED'), 'must not implicitly fail')
  assert.equal(f.task.state, state)
  assert.deepEqual(f.replies, [], 'must not relay a partial reply')
  assert.deepEqual(f.harvested, [], 'must not harvest an interrupted turn')
  assert.ok(!f.emitted.some(e => e.kind === 'message' && e.message.metadata?.['x-aw-relayed'] === 'true'))
}

test('preflight exception returns the exact processing claim without charging attempts', { timeout: 5000 }, async () => {
  const f = fixture({ preflightError: true })
  try {
    f.runtime.start()
    await f.runtime.processed.promise
    const stopping = f.runtime.stop()
    f.runtime.leaveProcessing.resolve(undefined)
    await stopping
    assert.deepEqual(f.row(), { state: 'pending', attempts: 0, consumedAt: null })
    assert.equal(f.runs, 0)
    assert.equal(f.driverCalls, 0)
  }
  finally { await f.cleanup() }
})

test('post-start settlement exception stops the runtime and retains its claim', { timeout: 5000 }, async () => {
  const f = fixture({ settlementError: true })
  try {
    f.runtime.start()
    await f.runStarted.promise
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    f.runtime.leaveProcessing.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    await f.runtime.stop()
    assert.equal(f.runtime.getState(), 'stopped')
    assert.equal(f.runs, 1)
    assert.deepEqual(f.row(), { state: 'consuming', attempts: 0, consumedAt: null })
  }
  finally { await f.cleanup() }
})

test('late successful steer after stop releases its exact claim without charging attempts', { timeout: 5000 }, async () => {
  const steering = gate<'steer' | 'deferred'>()
  const f = fixture({ steerGate: steering.promise })
  try {
    f.runtime.start()
    await f.runStarted.promise
    const urgent: A2AMessage = { messageId: 'urgent', contextId: 'ch', role: 'ROLE_USER', parts: [{ text: 'Urgent update' }], metadata: {} }
    assert.equal(f.runtime.enqueue(urgent), true)
    f.runtime.injectSteer(urgent)
    assert.deepEqual(f.row('urgent'), { state: 'consuming', attempts: 0, consumedAt: null })
    const stopping = f.runtime.stop()
    steering.resolve('steer')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(f.row('urgent'), { state: 'consuming', attempts: 0, consumedAt: null }, 'interrupted steer cannot replay while its turn is running')
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    f.runtime.leaveProcessing.resolve(undefined)
    await stopping
    assert.deepEqual(f.row('urgent'), { state: 'pending', attempts: 0, consumedAt: null })
  }
  finally {
    steering.resolve('deferred')
    await f.cleanup()
  }
})

test('successful steer on a live turn is consumed', { timeout: 5000 }, async () => {
  const steering = gate<'steer' | 'deferred'>()
  const f = fixture({ steerGate: steering.promise })
  try {
    f.runtime.start()
    await f.runStarted.promise
    const urgent: A2AMessage = { messageId: 'urgent', contextId: 'ch', role: 'ROLE_USER', parts: [{ text: 'Update' }], metadata: {} }
    f.runtime.enqueue(urgent)
    f.runtime.injectSteer(urgent)
    steering.resolve('steer')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.row('urgent').state, 'consumed')
    assert.equal(f.row('urgent').attempts, 0)
  }
  finally {
    steering.resolve('deferred')
    await f.cleanup()
  }
})

test('steer settle rechecks the persisted row: a linkage held mid-steer is quarantined, not consumed', { timeout: 5000 }, async () => {
  const steering = gate<'steer' | 'deferred'>()
  const f = fixture({ steerGate: steering.promise, recoveryHold: true })
  try {
    f.runtime.start()
    await f.runStarted.promise
    const urgent: A2AMessage = {
      messageId: 'urgent', contextId: 'ch', taskId: 'task', role: 'ROLE_USER', parts: [{ text: 'Urgent update' }],
      metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task' },
    }
    f.runtime.enqueue(urgent)
    f.runtime.injectSteer(urgent)
    assert.deepEqual(f.row('urgent'), { state: 'consuming', attempts: 0, consumedAt: null })
    // The recovery hold lands while the async steer is still in flight.
    f.holdTask('task')
    steering.resolve('steer')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.row('urgent').state, 'dead', 'a blocked delivery must not be acknowledged as consumed')
    assert.equal(f.claimToken('urgent'), null, 'the quarantined claim must not retain a token')
    assert.equal(f.row('urgent').attempts, 0, 'quarantine must not charge the retry budget')
  }
  finally {
    steering.resolve('deferred')
    await f.cleanup()
  }
})

test('steer aborted by stop on a held linkage quarantines instead of queueing a replay', { timeout: 5000 }, async () => {
  const steering = gate<'steer' | 'deferred'>()
  const f = fixture({ steerGate: steering.promise, recoveryHold: true })
  try {
    f.runtime.start()
    await f.runStarted.promise
    const urgent: A2AMessage = {
      messageId: 'urgent', contextId: 'ch', taskId: 'task', role: 'ROLE_USER', parts: [{ text: 'Urgent update' }],
      metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task' },
    }
    f.runtime.enqueue(urgent)
    f.runtime.injectSteer(urgent)
    f.holdTask('task')
    const stopping = f.runtime.stop()
    steering.resolve('steer')
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    f.runtime.leaveProcessing.resolve(undefined)
    await stopping
    assert.equal(f.row('urgent').state, 'dead', 'must not queue a replay for a recovery-held task')
    assert.equal(f.claimToken('urgent'), null)
  }
  finally {
    steering.resolve('deferred')
    await f.cleanup()
  }
})

test('late steer cannot settle a newer claim after interruption', { timeout: 5000 }, async () => {
  const steering = gate<'steer' | 'deferred'>()
  const f = fixture({ steerGate: steering.promise })
  try {
    f.runtime.start()
    await f.runStarted.promise
    const urgent: A2AMessage = { messageId: 'urgent', contextId: 'ch', role: 'ROLE_USER', parts: [{ text: 'Update' }], metadata: {} }
    f.runtime.enqueue(urgent)
    f.runtime.injectSteer(urgent)
    const old = f.claimToken('urgent')!
    const stopping = f.runtime.stop()
    assert.equal(f.repo.releaseClaim('urgent', old), true)
    const current = f.repo.claim('urgent')!
    assert.notEqual(old, current)
    steering.resolve('steer')
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    f.runtime.leaveProcessing.resolve(undefined)
    await stopping
    assert.equal(f.claimToken('urgent'), current)
    assert.deepEqual(f.row('urgent'), { state: 'consuming', attempts: 0, consumedAt: null })
    assert.equal(f.repo.releaseClaim('urgent', current), true)
  }
  finally {
    steering.resolve('deferred')
    await f.cleanup()
  }
})

test('watchdog retains the claim and execution lock while a generator ignores abort', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    f.runtime.start()
    const context = await f.runStarted.promise
    await f.runtime.fireWatchdog('message')
    assert.equal(context.signal.aborted, true)
    let nextStarted = false
    const next = f.runtime.withExecLock(async () => {
      nextStarted = true
    })
    let stopped = false
    const stopping = f.runtime.stop().then(() => {
      stopped = true
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(nextStarted, false)
    assert.equal(stopped, false)
    assert.deepEqual(f.row(), { state: 'consuming', attempts: 0, consumedAt: null })
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    f.runtime.leaveProcessing.resolve(undefined)
    await Promise.all([stopping, next])
  }
  finally { await f.cleanup() }
})

for (const invalidFence of ['missing', 'generation-only', 'lease-only', 'generation-mismatch', 'lease-mismatch', 'revoked'] as const) {
  test(`assignment with ${invalidFence} fence is consumed without executing`, { timeout: 5000 }, async () => {
    const f = fixture({ initialState: 'ASSIGNED', invalidFence })
    try {
      f.runtime.start()
      await f.runtime.processed.promise
      assert.equal(f.runs, 0)
      assert.equal(f.driverCalls, 0)
      assert.equal(f.task.state, 'ASSIGNED')
      assert.deepEqual(f.transitions, [])
      assert.deepEqual(f.applied, [])
      assert.deepEqual(f.replies, [])
      assert.deepEqual(f.harvested, [])
      const row = f.row()
      assert.equal(row.state, 'consumed')
      assert.equal(row.attempts, 0)
      assert.equal(typeof row.consumedAt, 'string')
    }
    finally { await f.cleanup() }
  })
}

for (const [label, event] of [['no output', undefined], ['status', statusEvent], ['artifact', artifactEvent]] as const) {
  test(`watchdog abort after ${label} preserves the task and requeues only after the turn exits`, { timeout: 5000 }, async () => {
    const f = fixture({ event })
    try {
      f.runtime.start()
      const context = await f.runStarted.promise
      if (event) await f.outputApplied.promise
      await f.runtime.fireWatchdog('message')
      assert.equal(context.signal.aborted, true)
      assert.match(String(context.signal.reason), /message watchdog/i)
      assert.deepEqual(f.row(), { state: 'consuming', attempts: 0, consumedAt: null }, 'do not release while the old turn is running')
      f.finishRun.resolve(undefined)
      await f.runtime.processed.promise
      assertNoSettlement(f)
      assert.deepEqual(f.row(), { state: 'pending', attempts: 1, consumedAt: null }, 'watchdog retry must not remain consuming')
      assert.equal(f.runs, 1)
    }
    finally { await f.cleanup() }
  })
}

for (const kind of ['runtime stop', 'task abort'] as const) {
  test(`${kind} during a run does not settle partial output or strand its claim`, { timeout: 5000 }, async () => {
    const f = fixture({ event: statusEvent })
    try {
      f.runtime.start()
      const context = await f.runStarted.promise
      await f.outputApplied.promise
      const stopping = kind === 'runtime stop' ? f.runtime.stop() : undefined
      if (kind === 'task abort') {
        f.task.state = 'CANCELED'
        assert.equal(f.runtime.abortTask('task'), true)
      }
      assert.equal(context.signal.aborted, true)
      f.finishRun.resolve(undefined)
      await f.runtime.processed.promise
      assertNoSettlement(f, kind === 'task abort' ? 'CANCELED' : 'WORKING')
      const stopped = stopping ?? f.runtime.stop()
      f.runtime.leaveProcessing.resolve(undefined)
      await stopped
      const row = f.row()
      assert.equal(row.state, kind === 'task abort' ? 'consumed' : 'pending')
      assert.equal(row.attempts, 0)
      assert.equal(kind === 'task abort' ? typeof row.consumedAt : row.consumedAt, kind === 'task abort' ? 'string' : null)
    }
    finally { await f.cleanup() }
  })
}

for (const phase of ['transition', 'recall'] as const) {
  for (const kind of ['runtime stop', 'task abort'] as const) {
    test(`${kind} during ${phase} prevents starting the harness and releases the message`, { timeout: 5000 }, async () => {
      const pause = gate<undefined>()
      const f = fixture(phase === 'transition'
        ? { initialState: 'ASSIGNED', transitionGate: pause.promise }
        : { recallGate: pause.promise })
      try {
        f.runtime.start()
        await (phase === 'transition' ? f.transitionStarted.promise : f.recallStarted.promise)
        const stopping = kind === 'runtime stop' ? f.runtime.stop() : undefined
        if (kind === 'task abort') {
          f.task.state = 'CANCELED'
          assert.equal(f.runtime.abortTask('task'), true)
        }
        pause.resolve(undefined)
        f.finishRun.resolve(undefined)
        await f.runtime.processed.promise
        assert.equal(f.runs, 0, 'harness must not start after interruption')
        assertNoSettlement(f, kind === 'task abort' ? 'CANCELED' : 'WORKING')
        const stopped = stopping ?? f.runtime.stop()
        f.runtime.leaveProcessing.resolve(undefined)
        await stopped
        const row = f.row()
        assert.equal(row.state, kind === 'task abort' ? 'consumed' : 'pending')
        assert.equal(row.attempts, 0)
        assert.equal(kind === 'task abort' ? typeof row.consumedAt : row.consumedAt, kind === 'task abort' ? 'string' : null)
      }
      finally {
        pause.resolve(undefined)
        await f.cleanup()
      }
    })
  }
}

test('watchdog does not relay or record a partial peer exchange', { timeout: 5000 }, async () => {
  const f = fixture({ event: statusEvent, peer: true })
  try {
    f.runtime.start()
    await f.runStarted.promise
    await f.outputApplied.promise
    await f.runtime.fireWatchdog('message')
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    assertNoSettlement(f)
    assert.deepEqual(f.row(), { state: 'pending', attempts: 1, consumedAt: null })
  }
  finally { await f.cleanup() }
})

test('an error event arriving after abort is not emitted or applied to the task', { timeout: 5000 }, async () => {
  const f = fixture({ lateError: true })
  try {
    f.runtime.start()
    await f.runStarted.promise
    f.task.state = 'CANCELED'
    assert.equal(f.runtime.abortTask('task'), true)
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    assert.ok(!f.emitted.some(event => event.kind === 'error'))
    assert.ok(!f.applied.some(event => event.kind === 'error'))
    assertNoSettlement(f, 'CANCELED')
    const row = f.row()
    assert.equal(row.state, 'consumed')
    assert.equal(row.attempts, 0)
    assert.equal(typeof row.consumedAt, 'string')
  }
  finally { await f.cleanup() }
})

test('an uninterrupted output still completes, relays, harvests and consumes', { timeout: 5000 }, async () => {
  const f = fixture({ event: artifactEvent })
  try {
    f.runtime.start()
    const context = await f.runStarted.promise
    assert.ok(context.executionScope, 'leased assignment must provide an execution scope')
    assert.equal(context.executionScope.assignmentGeneration, f.task.assignmentGeneration)
    assert.equal(context.executionScope.executionLeaseId, f.task.executionLeaseId)
    context.executionScope.assertActive()
    await f.outputApplied.promise
    f.finishRun.resolve(undefined)
    await f.runtime.processed.promise
    assert.equal(f.completions, 1)
    assert.equal(f.task.state, 'COMPLETED')
    assert.equal(f.replies.length, 1)
    assert.equal(f.harvested.length, 1)
    const row = f.row()
    assert.equal(row.state, 'consumed')
    assert.equal(row.attempts, 0)
    assert.equal(typeof row.consumedAt, 'string')
  }
  finally { await f.cleanup() }
})
