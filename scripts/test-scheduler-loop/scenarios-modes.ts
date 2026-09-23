/**
 * 场景 8–9、11:显式执行模式 —— goal 仍由 lead 判定、pipeline 按阶段有序推进、
 * loop 间隔生效并在 maxIterations 后停止重提交。
 */
import { MockAgentImpl } from '../../server/services/workshop/agents/mock-agent'
import { encodeTaskMode } from '../../server/services/workshop/runtime/execution-mode'
import type { WorkspaceTask } from '../../server/services/workshop/types/task'
import { check, setup, sleep, submitLoopTask, submitTask, teardown, waitUntil, wireLoopResubmit } from './lib'

export async function testGoalModeRemainsLeadJudged(): Promise<void> {
  console.log('\n--- 8. 显式 goal 模式仍由 lead 判定并产出 goal-summary ---')
  const s = setup({ tickMs: 10, leadImpl: new MockAgentImpl({ delayMs: 0, goalRejectRounds: 1 }) })
  s.loop.start()
  const parent = submitTask(
    s,
    'goal mode task',
    encodeTaskMode('goal', { goalCriteria: 'deliver a verified result' }, 'explicit goal-mode test'),
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const task = s.engine.get(parent.id)
  check('goal 经补充判定后完成', completed, `state=${task?.state}`)
  check('goal 保留 goal-summary artifact', task?.artifacts.some(artifact => artifact.name === 'goal-summary') === true)
  check('goal 至少产生一次补充 child', s.engine.list(s.channelId).filter(item => item.parentId === parent.id).length >= 2)

  await teardown(s)
}

export async function testPipelineModeRemainsOrdered(): Promise<void> {
  console.log('\n--- 9. 显式 pipeline 模式仍按阶段顺序推进并完成 ---')
  const s = setup({ tickMs: 10, leadImpl: new MockAgentImpl({ delayMs: 0 }) })
  s.loop.start()
  const parent = submitTask(
    s,
    'pipeline mode task',
    encodeTaskMode('pipeline', {
      stages: [
        { name: 'design', description: 'prepare the design' },
        { name: 'build', description: 'build the result' },
      ],
    }, 'explicit pipeline-mode test'),
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const children = s.engine.list(s.channelId).filter(task => task.parentId === parent.id)
  check('pipeline 全阶段完成后收口', completed, `state=${s.engine.get(parent.id)?.state}`)
  check(
    'pipeline child 按 design → build 顺序创建',
    children.length === 2 && children[0]?.title.includes('design') && children[1]?.title.includes('build'),
    children.map(task => task.title).join(' → '),
  )
  check('pipeline child 均已完成', children.length === 2 && children.every(task => task.state === 'COMPLETED'))

  await teardown(s)
}

export async function testLoopIntervalAndMaxIterations(): Promise<void> {
  console.log('\n--- 11. loop 模式:间隔生效 + maxIterations 后停止 ---')
  const s = setup({ tickMs: 10 })
  wireLoopResubmit(s)
  s.loop.start()

  const title = '循环任务'
  const intervalMs = 300
  const maxIterations = 2
  const first = submitLoopTask(s, title, { intervalMs, maxIterations })
  // mock lead dispatch 的子任务会继承父任务标题,统计主任务需排除子任务(parentId 存在)
  const parents = (): WorkspaceTask[] =>
    s.engine.list(s.channelId).filter(t => t.title === title && !t.parentId)

  // 首轮执行完成(此时才开始等待间隔)
  await waitUntil(() => s.engine.get(first.id)?.state === 'COMPLETED')
  check('loop 首轮执行完成', s.engine.get(first.id)?.state === 'COMPLETED')

  // 间隔后重提交:出现第 2 轮主任务,且间隔 ≥ intervalMs(从首轮完成时刻起算)
  const firstDoneAt = Date.now()
  const resubmitted = await waitUntil(() => {
    const same = parents()
    return same.length >= 2 && same[1]!.state === 'COMPLETED'
  }, 5000)
  const waitMs = Date.now() - firstDoneAt
  check('间隔后重提交并完成第 2 轮', resubmitted, `主任务数=${parents().length}`)
  check('等待时长 ≥ 配置间隔', waitMs >= intervalMs, `wait=${waitMs}ms interval=${intervalMs}ms`)

  // 达到 maxIterations=2 后不再重提交:再等数个间隔,主任务数仍为 2
  await sleep(intervalMs * 3)
  const finalCount = parents().length
  check('达到 maxIterations 后停止重提交', finalCount === maxIterations, `主任务数=${finalCount}(期望 ${maxIterations})`)

  // 全部主任务均完成(无残留半截循环)
  const loopTasks = parents()
  check('所有轮次主任务均完成', loopTasks.every(t => t.state === 'COMPLETED'), loopTasks.map(t => t.state).join(','))

  await teardown(s)
}
