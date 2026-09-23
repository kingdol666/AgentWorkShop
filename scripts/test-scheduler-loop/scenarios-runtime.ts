/**
 * 场景 10、12:运行时生命周期与工厂 —— stop() 后不再调度,createAgentImpl 按 harness 建实现。
 */
import { randomUUID } from 'node:crypto'
import { ClaudeSdkAgentImpl } from '../../server/services/workshop/agents/claude-agent'
import { createAgentImpl } from '../../server/services/workshop/agents/factory'
import { MockAgentImpl } from '../../server/services/workshop/agents/mock-agent'
import type { AgentInfo } from '../../server/services/workshop/agents/agent-interface'
import { AppError } from '../../server/utils/errors'
import { check, setup, sleep, submitTask, teardown, waitUntil } from './lib'

export async function testStopStopsScheduling(): Promise<void> {
  console.log('\n--- 10. stop 后不再调度 ---')
  const s = setup({ tickMs: 10 })
  s.loop.start()
  const first = submitTask(s, '任务一')
  const firstDone = await waitUntil(() => s.engine.get(first.id)?.state === 'COMPLETED')
  check('stop 前任务完整完成', firstDone)

  s.loop.stop()

  const second = submitTask(s, '任务二')
  await sleep(200)
  const state = s.engine.get(second.id)?.state
  const hasChild = s.engine.list(s.channelId).some(t => t.parentId === second.id)
  check('stop 后新任务不再被 dispatch', state === 'SUBMITTED' && !hasChild, `state=${state} hasChild=${hasChild}`)

  await teardown(s)
}

export function testFactory(): void {
  console.log('\n--- 12. createAgentImpl 工厂 ---')
  const mk = (harness: string): AgentInfo => ({
    id: randomUUID(),
    channelId: 'ch',
    name: 'a',
    harness,
    role: 'worker',
    config: {},
  })

  check('mock → MockAgentImpl 实例', createAgentImpl(mk('mock')) instanceof MockAgentImpl)

  check('claude → ClaudeSdkAgentImpl 实例', createAgentImpl(mk('claude')) instanceof ClaudeSdkAgentImpl)

  try {
    createAgentImpl(mk('unknown'))
    check('未知 harness 抛 UNKNOWN_HARNESS', false, '未抛异常')
  }
  catch (e) {
    const err = e as AppError
    check(
      '未知 harness 抛 UNKNOWN_HARNESS',
      err instanceof AppError && err.code === 'UNKNOWN_HARNESS' && err.status === 400,
      `code=${err?.code} status=${err?.status}`,
    )
  }
}
