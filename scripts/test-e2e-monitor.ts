/**
 * 端到端监控测试 — mock harness 全流程 + WorkshopMonitor 事件流验证。
 *
 * 流程: 创建 Channel(lead+2 workers) → monitor 启动 → 提交任务 → SchedulerLoop
 *       自动 dispatch → worker 自动接取执行上报 → lead 汇总交付 → 主任务 COMPLETED。
 *
 * 断言(monitor 捕获的事件满足项目自定义协议数据结构):
 *  1. agent.event 事件均为 AgentEvent 五变体(kind 判别 + 字段收窄)
 *  2. task.status 序列覆盖完整生命周期(SUBMITTED→ASSIGNED→WORKING→COMPLETED)
 *  3. task.progress 单调递增至 100
 *  4. artifact 事件存在(子任务成果 + 父 summary)
 *  5. agent.status 捕捉 busy/idle 变化
 *  6. monitor.waitFor/summary 可用
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import { monitorChannel } from '../server/services/workshop/runtime/monitor'
import type { MonitorEvent } from '../server/services/workshop/runtime/monitor'
import type { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import type { AgentEvent } from '../server/services/workshop/agents/agent-interface'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function setup(): { db: DatabaseSync, manager: AgentChannelManager } {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),

    teams: createTeamRepo(db),

    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  return { db, manager }
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): SchedulerLoop {
  // 懒加载时代:先激活 channel(装配 lead 运行时与默认循环),再换成测试配置的循环
  manager.ensureChannelActive(channelId)
  const internals = manager as unknown as { channels: Map<string, ChannelRuntime> }
  const cr = internals.channels.get(channelId)
  if (!cr) throw new Error(`channel runtime 不存在: ${channelId}`)
  cr.scheduler?.stop()
  const lead = cr.getAgents().find(a => a.role === 'lead')
  if (!lead) throw new Error('无 lead')
  const loop = new SchedulerLoop(cr, lead as never, { tickMs })
  cr.scheduler = loop
  loop.start()
  return loop
}

/** AgentEvent 结构校验:五变体判别 + 关键字段类型 */
function isWellFormedAgentEvent(e: AgentEvent): boolean {
  switch (e.kind) {
    case 'status': return typeof e.status.state === 'string' && typeof e.status.timestamp === 'string'
    case 'message': return typeof e.message.messageId === 'string' && Array.isArray(e.message.parts)
    case 'artifact': return typeof e.artifact.artifactId === 'string' && Array.isArray(e.artifact.parts)
    case 'error': return typeof e.error.code === 'string' && typeof e.error.message === 'string'
    case 'done': return e.final === undefined || typeof e.final === 'object'
    default: return false
  }
}

async function main(): Promise<void> {
  console.log('\n=== 端到端监控测试(mock harness 全流程 + 事件流结构) ===')
  const { db, manager } = setup()
  const loops: SchedulerLoop[] = []
  const channels: string[] = []

  try {
    // ---- 1. Channel + Agent 管理 ----
    const ch = await manager.createChannel({
      name: '监控演示频道',
      description: 'e2e monitor',
      leadAgent: { name: 'lead-m', harness: 'mock', config: { delayMs: 60 } },
    })
    channels.push(ch.channelId)
    const w1 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-a', harness: 'mock', config: { delayMs: 60 } })).id, role: 'worker' })
    const w2 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-b', harness: 'mock', config: { delayMs: 60 } })).id, role: 'worker' })
    const agents = await manager.listChannelAgents(ch.channelId)
    check('Channel/Agent 管理: 1 lead + 2 workers', agents.length === 3 && agents.some(a => a.role === 'lead'), `n=${agents.length}`)
    void w1
    void w2

    // ---- 2. monitor 启动(先激活 channel 装配 bus,订阅才有效)----
    manager.ensureChannelActive(ch.channelId)
    const mon = monitorChannel(manager, ch.channelId, { pollMs: 50 })
    const live: string[] = []
    mon.subscribe(e => live.push(e.kind))

    // ---- 3. 提交任务(调度循环自动分发) ----
    loops.push(attachScheduler(manager, ch.channelId, 10))
    const main = await manager.submitChannelTask({ channelId: ch.channelId, title: '监控主任务', description: '完整闭环' })

    const done = await mon.waitUntil(() => {
      const t = (manager as unknown as { getTaskEngine(): { get(id: string): WorkspaceTask | undefined } }).getTaskEngine().get(main.id)
      return t?.state === 'COMPLETED'
    }, 15_000)
    check('任务闭环: 主任务 COMPLETED', done)

    const engine = (manager as unknown as { getTaskEngine(): { list(channelId: string): WorkspaceTask[] } }).getTaskEngine()
    const all = engine.list(ch.channelId)
    const children = all.filter(t => t.parentId === main.id)
    check('Task 分发: 生成子任务且全部完成', children.length >= 1 && children.every(c => c.state === 'COMPLETED' && c.progress === 100), `n=${children.length}`)

    // ---- 4. 事件流结构断言 ----
    const agentEvents = mon.events.filter(e => e.kind === 'agent.event')
    check('agent.event 事件捕获(≥ worker 执行事件)', agentEvents.length >= 3, `n=${agentEvents.length}`)
    check('agent.event 全部满足 AgentEvent 五变体结构', agentEvents.every(e => isWellFormedAgentEvent((e as { event: AgentEvent }).event)))

    const taskStatus = mon.events.filter(e => e.kind === 'task.status') as Extract<MonitorEvent, { kind: 'task.status' }>[]
    const statesOf = (taskId: string) => taskStatus.filter(e => e.taskId === taskId).map(e => e.state)
    const childStates = children.flatMap(c => statesOf(c.id))
    check('task.status: 子任务覆盖 ASSIGNED→WORKING→COMPLETED',
      children.every((c) => {
        const s = statesOf(c.id)
        return s.includes('ASSIGNED') && s.includes('WORKING') && s.includes('COMPLETED')
      }),
      `child states=[${childStates.join(',')}]`)
    const mainStates = statesOf(main.id)
    check('task.status: 主任务生命周期完整', mainStates.includes('SUBMITTED') && mainStates.includes('WAITING') && mainStates.includes('COMPLETED'), `[${mainStates.join('→')}]`)

    const progressEvents = mon.events.filter(e => e.kind === 'task.progress') as Extract<MonitorEvent, { kind: 'task.progress' }>[]
    const progressOf = (taskId: string) => progressEvents.filter(e => e.taskId === taskId).map(e => e.progress)
    const monotonic = children.every((c) => {
      const ps = progressOf(c.id)
      return ps.every((p, i) => i === 0 || p >= ps[i - 1]!) && ps.length > 0
    })
    check('task.progress: 子任务进度单调递增', monotonic, children.map(c => `[${progressOf(c.id).join(',')}]`).join(' '))

    const artifactEvents = agentEvents.filter(e => (e as { event: AgentEvent }).event.kind === 'artifact')
    check('artifact 事件: 子任务成果与父汇总均流出', artifactEvents.length >= children.length + 1, `n=${artifactEvents.length}`)

    const agentStatus = mon.events.filter(e => e.kind === 'agent.status') as Extract<MonitorEvent, { kind: 'agent.status' }>[]
    check('agent.status: 捕捉成员 busy/idle 变化', agentStatus.some(e => e.state === 'busy') && agentStatus.some(e => e.state === 'idle'), `n=${agentStatus.length}`)

    // ---- 5. monitor API 可用性 ----
    const waited = await mon.waitFor(e => e.kind === 'task.status' && e.state === 'COMPLETED' && e.taskId === main.id, 1000)
    check('monitor.waitFor 命中主任务完成事件', waited !== null)
    check('monitor 实时订阅生效', live.includes('agent.event') && live.includes('task.status'), `[${[...new Set(live)].join(',')}]`)

    const sum = mon.summary()
    check('monitor.summary 输出时间线', sum.includes('monitor summary') && sum.includes('task.status'), `${sum.split('\n').length} 行`)

    mon.stop()
    console.log('\n----- monitor 时间线 -----')
    console.log(sum)
    console.log('-------------------------')
  }
  finally {
    for (const loop of loops) loop.stop()
    for (const cid of channels) await manager.removeChannel(cid)
    db.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('监控测试异常:', e)
  process.exit(1)
})
void randomUUID
