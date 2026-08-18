/**
 * 诊断:goal 模式下 lead/worker 的 agent.status 事件流(mock)。
 * 观察 lead 判定完成前后 emit 的状态事件,定位"lead 状态不同步"缺口。
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(40)
  }
  return false
}

async function main(): Promise<void> {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    channelEvents: createChannelEventRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  const events: string[] = []

  const ch = await manager.createChannel({
    name: 'goal 诊断',
    leadAgent: { name: 'lead-g', harness: 'mock', config: { delayMs: 10 } },
  })
  await manager.addAgentToChannel({
    channelId: ch.channelId,
    agentId: (await manager.createAgent({ name: 'w-g', harness: 'mock', config: { delayMs: 10 } })).id,
    role: 'worker',
  })
  manager.ensureChannelActive(ch.channelId, { tickMs: 30, stallMs: 60_000 })

  const unsubAgent = manager.subscribeAgentStatus(ch.channelId, (e) => {
    events.push(`status ${e.agentId} ${e.state} current=${e.currentTaskId ?? '-'} q=${e.queuedCount ?? 0} c=${e.completedCount ?? 0}`)
  })
  const unsubTask = manager.subscribeTaskEvents(ch.channelId, (e) => {
    events.push(`task   ${e.taskId.slice(0, 8)} state=${e.state ?? '-'} agent=${e.agentId ?? '-'}`)
  })

  /** 内部访问:类型收窄(公开 API 未暴露 taskEngine)→ 具名接口,供诊断读取任务状态 */
  interface EngineInternal {
    get(id: string): { state: string } | undefined
    list(channelId: string): { id: string, state: string, title: string, parentId?: string }[]
  }
  const engine: EngineInternal = (manager as unknown as {
    getTaskEngine(): EngineInternal
  }).getTaskEngine()

  const task = await manager.submitChannelTask({
    channelId: ch.channelId,
    title: '诊断目标',
    description: '完成即可',
    mode: 'goal',
    modeConfig: { goalCriteria: '完成' },
  })

  const ok = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 15_000)
  await sleep(600) // 等可能的后续事件落盘
  console.log(`goal COMPLETED: ${ok}`)
  console.log('--- 事件流(按序) ---')
  for (const e of events) console.log('  ' + e)

  const leadEvents = events.filter(e => e.startsWith('status lead-g'))
  const workerEvents = events.filter(e => e.startsWith('status w-g'))
  console.log(`\nlead 状态事件数=${leadEvents.length}`)
  console.log(`worker 状态事件数=${workerEvents.length}`)

  unsubAgent()
  unsubTask()
  await manager.shutdown()
  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
