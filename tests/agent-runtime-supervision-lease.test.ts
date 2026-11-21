import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import { TaskEngineViews } from '../server/services/workshop/runtime/task-engine/views'
import { rowToTaskLite } from '../server/services/workshop/runtime/task-engine/helpers'
import type { AgentInfo, AgentInterface, AgentRunContext, SupervisionSnapshot } from '../server/services/workshop/agents/agent-interface'
import type { TaskMetaRow } from '../server/services/workshop/db/task.repo'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

const leaseStarted = '2026-01-01T00:00:00.000Z'
const leaseRevoked = '2026-01-02T00:00:00.000Z'

function rootRow(): TaskMetaRow {
  return {
    id: 'root', channelId: 'channel', parentId: null, rootQueueSeq: 1,
    assigneeId: 'lead', creatorId: 'user', title: 'Root', description: null,
    state: 'WAITING', progress: 0, retryCount: 0, routeReason: '',
    sourceChatMessageId: null, sourceChatDeliveryId: null, closeReason: null,
    deadlineAt: null, source: 'channel', projectId: null, projectWorkItemId: null,
    projectAttemptNo: null, sessionId: null, traceId: '', supersededByTaskId: null,
    assignmentGeneration: 7, executionLeaseId: 'lease-7', executionLeaseAgentId: 'lead',
    executionLeaseStartedAt: leaseStarted, executionLeaseRevokedAt: null,
    createdAt: leaseStarted, updatedAt: leaseStarted,
  }
}

function supervisionTasks(row: TaskMetaRow): WorkspaceTask[] {
  const views = Object.create(TaskEngineViews.prototype) as TaskEngineViews
  Object.assign(views, {
    repos: { tasks: { listByChannelMeta: () => [row], listActiveSupervisionArtifacts: () => [] } },
  })
  return views.listForSupervision('channel', 'lead')
}

class TestRuntime extends AgentRuntime {
  override refreshStatus(): void {}
  protected override queueContext(): never { return {} as never }
}

function fixture(options: { recall?: () => Promise<string | undefined>, onSupervise?: (ctx: AgentRunContext) => Promise<void>, sessionId?: string | null, trustedSessionId?: string | null, sessionContextBlock?: string } = {}) {
  const row = rootRow()
  if (options.sessionId !== undefined) row.sessionId = options.sessionId
  const task = rowToTaskLite(row)
  const snapshot: SupervisionSnapshot = {
    tick: 1, now: Date.now(), activeRootId: row.id, queuedRootIds: [],
    tasks: supervisionTasks(row), members: [], pendingChildren: {}, mail: [],
  }
  const contexts: AgentRunContext[] = []
  let current: WorkspaceTask | undefined = { ...task }
  const runtime = new TestRuntime(
    { id: 'lead', channelId: 'channel', name: 'Lead', role: 'lead', harness: 'mock' } as AgentInfo,
    { async supervise(_snapshot: SupervisionSnapshot, ctx: AgentRunContext) {
      contexts.push(ctx)
      await options.onSupervise?.(ctx)
      return []
    } } as unknown as AgentInterface,
    {
      mailbox: {} as never,
      taskEngine: { get: (id: string) => id === 'root' ? current : undefined } as never,
      bus: {} as never,
      workspace: {} as never,
      ...(options.recall ? { memory: { recall: options.recall } as never } : {}),
      trustedSessionId: options.trustedSessionId ?? null,
      ...(options.sessionContextBlock ? { sessionContext: () => ({ block: options.sessionContextBlock!, summary: '' }) } : {}),
    },
  )
  return {
    runtime, snapshot, contexts,
    setCurrent(value: WorkspaceTask | undefined) { current = value },
    getCurrent() { return current },
  }
}

test('lite projection preserves all execution lease fields in supervision snapshots', () => {
  const row = rootRow()
  const expected = {
    assignmentGeneration: 7,
    executionLeaseId: 'lease-7',
    executionLeaseAgentId: 'lead',
    executionLeaseStartedAt: leaseStarted,
    executionLeaseRevokedAt: leaseRevoked,
  }
  row.executionLeaseRevokedAt = leaseRevoked
  for (const task of [rowToTaskLite(row), supervisionTasks(row)[0]!]) {
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(task[key as keyof WorkspaceTask], value, key)
    }
    assert.deepEqual(task.artifacts, [])
    assert.deepEqual(task.history, [])
  }
  const empty = rowToTaskLite({ ...rootRow(), assignmentGeneration: 0, executionLeaseId: null, executionLeaseAgentId: null, executionLeaseStartedAt: null, executionLeaseRevokedAt: null })
  assert.equal(empty.assignmentGeneration, 0)
  assert.equal(empty.executionLeaseId, undefined)
  assert.equal(empty.executionLeaseAgentId, undefined)
  assert.equal(empty.executionLeaseStartedAt, undefined)
  assert.equal(empty.executionLeaseRevokedAt, undefined)
})

test('valid supervision root propagates its lite lease to an active context', async () => {
  const f = fixture({ onSupervise: async (ctx) => {
    const scope = ctx.executionScope
    assert.ok(scope)
    assert.equal(scope.taskId, 'root')
    assert.equal(scope.agentId, 'lead')
    assert.equal(scope.channelId, 'channel')
    assert.equal(scope.assignmentGeneration, 7)
    assert.equal(scope.executionLeaseId, 'lease-7')
    assert.equal(scope.signal, ctx.signal)
    assert.equal(ctx.signal.aborted, false)
    scope.assertActive()
  } })
  assert.deepEqual(await f.runtime.supervise(f.snapshot), [])
  assert.equal(f.contexts.length, 1)
  assert.equal(f.runtime.getState(), 'idle')
  assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
})

for (const mutation of ['lease', 'generation', 'revoked', 'terminal', 'assignee', 'channel', 'removed'] as const) {
  test(`supervision scope rejects a root made stale by ${mutation} after harness entry`, async () => {
    const f = fixture({ onSupervise: async (ctx) => {
      const scope = ctx.executionScope!
      scope.assertActive()
      const current = f.getCurrent()!
      if (mutation === 'removed') f.setCurrent(undefined)
      else if (mutation === 'lease') current.executionLeaseId = 'lease-new'
      else if (mutation === 'generation') current.assignmentGeneration++
      else if (mutation === 'revoked') current.executionLeaseRevokedAt = leaseRevoked
      else if (mutation === 'terminal') current.state = 'CANCELED'
      else if (mutation === 'assignee') current.assigneeId = 'another-lead'
      else current.channelId = 'another-channel'
      assert.throws(() => scope.assertActive(), /execution lease is stale/)
    } })
    assert.equal(await f.runtime.supervise(f.snapshot), null)
    assert.equal(f.contexts.length, 1)
    assert.equal(f.runtime.getSupervisionStatus().lastDecisionKind, 'aborted')
    assert.equal(f.runtime.getState(), 'idle')
  })
}

for (const invalid of ['missing root', 'missing lease', 'empty lease', 'invalid generation', 'stale lease', 'stale generation', 'revoked', 'wrong lease owner', 'wrong assignee', 'wrong channel', 'terminal', 'deleted'] as const) {
  test(`supervision refuses ${invalid} before invoking the harness`, async () => {
    const f = fixture()
    const snapshotRoot = f.snapshot.tasks[0]!
    const current = f.getCurrent()!
    if (invalid === 'missing root') f.snapshot.tasks = []
    else if (invalid === 'missing lease') snapshotRoot.executionLeaseId = undefined
    else if (invalid === 'empty lease') snapshotRoot.executionLeaseId = ''
    else if (invalid === 'invalid generation') snapshotRoot.assignmentGeneration = Number.NaN
    else if (invalid === 'stale lease') current.executionLeaseId = 'lease-new'
    else if (invalid === 'stale generation') current.assignmentGeneration++
    else if (invalid === 'revoked') current.executionLeaseRevokedAt = leaseRevoked
    else if (invalid === 'wrong lease owner') current.executionLeaseAgentId = 'other'
    else if (invalid === 'wrong assignee') current.assigneeId = 'other'
    else if (invalid === 'wrong channel') current.channelId = 'other'
    else if (invalid === 'terminal') current.state = 'CANCELED'
    else f.setCurrent(undefined)
    assert.equal(await f.runtime.supervise(f.snapshot), null)
    assert.equal(f.contexts.length, 0)
    assert.equal(f.runtime.getState(), 'idle')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
  })
}

test('cancellation during recall prevents valid root lease from reaching the harness', { timeout: 5000 }, async () => {
  const started = Promise.withResolvers<undefined>()
  const recall = Promise.withResolvers<string | undefined>()
  const f = fixture({ recall: () => {
    started.resolve(undefined)
    return recall.promise
  } })
  try {
    const supervision = f.runtime.supervise(f.snapshot)
    await started.promise
    assert.equal(f.runtime.abortTask('root'), true)
    assert.equal(await supervision, null)
    assert.equal(f.contexts.length, 0)
    assert.equal(f.runtime.getState(), 'idle')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
    recall.resolve('late memory')
    await Promise.resolve()
    assert.equal(f.contexts.length, 0)
  }
  finally { recall.resolve(undefined) }
})

test('lease replacement during recall prevents harness invocation', { timeout: 5000 }, async () => {
  const started = Promise.withResolvers<undefined>()
  const recall = Promise.withResolvers<string | undefined>()
  const f = fixture({ recall: () => {
    started.resolve(undefined)
    return recall.promise
  } })
  try {
    const supervision = f.runtime.supervise(f.snapshot)
    await started.promise
    f.getCurrent()!.executionLeaseId = 'replacement'
    recall.resolve('recalled memory')
    assert.equal(await supervision, null)
    assert.equal(f.contexts.length, 0)
    assert.equal(f.runtime.getState(), 'idle')
    assert.equal(f.runtime.getSupervisionStatus().state, 'IDLE')
  }
  finally { recall.resolve(undefined) }
})

test('supervision without an active root remains unscoped', async () => {
  const f = fixture()
  f.snapshot.activeRootId = null
  assert.deepEqual(await f.runtime.supervise(f.snapshot), [])
  assert.equal(f.contexts.length, 1)
  assert.equal(f.contexts[0]!.executionScope, undefined)
})

test('supervision passes the root task session to the harness context', async () => {
  const f = fixture({ sessionId: 'cs-root', sessionContextBlock: 'SESSION-BLOCK' })
  assert.deepEqual(await f.runtime.supervise(f.snapshot), [])
  assert.deepEqual(f.contexts[0]?.session, { id: 'cs-root', block: 'SESSION-BLOCK' })
})

test('trusted clone session wins over the root task session in supervision', async () => {
  const f = fixture({ sessionId: 'cs-root', trustedSessionId: 'cs-clone', sessionContextBlock: 'BLOCK' })
  assert.deepEqual(await f.runtime.supervise(f.snapshot), [])
  assert.deepEqual(f.contexts[0]?.session, { id: 'cs-clone', block: 'BLOCK' })
})

test('supervision without any session identity keeps the legacy context', async () => {
  const f = fixture()
  assert.deepEqual(await f.runtime.supervise(f.snapshot), [])
  assert.equal(f.contexts[0]?.session, undefined)
})
