/**
 * 场景 3–7:supervise 契约与故障恢复 —— wake 立即触发一轮、空/异常决策不兜底、
 * 退避重试、可重试子任务失败不提前取消父任务、busy stall watchdog 只提醒不取消。
 */
import { MockAgentImpl } from '../../server/services/workshop/agents/mock-agent'
import type { AgentEvent, AgentInterface } from '../../server/services/workshop/agents/agent-interface'
import { check, RecordingLeadImpl, setup, sleep, submitTask, teardown, testArtifact, waitUntil } from './lib'

export async function testWakeTriggersRound(): Promise<void> {
  console.log('\n--- 3. wake 立即触发一轮(大 tickMs,无定时 tick) ---')
  const s = setup({ tickMs: 100000 })
  s.loop.start()
  const parent = submitTask(s, '主任务', '[mock:complex] wake dispatches delegated work')
  s.loop.wake()

  const dispatched = await waitUntil(
    () => s.engine.list(s.channelId).some(t => t.parentId === parent.id && t.assigneeId === s.worker.agentId),
    2000,
  )
  check('wake 立即触发 dispatch(无定时 tick)', dispatched)

  await teardown(s)
}

export async function testSuperviseEmptyDoesNotFallback(): Promise<void> {
  console.log('\n--- 4. supervise 返回空不默认 dispatch 或完成父任务 ---')
  const leadImpl = new RecordingLeadImpl(() => [])
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '空决策主任务')
  const observed = await waitUntil(() => leadImpl.records.some(record =>
    record.snapshot.tasks.some(task => task.id === parent.id),
  ))
  await sleep(150)

  check('空决策 supervise 已观察 root task', observed)
  check('空决策不派发 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))
  check('空决策不验收父任务', s.engine.get(parent.id)?.state === 'SUBMITTED', `state=${s.engine.get(parent.id)?.state}`)
  check('double 记录 supervise 空决定', leadImpl.records.some(record => record.decisions?.length === 0))

  await teardown(s)
}

export async function testLeadRetriesAfterEmptyDecision(): Promise<void> {
  console.log('\n--- 6. 空 Lead 决策不盲派，并在退避后重试，避免 root 永久悬挂 ---')
  let calls = 0
  let rootId = ''
  const leadImpl = new RecordingLeadImpl(() => {
    calls++
    if (calls === 1) return []
    return [{ kind: 'complete', taskId: rootId, artifacts: [testArtifact('retry-answer', 'deliverable', 'Lead 重试后完成。')] }]
  })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '退避后重试的简单任务')
  rootId = parent.id

  await sleep(150)
  check('首次空决策不盲派且未完成 root', calls === 1
  && s.engine.get(parent.id)?.state === 'SUBMITTED'
  && !s.engine.list(s.channelId).some(task => task.parentId === parent.id))

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED', 8_000)
  check('退避重试后 Lead 可恢复并完成任务', completed && calls >= 2, `calls=${calls} state=${s.engine.get(parent.id)?.state}`)
  await teardown(s)
}
export async function testSuperviseThrowDoesNotFallback(): Promise<void> {
  console.log('\n--- 5. supervise 抛错不默认 dispatch 或完成父任务 ---')
  const leadImpl = new RecordingLeadImpl(() => {
    throw new Error('supervise boom')
  })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '异常主任务')
  const observed = await waitUntil(() => leadImpl.records.some(record =>
    record.snapshot.tasks.some(task => task.id === parent.id),
  ))
  await sleep(150)

  check('抛错 supervise 已观察 root task', observed)
  check('抛错不派发 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))
  check('抛错不验收父任务', s.engine.get(parent.id)?.state === 'SUBMITTED', `state=${s.engine.get(parent.id)?.state}`)
  check('double 记录 supervise 异常', leadImpl.records.some(record => record.error instanceof Error))

  await teardown(s)
}
class FlakyWorkerImpl implements AgentInterface {
  private attempts = 0
  private readonly fallback = new MockAgentImpl({ delayMs: 100 })

  async* run(request: Parameters<NonNullable<AgentInterface['run']>>[0], ctx: Parameters<NonNullable<AgentInterface['run']>>[1]): AsyncIterable<AgentEvent> {
    if (request.message.metadata?.['x-aw-task-kind'] === 'assign' && ctx.role === 'worker' && this.attempts++ === 0) {
      yield { kind: 'error', error: { code: 'TEST_TRANSIENT', message: 'transient test failure' } }
      return
    }
    yield* this.fallback.run(request, ctx)
  }
}

export async function testRetryKeepsParentAlive(): Promise<void> {
  console.log('\n--- 6. 可重试子任务失败时不提前取消父任务 ---')
  const s = setup({ tickMs: 10, workerImpl: new FlakyWorkerImpl() })
  s.loop.start()
  const parent = submitTask(s, '可重试主任务', '[mock:complex] retry a transient worker failure')

  const retried = await waitUntil(() => {
    const child = s.engine.list(s.channelId).find(t => t.parentId === parent.id)
    return child?.retryCount === 1
  })
  const retriedChild = s.engine.list(s.channelId).find(t => t.parentId === parent.id)
  check('失败子任务被重派', retried, `parent=${s.engine.get(parent.id)?.state}`)
  check(
    '重试期间父任务保持 WAITING',
    s.engine.get(parent.id)?.state === 'WAITING'
    && (retriedChild?.state === 'ASSIGNED' || retriedChild?.state === 'WORKING'),
    `parent=${s.engine.get(parent.id)?.state} child=${retriedChild?.state}`,
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  check('重试成功后父任务完成', completed, `state=${s.engine.get(parent.id)?.state}`)

  await teardown(s)
}

class HeldWorkerImpl implements AgentInterface {
  started = false
  controlMessageCount = 0
  private releaseRun: (() => void) | undefined

  async* run(request: Parameters<NonNullable<AgentInterface['run']>>[0], ctx: Parameters<NonNullable<AgentInterface['run']>>[1]): AsyncIterable<AgentEvent> {
    const taskId = request.taskId
    if (request.message.metadata?.['x-aw-task-kind'] !== 'assign' || !taskId) {
      this.controlMessageCount += 1
      return
    }

    yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
    const gate = new Promise<void>((resolve) => {
      this.releaseRun = resolve
    })
    this.started = true
    await gate
    if (ctx.signal.aborted) return

    await ctx.workspace.completeTask(taskId, [testArtifact('watchdog-deliverable', 'worker-result', 'work completed after watchdog reminder')])
    yield { kind: 'done', final: { taskId } }
  }

  release(): void {
    this.releaseRun?.()
  }
}

export async function testBusyStallWatchdogDoesNotCancel(): Promise<void> {
  console.log('\n--- 7. busy task watchdog 发出提醒但不取消进行中的工作 ---')
  const workerImpl = new HeldWorkerImpl()
  const s = setup({ tickMs: 10, stallMs: 25, leadImpl: new RecordingLeadImpl(() => []), workerImpl })
  const parent = submitTask(s, 'watchdog coordination task')
  s.engine.transition(parent.id, 'WORKING', s.lead.agentId)
  const child = s.engine.dispatch(parent, {
    assigneeId: s.worker.agentId,
    title: 'watchdog worker task',
    description: 'worker task for watchdog behavior',
  })
  s.worker.wakeMailbox()
  s.loop.start()

  const started = await waitUntil(() => workerImpl.started)
  await sleep(120)
  check('worker 已进入 held WORKING 回合', started && s.engine.get(child.id)?.state === 'WORKING')
  check('busy stall watchdog 不强制取消任务', s.engine.get(child.id)?.state === 'WORKING', `state=${s.engine.get(child.id)?.state}`)

  workerImpl.release()
  const childCompleted = await waitUntil(() => s.engine.get(child.id)?.state === 'COMPLETED')
  const notified = await waitUntil(() => workerImpl.controlMessageCount > 0)
  await sleep(40)
  check('释放后 worker 以交付完成 child', childCompleted && !!s.engine.get(child.id)?.artifacts.length)
  check('watchdog 提醒在回合结束后送达 worker', notified)
  check('空 supervise 后 ruleEngine 不验收 parent', s.engine.get(parent.id)?.state !== 'COMPLETED', `state=${s.engine.get(parent.id)?.state}`)
  check('ruleEngine 不延伸派发孙任务', !s.engine.list(s.channelId).some(task => task.parentId === child.id))

  await teardown(s)
}
