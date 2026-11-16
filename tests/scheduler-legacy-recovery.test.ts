import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop/facade'
import { TaskEngineViews } from '../server/services/workshop/runtime/task-engine/views'
import { isLegacyRecoveryHeld, LEGACY_RECOVERY_MARKER } from '../server/services/workshop/runtime/task-engine/legacy-recovery'
import type { SupervisionSnapshot } from '../server/services/workshop/agents/agent-interface'
import type { SchedulerDecision } from '../server/services/workshop/runtime/scheduler-loop/types'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

const task = (id: string, parentId: string | undefined, seq: number | undefined, state = 'WORKING', held = false): WorkspaceTask => ({
  id, channelId: 'channel', parentId, rootQueueSeq: seq, state, assigneeId: parentId ? 'worker' : 'lead',
  title: id, progress: 0, retryCount: 0, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  assignmentGeneration: 1, executionLeaseId: 'lease', executionLeaseAgentId: parentId ? 'worker' : 'lead',
  closeReason: held ? `previous ${LEGACY_RECOVERY_MARKER}` : undefined, artifacts: [], history: [],
} as WorkspaceTask)

class TestScheduler extends SchedulerLoop {
  snapshot!: SupervisionSnapshot
  recoveries = 0
  executed: SchedulerDecision[] = []
  exposeDeadline(snapshot: SupervisionSnapshot) { return this.enforceRootDeadlines(snapshot) }
  exposeRound() { return this.tickRound() }
  exposeDecision(decision: SchedulerDecision) { return super.execute(decision) }
  exposeRules(snapshot: SupervisionSnapshot) { return super.ruleEngine(snapshot) }
  protected override collectSnapshot() { return this.snapshot }
  protected override execute(decision: SchedulerDecision): void { this.executed.push(decision) }
  protected override ruleEngine(snapshot: SupervisionSnapshot): SchedulerDecision[] {
    this.recoveries++
    return super.ruleEngine(snapshot)
  }
}

function fixture(tasks: WorkspaceTask[], activeRootId: string | null) {
  let superviseCalls = 0
  const timeouts: string[] = []
  const dispatches: string[] = []
  const view = Object.create(TaskEngineViews.prototype) as TaskEngineViews
  Object.assign(view, { repos: { tasks: {
    findById: (id: string) => tasks.find(t => t.id === id),
    listByChannelMeta: () => tasks,
  } } })
  const engine = {
    get: (id: string) => tasks.find(t => t.id === id),
    listLite: () => tasks,
    isLegacyRecoveryBlocked: (id: string) => view.isLegacyRecoveryBlocked(id),
    hasLegacyRecoveryHold: () => tasks.some(isLegacyRecoveryHeld),
    activeRootOf: () => tasks.find(t => t.id === activeRootId),
    timeoutTree: (id: string) => {
      timeouts.push(id)
      return []
    },
    dispatch: (parent: WorkspaceTask) => { dispatches.push(parent.id) },
  }
  const lead = {
    agentId: 'lead', getState: () => 'idle', taskEngine: engine,
    supervise: async () => {
      superviseCalls++
      return []
    },
    refreshStatus() {},
  }
  const channel = {
    channelId: 'channel', getAgents: () => [],
    listChannelAgents: () => [{ agentId: 'worker', role: 'worker', name: 'Worker' }],
    isAgentEnabled: () => true,
    wakeAgent() {},
  }
  const scheduler = new TestScheduler(channel as never, lead as never)
  scheduler.snapshot = { tick: 1, now: Date.now(), activeRootId, queuedRootIds: [], tasks, members: [], pendingChildren: {}, mail: [] }
  return {
    scheduler, timeouts, dispatches,
    get superviseCalls() { return superviseCalls },
  }
}

test('held descendant blocks its tree and later FIFO roots, not earlier roots', () => {
  const tasks = [task('earlier', undefined, 1), task('held', undefined, 2), task('child', 'held', undefined, 'FAILED', true), task('later', undefined, 3), task('later-child', 'later', undefined)]
  const f = fixture(tasks, 'earlier')
  const engine = (f.scheduler as unknown as { lead: { taskEngine: { isLegacyRecoveryBlocked: (id: string) => boolean } } }).lead.taskEngine
  assert.deepEqual(tasks.filter(t => engine.isLegacyRecoveryBlocked(t.id)).map(t => t.id).sort(), ['child', 'held', 'later', 'later-child'])
  tasks[0]!.rootQueueSeq = undefined
  assert.equal(engine.isLegacyRecoveryBlocked('earlier'), true, 'unknown ordering must fail closed')
})

test('held tree and queued successor have no deadline, supervision, or recovery action', async () => {
  const held = task('held', undefined, 1, 'WORKING', true)
  const child = task('child', 'held', undefined, 'FAILED', true)
  const later = task('later', undefined, 2)
  held.deadlineAt = later.deadlineAt = '2020-01-01T00:00:00Z'
  const f = fixture([held, child, later], 'held')
  assert.equal(await f.scheduler.exposeDeadline(f.scheduler.snapshot), false)
  await f.scheduler.exposeRound()
  assert.deepEqual(f.timeouts, [])
  assert.equal(f.superviseCalls, 0)
  assert.equal(f.scheduler.recoveries, 0)
  assert.deepEqual(f.scheduler.executed, [])
})

test('terminal held root remains a FIFO barrier', async () => {
  const held = task('held', undefined, 1, 'COMPLETED', true)
  const later = task('later', undefined, 2, 'WORKING')
  later.deadlineAt = '2020-01-01T00:00:00Z'
  const f = fixture([held, later], 'later')
  assert.equal(await f.scheduler.exposeDeadline(f.scheduler.snapshot), false)
  await f.scheduler.exposeRound()
  assert.equal(f.superviseCalls, 0)
  assert.deepEqual(f.timeouts, [])
  assert.deepEqual(f.scheduler.executed, [])
})

test('an earlier independent expired root still times out ahead of a held root', async () => {
  const earlier = task('earlier', undefined, 1, 'WORKING')
  earlier.deadlineAt = '2020-01-01T00:00:00Z'
  const held = task('held', undefined, 2, 'WORKING', true)
  const f = fixture([earlier, held], 'earlier')
  assert.equal(await f.scheduler.exposeDeadline(f.scheduler.snapshot), true)
  assert.deepEqual(f.timeouts, ['earlier'])
})

test('hold arriving during deadline approval lookup prevents timeout', async () => {
  const root = task('root', undefined, 1)
  root.deadlineAt = '2020-01-01T00:00:00Z'
  const f = fixture([root], 'root')
  const pending = f.scheduler.exposeDeadline(f.scheduler.snapshot)
  root.closeReason = LEGACY_RECOVERY_MARKER
  assert.equal(await pending, false)
  assert.deepEqual(f.timeouts, [])
})

test('recovery ignores held descendant and later root while retaining independent earlier recovery', () => {
  const earlier = task('earlier', undefined, 1, 'WAITING')
  const failed = task('earlier-child', 'earlier', undefined, 'FAILED')
  const held = task('held', undefined, 2, 'WAITING', true)
  const heldFailed = task('held-child', 'held', undefined, 'FAILED', true)
  const later = task('later', undefined, 3, 'WAITING')
  const laterFailed = task('later-child', 'later', undefined, 'FAILED')
  const f = fixture([earlier, failed, held, heldFailed, later, laterFailed], 'earlier')
  f.scheduler.snapshot.members = [{ agentId: 'worker', name: 'Worker', role: 'worker', state: 'idle', queued: 0 } as never]
  const decisions = f.scheduler.exposeRules(f.scheduler.snapshot)
  assert.deepEqual(decisions.map(d => 'taskId' in d ? d.taskId : undefined), ['earlier-child'])
})

test('late hold blocks stale dispatch and FIFO successor even if root queuing is disabled', () => {
  const held = task('held', undefined, 1, 'WAITING')
  const later = task('later', undefined, 2, 'WAITING')
  const f = fixture([held, later], 'held')
  held.closeReason = LEGACY_RECOVERY_MARKER
  for (const parentTaskId of ['held', 'later']) {
    f.scheduler.exposeDecision({ kind: 'dispatch', parentTaskId, assigneeId: 'worker', title: 'child' })
  }
  assert.deepEqual(f.dispatches, [])
})

test('hold arriving during supervision discards all decisions including member management', async () => {
  const root = task('root', undefined, 1, 'WAITING')
  const entered = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<SchedulerDecision[]>()
  const f = fixture([root], 'root')
  const lead = (f.scheduler as unknown as { lead: { supervise: () => Promise<SchedulerDecision[]> } }).lead
  lead.supervise = () => {
    entered.resolve(undefined)
    return result.promise
  }
  const round = f.scheduler.exposeRound()
  await entered.promise
  root.closeReason = LEGACY_RECOVERY_MARKER
  result.resolve([{ kind: 'remove_agent', agentId: 'worker', reason: 'test' }])
  await round
  assert.deepEqual(f.scheduler.executed, [])
  assert.equal(f.scheduler.recoveries, 0)
})
