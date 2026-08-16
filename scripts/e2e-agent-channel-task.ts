/**
 * 端到端验证:Agent 模板 → Channel → 克隆实例 → 提交任务 → 监控执行过程。
 *
 * 流程:
 *  1. createAgent(name, harness, config)         → 创建 Agent 模板(可复用)
 *  2. createChannel({ name, leadAgent })          → 创建 Channel(内部:lead 模板 + 克隆实例)
 *  3. addAgentToChannel({ channelId, agentId })   → 把 Agent 模板克隆进 Channel(独立身份 id)
 *  4. ensureChannelActive + submitChannelTask      → 提交任务,lead 调度,worker 执行
 *  5. monitorChannel → 实时观察 task.status / task.progress / agent.status / agent.event
 *
 * 运行: npx tsx scripts/e2e-agent-channel-task.ts
 */
import type { DatabaseSync } from 'node:sqlite'
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
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { monitorChannel } from '../server/services/workshop/runtime/monitor'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
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
    },
    implFactory: createAgentImpl,
    db,
  })
}

async function main(): Promise<void> {
  console.log('━━━ 端到端:Agent 模板 → Channel → 任务执行 → 监控 ━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    // ---- 1. 创建 Agent 模板(可复用数据结构)----
    console.log('\n--- 1. 创建 Agent 模板 ---')
    const workerTpl = await manager.createAgent({
      name: 'worker-执行者',
      harness: 'mock',
      config: { delayMs: 60 },
    })
    check('创建 Agent 模板成功', !!workerTpl.id)
    check('模板无 channel 绑定(纯定义)', workerTpl.instances.length === 0)

    // ---- 2. 创建 Channel(带 lead)----
    console.log('\n--- 2. 创建 Channel ---')
    const ch = await manager.createChannel({
      name: '端到端演示频道',
      description: 'Agent 模板复用 → Channel 克隆实例 → 任务监控',
      leadAgent: { name: 'lead-主理人', harness: 'mock', config: { delayMs: 60 } },
    })
    check('创建 Channel 成功', !!ch.channelId && !!ch.leadAgentId)
    check('lead 是独立实例(与 worker 模板 id 不同)', ch.leadAgentId !== workerTpl.id)

    // ---- 3. 把 Agent 模板放入 Channel(克隆独立身份 id)----
    console.log('\n--- 3. Agent 模板放入 Channel(克隆)---')
    const worker = await manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: workerTpl.id,
      role: 'worker',
    })
    check('克隆出独立实例 id(≠ 模板 id)', worker.id !== workerTpl.id, `inst=${worker.id.slice(0, 8)} tpl=${workerTpl.id.slice(0, 8)}`)
    check('实例复制模板 name/harness', worker.name === 'worker-执行者' && worker.harness === 'mock')
    const members = await manager.listChannelAgents(ch.channelId)
    check('Channel 成员 = 1 lead + 1 worker', members.length === 2 && members.some(a => a.role === 'lead') && members.some(a => a.role === 'worker'))

    // ---- 4. 激活 channel + 挂监控 ----
    console.log('\n--- 4. 激活 channel + 挂监控 ---')
    manager.ensureChannelActive(ch.channelId, { tickMs: 50 })
    check('channel 已激活', manager.runtimeStatus().activeChannels.includes(ch.channelId))
    const mon = monitorChannel(manager, ch.channelId)
    check('监控器已启动', mon.events.some(e => e.kind === 'lifecycle'))

    // ---- 5. 提交任务 ----
    console.log('\n--- 5. 提交任务 ---')
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '端到端验证任务',
      description: '从模板创建 Agent → 克隆进 Channel → 执行任务',
    })
    check('任务已提交(SUBMITTED)', !!task.id && task.state === 'SUBMITTED', `state=${task.state}`)

    // ---- 6. 监控执行过程(等待 COMPLETED)----
    console.log('\n--- 6. 监控执行过程 ---')
    const done = await mon.waitFor(e => e.kind === 'task.status' && e.state === 'COMPLETED', 10_000)
    check('任务执行完成(COMPLETED)', done !== null)

    const seenBusy = mon.events.some(e => e.kind === 'agent.status' && e.state === 'busy')
    const seenIdle = mon.events.some(e => e.kind === 'agent.status' && e.state === 'idle')
    const seenAssigned = mon.events.some(e => e.kind === 'task.status' && e.state === 'ASSIGNED')
    const seenWorking = mon.events.some(e => e.kind === 'task.status' && e.state === 'WORKING')
    const seenArtifact = mon.events.some(e => e.kind === 'agent.event' && e.event.kind === 'artifact')
    const seenProgress = mon.events.some(e => e.kind === 'task.progress' && e.progress > 0)
    check('监控到成员 busy → idle 状态流转', seenBusy && seenIdle)
    check('监控到 lead dispatch(ASSIGNED 子任务)', seenAssigned)
    check('监控到任务进入 WORKING', seenWorking)
    check('监控到进度上报(progress > 0)', seenProgress)
    check('监控到产物 artifact 产出', seenArtifact)

    // 终态校验:主任务 COMPLETED + 有汇总成果
    const finalTask = await manager.getTask(ch.channelId, worker.id, task.id)
    check('主任务终态 COMPLETED', finalTask?.state === 'COMPLETED', `state=${finalTask?.state}`)
    check('主任务有成果(artifacts)', (finalTask?.artifacts.length ?? 0) > 0, `n=${finalTask?.artifacts.length}`)

    // ---- 7. 打印监控时间线 ----
    console.log('\n--- 监控时间线 ---')
    console.log(mon.summary())
    mon.stop()
  }
  finally {
    await manager.shutdown()
    db.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
