import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerLoopTick } from '../server/services/workshop/runtime/scheduler-loop/tick'
import type { SupervisionSnapshot } from '../server/services/workshop/agents/agent-interface'
import type { SchedulerDecision } from '../server/services/workshop/runtime/scheduler-loop/types'

class TestSchedulerLoop extends SchedulerLoopTick {
  constructor() {
    super({ channelId: 'channel-1' } as never, { agentId: 'lead-1', supervise: async () => [] } as never)
    this.lastSuperviseAt = 1
  }

  remember(snapshot: SupervisionSnapshot): void {
    this.lastFingerprint = this.superviseFingerprint(snapshot)
  }

  shouldRun(snapshot: SupervisionSnapshot): boolean {
    return this.shouldSupervise(snapshot)
  }

  protected override checkLoopCompletion(): void {}
  protected override collectSnapshot(): SupervisionSnapshot { return {} as never }
  protected override async decide(): Promise<SchedulerDecision[]> { return [] }
  protected override execute(): void {}
  protected override pickWorker(): SupervisionSnapshot['members'][number] | undefined { return undefined }
  protected override refreshIdle(): void {}
  protected override ruleEngine(): SchedulerDecision[] { return [] }
  protected override async runRound(): Promise<void> {}
}

const snapshot = (state: string, mail: string[] = []): SupervisionSnapshot => ({
  tick: 2,
  activeRootId: 'root-1',
  tasks: [{ id: 'root-1', parentId: null, assigneeId: 'lead-1', state }],
  members: [],
  mail: mail.map(messageId => ({ messageId })),
} as never)

test('terminal-task-only snapshot does not restart lead supervision; new mail and active roots still do', () => {
  const scheduler = new TestSchedulerLoop()
  const working = snapshot('WORKING')
  scheduler.remember(working)

  assert.equal(scheduler.shouldRun(snapshot('CANCELED')), false)
  assert.equal(scheduler.shouldRun(snapshot('CANCELED', ['message-1'])), true)
  assert.equal(scheduler.shouldRun(snapshot('WORKING')), true)
})

// ===== P1(2026-11-10):过期收口解耦到锁外 —— enforceRootDeadlines =====

interface Recorded { timeouts: string[], refreshed: Array<{ id: string, budget: string }> }

function expiryFixture(tasks: Array<Record<string, unknown>>) {
  const rec: Recorded = { timeouts: [], refreshed: [] }
  const scheduler = new TestSchedulerLoop()
  // 注入过期收口依赖(与运行时形状对齐的最小替身)
  ;(scheduler as unknown as { lead: Record<string, unknown> }).lead = {
    agentId: 'lead-1',
    taskEngine: {
      timeoutTree: (id: string) => {
        rec.timeouts.push(id)
        return []
      },
      refreshDeadline: (id: string, budget: string) => {
        rec.refreshed.push({ id, budget })
      },
    },
    refreshStatus: () => {},
  } as never
  ;(scheduler as unknown as { channelRuntime: Record<string, unknown> }).channelRuntime = {
    getAgents: () => [] as Array<{ agentId: string, abortTask?: (id: string) => void }>,
  } as never
  const snap = {
    tick: 1,
    activeRootId: tasks[0]?.id,
    tasks: tasks as never,
    members: [{ agentId: 'lead-1', state: 'idle' }],
    mail: [],
  } as never
  return { scheduler, rec, snap }
}

const past = new Date(Date.now() - 60_000).toISOString()
const future = new Date(Date.now() + 600_000).toISOString()

test('enforceRootDeadlines:超期 WORKING 根被 timeoutTree 收口(锁外可独立执行)', async () => {
  const { scheduler, rec, snap } = expiryFixture([
    { id: 'root-x', parentId: null, assigneeId: 'worker-1', state: 'WORKING', deadlineAt: past },
  ])
  const acted = await scheduler.enforceRootDeadlines(snap)
  assert.equal(acted, true)
  assert.deepEqual(rec.timeouts, ['root-x'])
})

test('enforceRootDeadlines:未超期/SUBMITTED 排队根豁免 —— 不收口不动作', async () => {
  const { scheduler, rec, snap } = expiryFixture([
    { id: 'root-future', parentId: null, assigneeId: 'w', state: 'WORKING', deadlineAt: future },
    { id: 'root-queued', parentId: null, assigneeId: 'w', state: 'SUBMITTED', deadlineAt: past },
  ])
  const acted = await scheduler.enforceRootDeadlines(snap)
  assert.equal(acted, false)
  assert.deepEqual(rec.timeouts, [])
})

test('enforceRootDeadlines:无待批审批 → 超期根照常收口(fail-closed;顺延仅在有 HITL 待批时)', async () => {
  const first = expiryFixture([
    { id: 'root-h', parentId: null, assigneeId: 'w', state: 'WORKING', deadlineAt: past },
  ])
  assert.equal(await first.scheduler.enforceRootDeadlines(first.snap), true)
  assert.deepEqual(first.rec.timeouts, ['root-h'])
  assert.deepEqual(first.rec.refreshed, [], '无待批单:不得刷新预算')
})

test('enforceRootDeadlines:模式任务(modeTask)不参与过期判定', async () => {
  // findModeTask 识别的 loop/goal 模式任务带 [mode:...] 标记(description)→ isOrdinaryRoot=false
  const { scheduler, rec, snap } = expiryFixture([
    { id: 'root-mode', parentId: null, assigneeId: 'w', state: 'WORKING', deadlineAt: past, description: '[mode:loop] 循环作业' },
  ])
  const acted = await scheduler.enforceRootDeadlines(snap)
  assert.equal(acted, false, '模式任务由 LoopController 管理,不被过期收口')
  assert.deepEqual(rec.timeouts, [])
})
