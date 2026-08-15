/**
 * Lead-Worker 实战演示 — mock harness 全流程
 *
 * 场景: lead 统筹一个"系统功能开发"任务,分解为 2 个子任务分发给 worker,
 *       worker 各自接取执行,lead 通过 monitor 实时监控团队作业情况。
 *
 * 流程:
 *  1. 创建 Channel(lead + 2 workers, harness=mock, delayMs=200 让进度可观)
 *  2. lead 提交"系统功能开发"主任务
 *  3. SchedulerLoop 驱动 lead 自动分解 dispatch 给 worker
 *  4. worker 自动接取 → reportTask 进度(25→50→75→100)→ completeTask 交付成果
 *  5. lead 汇总子任务成果 → 主任务 COMPLETED
 *  6. 全程 monitor 输出实时事件流
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import { monitorChannel } from '../server/services/workshop/runtime/monitor'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, _label = ''): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}

function setup(): { manager: AgentChannelManager, db: ReturnType<typeof openWorkshopDb> } {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),

    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),

    teams: createTeamRepo(db),

    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  return { manager, db }
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): SchedulerLoop {
  const internals = manager as unknown as { channels: Map<string, { getAgents(): { role: string }[], scheduler: unknown }> }
  const cr = internals.channels.get(channelId)
  if (!cr) throw new Error('channel 不存在')
  const lead = cr.getAgents().find(a => a.role === 'lead')
  if (!lead) throw new Error('无 lead')
  const loop = new SchedulerLoop(cr as never, lead as never, { tickMs })
  cr.scheduler = loop
  loop.start()
  return loop
}

async function main(): Promise<void> {
  console.log('')
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  Lead-Worker 实战演示(mock harness,harness="mock")       ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  const { manager, db } = setup()
  const loops: SchedulerLoop[] = []
  const channelIds: string[] = []

  try {
    // ================================================================
    // Step 1: 创建 Channel + Agent
    // ================================================================
    console.log('\n━━━ Step 1: 创建团队 ━━━')

    const ch = await manager.createChannel({
      name: '系统功能开发组',
      description: 'mock harness 全流程演示',
      leadAgent: {
        name: 'lead-统筹者',
        harness: 'mock',
        config: { delayMs: 200 },
      },
    })
    channelIds.push(ch.channelId)

    const workerA = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-前端', harness: 'mock', config: { delayMs: 200 } })).id, role: 'worker' })
    const workerB = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-后端', harness: 'mock', config: { delayMs: 200 } })).id, role: 'worker' })

    const agents = await manager.listChannelAgents(ch.channelId)
    console.log(`  Channel: ${ch.channelId.slice(0, 8)}… (${ch.data?.name ?? '系统功能开发组'})`)
    console.log(`  Lead:    ${agents.find(a => a.role === 'lead')?.name} (harness=${agents.find(a => a.role === 'lead')?.harness})`)
    console.log(`  Worker1: ${workerA.name} (harness=${workerA.harness})`)
    console.log(`  Worker2: ${workerB.name} (harness=${workerB.harness})`)
    check('团队创建: 1 lead + 2 workers', agents.length === 3)

    // ================================================================
    // Step 2: 启动 monitor(lead 视角的监控)
    // ================================================================
    console.log('\n━━━ Step 2: 启动 monitor ━━━')

    const mon = monitorChannel(manager, ch.channelId)
    const eventLog: string[] = []
    mon.subscribe((e) => {
      const time = e.at.slice(11, 23)
      switch (e.kind) {
        case 'task.status':
          eventLog.push(`  [${time}] 📋 task ${e.taskId.slice(0, 8)} → ${e.state}`)
          break
        case 'task.progress':
          eventLog.push(`  [${time}] 📊 task ${e.taskId.slice(0, 8)} = ${e.progress}%`)
          break
        case 'agent.status':
          eventLog.push(`  [${time}] 👤 agent ${e.agentId.slice(0, 8)} ${e.state}`)
          break
        case 'agent.event': {
          const ev = e.event
          if (ev.kind === 'artifact') eventLog.push(`  [${time}] 📦 artifact from ${e.agentId?.slice(0, 8) ?? '-'}: ${ev.artifact.name ?? ev.artifact.artifactId.slice(0, 8)}`)
          else if (ev.kind === 'done') eventLog.push(`  [${time}] ✅ done from ${e.agentId?.slice(0, 8) ?? '-'}`)
          break
        }
        default: break
      }
    })
    console.log('  monitor 已启动,实时监听 channel 事件流')

    // ================================================================
    // Step 3: 启动 SchedulerLoop + lead 提交主任务
    // ================================================================
    console.log('\n━━━ Step 3: lead 提交主任务 + SchedulerLoop 启动 ━━━')

    loops.push(attachScheduler(manager, ch.channelId, 10))

    const main = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '系统功能开发',
      description: '统筹前后端开发交付',
    })
    console.log(`  主任务已提交: ${main.id.slice(0, 8)}… (state=${main.state}, assignee=lead)`)

    // ================================================================
    // Step 4: 等待调度闭环(lead 分发 → worker 接取 → 执行 → 完成)
    // ================================================================
    console.log('\n━━━ Step 4: 等待调度闭环(SchedulerLoop 自动驱动)━━━')
    console.log('  (mock lead 自动分解任务 → dispatch 给 worker → worker 自动接取执行)')
    console.log('')

    const done = await waitUntil(() => {
      const engine = (manager as unknown as { getTaskEngine(): { get(id: string): WorkspaceTask | undefined } }).getTaskEngine()
      return engine.get(main.id)?.state === 'COMPLETED'
    }, 15_000)

    check('主任务 COMPLETED(lead 汇总交付)', done)

    // ================================================================
    // Step 5: 验证 Task 分发与执行结果
    // ================================================================
    console.log('\n━━━ Step 5: 验证 Task 分发与执行结果 ━━━')

    const engine = (manager as unknown as { getTaskEngine(): { list(channelId: string): WorkspaceTask[] } }).getTaskEngine()
    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === main.id)
    const mainTask = engine.get(main.id)

    check('lead 生成了子任务(分发成功)', children.length >= 1, `子任务数=${children.length}`)
    check('所有子任务均 COMPLETED(worker 真正作业)', children.every(c => c.state === 'COMPLETED' && c.progress === 100), `states=[${children.map(c => `${c.state}(${c.progress}%)`).join(', ')}]`)
    check('子任务各有成果 artifact(worker 交付)', children.every(c => c.artifacts.length > 0), `artifacts=[${children.map(c => c.artifacts.length).join(', ')}]`)
    check('主任务有汇总 artifact(lead 统筹交付)', (mainTask?.artifacts.length ?? 0) > 0, `artifacts=${mainTask?.artifacts.length ?? 0}`)

    // ================================================================
    // Step 6: 验证 worker 订阅与进度可见性
    // ================================================================
    console.log('\n━━━ Step 6: worker 订阅与进度互见验证 ━━━')

    // worker 可以订阅其他同事(含 lead 的产出)
    await manager.subscribe(ch.channelId, workerA.id, { agentIds: [workerB.id] })
    check('worker 订阅同事产出(subscribe 成功)', true)

    // worker 可以查看全 channel 任务(含同事的)
    const tasksFromWorker = await manager.listTasks(ch.channelId, workerA.id)
    check('worker 可见全 channel 任务(进度互见)', tasksFromWorker.length === allTasks.length, `可见=${tasksFromWorker.length}/总=${allTasks.length}`)

    // worker 可查同事具体任务详情(作业内容互见)
    if (children.length >= 2) {
      const detail = await manager.getTask(ch.channelId, workerA.id, children[1]!.id)
      check('worker 可查同事任务详情(含成果)', detail.id === children[1]!.id && detail.artifacts.length > 0)
    }

    // ================================================================
    // Step 7: monitor 事件流验证
    // ================================================================
    console.log('\n━━━ Step 7: monitor 事件流验证 ━━━')

    const taskStatusEvents = mon.events.filter(e => e.kind === 'task.status')
    const agentStatusEvents = mon.events.filter(e => e.kind === 'agent.status')
    const artifactEvents = mon.events.filter(e => e.kind === 'agent.event' && (e as { event: { kind: string } }).event.kind === 'artifact')
    const progressEvents = mon.events.filter(e => e.kind === 'task.progress')

    check('monitor 捕获 task.status 事件', taskStatusEvents.length > 0, `n=${taskStatusEvents.length}`)
    check('monitor 捕获 agent.status(busy/idle)', agentStatusEvents.some(e => (e as { state: string }).state === 'busy') && agentStatusEvents.some(e => (e as { state: string }).state === 'idle'), `n=${agentStatusEvents.length}`)
    check('monitor 捕获 artifact 事件(成果交付)', artifactEvents.length >= 1, `n=${artifactEvents.length}`)
    check('monitor 捕获 task.progress(进度变化)', progressEvents.length >= 1, `n=${progressEvents.length}`)

    // ================================================================
    // 实时事件流输出
    // ================================================================
    console.log('\n━━━ monitor 实时事件流(monitor.subscribe 实时捕获)━━━')
    for (const line of eventLog) {
      console.log(line)
    }

    mon.stop()
  }
  finally {
    for (const loop of loops) loop.stop()
    for (const cid of channelIds) await manager.removeChannel(cid)
    db.close()
  }

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? '🎉 全部通过' : `❌ ${failures} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('演示异常:', e)
  process.exit(1)
})
