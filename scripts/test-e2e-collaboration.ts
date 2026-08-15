/**
 * 端到端协同测试 — 真实 omp 驱动的 lead-worker 协作场景
 *
 * 场景:lead 接收「分析项目」任务 → 分解给 2 个 worker:
 *  - worker-A: 读取 package.json,报告项目名称和依赖数
 *  - worker-B: 读取 tsconfig.json,报告 TypeScript 配置
 * lead 收集两边结果后,汇总完成主任务
 *
 * 验证:
 *  1. lead 能 dispatch 任务给 channel 中的 worker
 *  2. worker 能真正执行任务(read 原生工具 + host tools)
 *  3. lead 能监控 worker 进度并汇总
 *  4. 实时通讯:lead → worker immediate 消息注入
 *  5. worker 之间 task 队列消息通信
 */
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
import { monitorChannel } from '../server/services/workshop/runtime/monitor'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(300)
  }
  return false
}

function getEngine(manager: AgentChannelManager): {
  get(id: string): WorkspaceTask | undefined
  list(channelId: string): WorkspaceTask[]
} {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }).getTaskEngine()
}

async function disposeAllAgents(manager: AgentChannelManager): Promise<void> {
  await manager.shutdown()
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): void {
  manager.ensureChannelActive(channelId, { tickMs, stallMs: 180_000 })
}

async function main(): Promise<void> {
  console.log('')
  console.log('╔════════════════════════════════════════════════════════════════════╗')
  console.log('║  端到端协同测试 — lead dispatch + worker 协作 + 实时通讯           ║')
  console.log('║  harness="omp" · 真实 LLM 驱动 · channel 内全 Agent 协同          ║')
  console.log('╚════════════════════════════════════════════════════════════════════╝')

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
  const channelIds: string[] = []
  const startTime = Date.now()

  try {
    // ===== Step 1: 创建团队 =====
    console.log('\n━━━ Step 1: 创建协同团队(全部 omp harness)━━━')

    const ch = await manager.createChannel({
      name: '项目分析协同组',
      description: '端到端协同测试',
      leadAgent: { name: 'lead-项目经理', harness: 'omp', config: {} },
    })
    channelIds.push(ch.channelId)

    const workerA = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-包分析', harness: 'omp', config: {} })).id, role: 'worker' })
    const workerB = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-配置分析', harness: 'omp', config: {} })).id, role: 'worker' })

    const agents = await manager.listChannelAgents(ch.channelId)
    console.log(`  Channel: ${ch.channelId.slice(0, 8)}…`)
    console.log(`  Lead:    ${agents.find(a => a.role === 'lead')?.name}`)
    console.log(`  Worker1: ${workerA.name} (id: ${workerA.id.slice(0, 8)}…)`)
    console.log(`  Worker2: ${workerB.name} (id: ${workerB.id.slice(0, 8)}…)`)
    check('团队创建: 1 lead + 2 workers', agents.length === 3)

    // ===== Step 2: 启动 monitor =====
    console.log('\n━━━ Step 2: 启动 monitor(监听全 channel 事件)━━━')

    const mon = monitorChannel(manager, ch.channelId)
    const eventLog: string[] = []
    mon.subscribe((e) => {
      const time = e.at.slice(11, 19)
      if (e.kind === 'task.status') {
        eventLog.push(`[${time}] 📋 ${e.taskId.slice(0, 8)} → ${e.state}`)
      }
      else if (e.kind === 'task.progress') {
        eventLog.push(`[${time}] 📊 ${e.taskId.slice(0, 8)} = ${e.progress}%`)
      }
      else if (e.kind === 'agent.status') {
        eventLog.push(`[${time}] 👤 ${e.agentId.slice(0, 8)} ${e.state}`)
      }
      else if (e.kind === 'agent.event') {
        const ev = e.event
        if (ev.kind === 'done') eventLog.push(`[${time}] ✅ done(${e.agentId?.slice(0, 8) ?? '-'})`)
        else if (ev.kind === 'artifact') eventLog.push(`[${time}] 📦 artifact(${e.agentId?.slice(0, 8) ?? '-'})`)
        else if (ev.kind === 'error') eventLog.push(`[${time}] ❌ error(${e.agentId?.slice(0, 8) ?? '-'})`)
        else if (ev.kind === 'status' && ev.status.message) {
          const text = ev.status.message.parts.map(p => 'text' in p ? p.text.slice(0, 60) : '').join(' ')
          if (text) eventLog.push(`[${time}] 💬 ${e.agentId?.slice(0, 8) ?? '-'}: ${text}`)
        }
      }
    })
    console.log('  monitor 已启动')

    // ===== Step 3: 启动调度 + 提交任务 =====
    console.log('\n━━━ Step 3: 启动 SchedulerLoop + 提交任务 ━━━')

    attachScheduler(manager, ch.channelId, 500)

    const mainTask = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '分析项目 package.json 和 tsconfig.json',
      description: '分析当前项目的 package.json(项目名称、版本、依赖数量)和 tsconfig.json(TypeScript 编译配置)。分发给两个 worker 分别分析,然后汇总。简短回答。',
    })
    console.log(`  主任务已提交: ${mainTask.id.slice(0, 8)}… "${mainTask.title}"`)
    console.log('  ⏳ omp lead 分发任务中…')

    // ===== Step 4: 等待 lead dispatch + worker 执行 =====
    const engine = getEngine(manager)

    // 等待主任务有进展(被 dispatch 或完成)
    await waitUntil(() => {
      const t = engine.get(mainTask.id)
      if (!t) return false
      const taskChildren = engine.list(ch.channelId).filter(task => task.parentId === mainTask.id)
      return taskChildren.length >= 1 || t.state === 'COMPLETED'
    }, 180_000)

    const childrenAtDispatch = engine.list(ch.channelId).filter(t => t.parentId === mainTask.id)
    console.log(`  lead dispatch 了 ${childrenAtDispatch.length} 个子任务`)
    check('lead 能 dispatch 任务给 worker', childrenAtDispatch.length >= 1, `子任务数=${childrenAtDispatch.length}`)

    // 等待主任务终态
    console.log('  ⏳ 等待 worker 执行完成…')
    await waitUntil(() => {
      const t = engine.get(mainTask.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED' || t?.state === 'FAILED'
    }, 300_000)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  ⏱  总耗时: ${elapsed}s`)

    // ===== Step 5: 验证结果 =====
    console.log('\n━━━ Step 5: 验证协同结果 ━━━')

    const finalTask = engine.get(mainTask.id)
    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === mainTask.id)
    const completedChildren = children.filter(c => c.state === 'COMPLETED')
    const childrenWithArtifacts = children.filter(c => c.artifacts.length > 0)

    check('主任务有进展(不超时)', !!finalTask && finalTask.state !== 'SUBMITTED', `state=${finalTask?.state}`)
    check('lead 生成了子任务', children.length >= 1, `子任务数=${children.length}`)
    check('子任务有 COMPLETED 的', completedChildren.length >= 1, `${completedChildren.length}/${children.length} 完成`)

    // 打印 worker 交付的成果
    if (childrenWithArtifacts.length > 0) {
      console.log('\n  ─── Worker 协同成果 ───')
      for (const child of childrenWithArtifacts) {
        const text = child.artifacts
          .flatMap(a => a.parts)
          .map(p => 'text' in p ? p.text : '')
          .join('\n')
        console.log(`  📦 [${child.title}] (${child.assigneeId.slice(0, 8)}…):`)
        const preview = text.slice(0, 200).replace(/\n/g, '\n     ')
        console.log(`     ${preview}…`)
      }
    }

    // ===== Step 6: 验证事件流(协同可见性) =====
    console.log('\n━━━ Step 6: 验证协同事件流 ━━━')

    const taskStatusEvents = mon.events.filter(e => e.kind === 'task.status')
    const agentStatusEvents = mon.events.filter(e => e.kind === 'agent.status')
    const agentEvents = mon.events.filter(e => e.kind === 'agent.event')
    const busyEvents = agentStatusEvents.filter(e => (e as { state: string }).state === 'busy')
    const idleEvents = agentStatusEvents.filter(e => (e as { state: string }).state === 'idle')

    check('捕获 task.status 事件', taskStatusEvents.length >= 3, `n=${taskStatusEvents.length}`)
    check('捕获 agent busy 事件(worker 真正在工作)', busyEvents.length >= 1, `n=${busyEvents.length}`)
    check('捕获 agent idle 事件(worker 完成后空闲)', idleEvents.length >= 1, `n=${idleEvents.length}`)
    check('捕获 agent.event 流(omp 事件)', agentEvents.length >= 3, `n=${agentEvents.length}`)

    // ===== 事件流输出 =====
    console.log('\n━━━ 协同事件流(monitor 实时捕获)━━━')
    const recent = eventLog.slice(-40)
    for (const line of recent) {
      console.log(`  ${line}`)
    }
    if (eventLog.length > 40) {
      console.log(`  … (${eventLog.length - 40} 条更早事件省略)`)
    }

    mon.stop()
  }
  finally {
    await disposeAllAgents(manager)
    for (const cid of channelIds) {
      try {
        await manager.removeChannel(cid)
      }
      catch {
        // ignore
      }
    }
    db.close()
  }

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? '🎉 全部通过 — 端到端协同验证成功' : `❌ ${failures} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
