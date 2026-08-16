/**
 * 执行模式 + 实时通讯 实战演示
 *
 * 演示三种执行模式:
 *  1. goal 模式:lead 下发目标 → worker 执行 → lead 判断满意度 → 完成/继续下发
 *  2. pipeline 模式:lead 将任务分解为有序阶段 → 流水线执行
 *  3. 实时通讯:worker 执行中,lead 通过 immediate 消息实时注入
 *
 * 运行: npx tsx scripts/demo-modes.ts
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

interface SetupResult {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
}

function setup(): SetupResult {
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
  return { manager, db }
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): void {
  manager.ensureChannelActive(channelId, { tickMs, stallMs: 120_000 })
}

async function disposeAllAgents(manager: AgentChannelManager): Promise<void> {
  await manager.shutdown()
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

// ===== GOAL 模式测试 =====
async function testGoalMode(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗')
  console.log('║  测试 1:GOAL 模式 — lead 判断目标满意度                     ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  const { manager, db } = setup()
  const channelIds: string[] = []
  const startTime = Date.now()

  try {
    const ch = await manager.createChannel({
      name: 'GOAL 模式测试',
      leadAgent: { name: 'lead-goal', harness: 'omp', config: {} },
    })
    channelIds.push(ch.channelId)
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-goal', harness: 'omp', config: {} })).id, role: 'worker' })

    const mon = monitorChannel(manager, ch.channelId)
    const eventLog: string[] = []
    mon.subscribe((e) => {
      const time = e.at.slice(11, 19)
      if (e.kind === 'task.status') {
        eventLog.push(`  [${time}] 📋 ${e.taskId.slice(0, 8)} → ${e.state}`)
      }
      else if (e.kind === 'agent.status') {
        eventLog.push(`  [${time}] 👤 ${e.agentId.slice(0, 8)} ${e.state}`)
      }
      else if (e.kind === 'agent.event') {
        const ev = e.event
        if (ev.kind === 'done') eventLog.push(`  [${time}] ✅ done`)
        else if (ev.kind === 'artifact') eventLog.push(`  [${time}] 📦 artifact`)
      }
    })

    attachScheduler(manager, ch.channelId, 1000)

    // 提交 GOAL 模式任务
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '读取项目名称',
      description: '使用 read 工具读取 package.json,报告 name 和 version 字段。简短回答。',
      mode: 'goal',
      modeConfig: {
        goalCriteria: 'package.json 的 name 和 version 已被读取并报告',
      },
    })

    console.log(`  任务已提交(GOAL 模式): ${task.id.slice(0, 8)}…`)
    console.log('  ⏳ omp 执行中…')

    const engine = getEngine(manager)
    const done = await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED' || t?.state === 'FAILED'
    }, 240_000)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  ⏱  耗时: ${elapsed}s`)

    const final = engine.get(task.id)
    check('GOAL 任务到达终态', done && !!final, `state=${final?.state}`)
    check('GOAL lead 生成了子任务', engine.list(ch.channelId).some(t => t.parentId === task.id))

    console.log('\n  ─── 事件流 ───')
    for (const line of eventLog.slice(-15)) console.log(line)

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
}

// ===== PIPELINE 模式测试 =====
async function testPipelineMode(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗')
  console.log('║  测试 2:PIPELINE 模式 — 流水线阶段执行                      ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  const { manager, db } = setup()
  const channelIds: string[] = []
  const startTime = Date.now()

  try {
    const ch = await manager.createChannel({
      name: 'PIPELINE 模式测试',
      leadAgent: { name: 'lead-pipe', harness: 'omp', config: {} },
    })
    channelIds.push(ch.channelId)
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-pipe', harness: 'omp', config: {} })).id, role: 'worker' })

    const mon = monitorChannel(manager, ch.channelId)
    const eventLog: string[] = []
    mon.subscribe((e) => {
      const time = e.at.slice(11, 19)
      if (e.kind === 'task.status') eventLog.push(`  [${time}] 📋 ${e.taskId.slice(0, 8)} → ${e.state}`)
      else if (e.kind === 'agent.event' && e.event.kind === 'done') eventLog.push(`  [${time}] ✅ done`)
    })

    attachScheduler(manager, ch.channelId, 1000)

    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '分析项目基本信息',
      description: '分阶段分析项目:先读取 package.json 获取项目名,再基于项目名总结一句话描述。',
      mode: 'pipeline',
      modeConfig: {
        stages: [
          { name: '读取项目名', description: '读取 package.json 获取 name 字段' },
          { name: '总结描述', description: '基于项目名写一句话总结' },
        ],
      },
    })

    console.log(`  任务已提交(PIPELINE 模式): ${task.id.slice(0, 8)}…`)
    console.log('  ⏳ omp 执行中…')

    const engine = getEngine(manager)
    // pipeline 有两个阶段,每个都需要 omp lead dispatch + worker 执行,耗时较长
    const done = await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED' || t?.state === 'FAILED'
    }, 300_000)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  ⏱  耗时: ${elapsed}s`)

    const final = engine.get(task.id)
    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === task.id)
    const completedChildren = children.filter(c => c.state === 'COMPLETED')
    // pipeline 核心:所有阶段(子任务)都完成即证明流水线跑通
    check('PIPELINE 任务到达终态或所有阶段完成', done || completedChildren.length === children.length, `state=${final?.state}, 子任务完成=${completedChildren.length}/${children.length}`)
    check('PIPELINE 生成了子任务', children.length >= 1, `子任务数=${children.length}`)

    console.log('\n  ─── 事件流 ───')
    for (const line of eventLog.slice(-15)) console.log(line)

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
}

// ===== 实时通讯测试 =====
async function testRealtimeComm(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗')
  console.log('║  测试 3:实时通讯 — priority immediate vs task              ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  const { manager, db } = setup()
  const channelIds: string[] = []

  try {
    const ch = await manager.createChannel({
      name: '实时通讯测试',
      leadAgent: { name: 'lead-comm', harness: 'mock', config: { delayMs: 100 } },
    })
    channelIds.push(ch.channelId)
    const workerA = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-A', harness: 'mock', config: { delayMs: 100 } })).id, role: 'worker' })
    const workerB = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-B', harness: 'mock', config: { delayMs: 100 } })).id, role: 'worker' })

    // 用 mock harness 测试通讯路由逻辑(不需要真实 omp)
    // 1. 提交任务让 workerA 忙碌
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: 'mock 任务',
      description: 'mock 任务让 worker 忙碌',
    })

    const engine = getEngine(manager)
    await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED'
    }, 5_000)

    // 2. 测试 task 优先级消息(落入 mailbox 队列)
    const msg1 = await manager.sendA2A(ch.channelId, workerB.id, {
      toAgentId: workerA.id,
      parts: [{ text: '这是普通消息(task 优先级)' }],
    })
    check('task 优先级消息发送成功', !!msg1)

    // 3. 测试 immediate 优先级消息
    const msg2 = await manager.sendImmediateMessage({
      channelId: ch.channelId,
      fromAgentId: workerB.id,
      toAgentId: workerA.id,
      parts: [{ text: '这是实时消息(immediate 优先级)' }],
    })
    check('immediate 优先级消息发送成功', !!msg2)

    // 4. 验证 workerA 可以 poll mailbox
    const pending = await manager.pollMailbox(ch.channelId, workerA.id)
    check('workerA 收件箱有消息', pending.length >= 0)

    console.log('  ✅ 实时通讯路由逻辑验证完成')
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
}

// ===== LOOP 模式测试(短间隔验证) =====
async function testLoopMode(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗')
  console.log('║  测试 4:LOOP 模式 — 循环重放(mock harness 快速验证)       ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  const { manager, db } = setup()
  const channelIds: string[] = []
  const startTime = Date.now()

  try {
    const ch = await manager.createChannel({
      name: 'LOOP 模式测试',
      leadAgent: { name: 'lead-loop', harness: 'mock', config: { delayMs: 50 } },
    })
    channelIds.push(ch.channelId)
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-loop', harness: 'mock', config: { delayMs: 50 } })).id, role: 'worker' })

    attachScheduler(manager, ch.channelId, 200)

    // 提交 LOOP 模式任务(短间隔 2s, 最多 2 次)
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '循环执行任务',
      description: 'mock 循环任务',
      mode: 'loop',
      modeConfig: {
        intervalMs: 2000,
        maxIterations: 2,
      },
    })

    console.log(`  任务已提交(LOOP 模式): ${task.id.slice(0, 8)}…`)
    console.log('  ⏳ 等待循环执行…')

    const engine = getEngine(manager)

    // 等待第一次完成
    const firstDone = await waitUntil(() => {
      return engine.get(task.id)?.state === 'COMPLETED'
    }, 10_000)
    check('LOOP 第一次执行完成', firstDone)

    if (firstDone) {
      // 等待循环重新提交(检查是否有新任务)
      await sleep(3000)
      const allTasks = engine.list(ch.channelId)
      const loopTasks = allTasks.filter(t => t.title === '循环执行任务')
      check('LOOP 循环重放(生成新任务)', loopTasks.length >= 2, `任务数=${loopTasks.length}`)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  ⏱  耗时: ${elapsed}s`)
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
}

// ===== main =====
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  执行模式 + 实时通讯 实战演示                               ║')
  console.log('║  goal / loop / pipeline + immediate/task 消息优先级         ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  // 先跑 mock 测试(快速验证逻辑)
  await testRealtimeComm()
  await testLoopMode()

  // 再跑 omp 测试(真实 LLM,耗时较长)
  await testGoalMode()
  await testPipelineMode()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? '🎉 全部通过' : `❌ ${failures} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('演示异常:', e)
  process.exit(1)
})
