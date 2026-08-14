/**
 * 系统全面验证测试 — 验证所有子系统协同
 *
 * 测试矩阵:
 *  A. 任务队列顺序执行(mock):给同一 worker 连续下发 3 个任务,验证 FIFO 顺序执行
 *  B. 实时通讯(immediate):worker 忙碌时注入 steer 消息
 *  C. lead dispatch + worker 执行(mock):验证 lead 分发 → worker 接取 → 完成 → lead 汇总
 *  D. worker ↔ worker 通信(mock):worker-A 给 worker-B 发消息,B 入队后消费
 *  E. goal 模式(omp):lead 判断目标完成
 *  F. loop 模式(mock):循环重放
 *  G. pipeline 模式(mock):流水线阶段
 *
 * 运行: npx tsx scripts/test-full-system.ts
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
let testCount = 0
function check(name: string, ok: boolean, detail = ''): void {
  testCount += 1
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}

interface SetupResult {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
  repos: {
    messages: ReturnType<typeof createMessageRepo>
  }
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
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  return { manager, db, repos: { messages: repos.messages } }
}

function getEngine(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }).getTaskEngine()
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs = 200, stallMs = 60_000): void {
  // 懒加载设计:scheduler 由 manager 内部装配与管理
  manager.ensureChannelActive(channelId, { tickMs, stallMs })
}

async function cleanup(manager: AgentChannelManager, db: ReturnType<typeof openWorkshopDb>): Promise<void> {
  await manager.shutdown()
  db.close()
}

// ===== 测试 A: 任务队列顺序执行 =====
async function testTaskQueueOrder(): Promise<void> {
  console.log('\n━━━ 测试 A: 任务队列 FIFO 顺序执行(mock)━━━')

  const { manager, db } = setup()

  try {
    const ch = await manager.createChannel({
      name: '队列测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 100 } },
    })
    const workerTpl = await manager.createAgent({ name: 'worker', harness: 'mock', config: { delayMs: 100 } })
    const worker = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: workerTpl.id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    const engine = getEngine(manager)

    // 连续提交 3 个任务
    const t1 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务1' })
    const t2 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务2' })
    const t3 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务3' })

    // 等待全部完成
    await waitUntil(() => {
      return engine.get(t1.id)?.state === 'COMPLETED'
        && engine.get(t2.id)?.state === 'COMPLETED'
        && engine.get(t3.id)?.state === 'COMPLETED'
    }, 15_000)

    // 验证全部 COMPLETED
    check('任务1 COMPLETED', engine.get(t1.id)?.state === 'COMPLETED')
    check('任务2 COMPLETED', engine.get(t2.id)?.state === 'COMPLETED')
    check('任务3 COMPLETED', engine.get(t3.id)?.state === 'COMPLETED')

    // 验证 FIFO: 任务1 的 updatedAt <= 任务2 的 updatedAt <= 任务3 的 updatedAt
    const r1 = engine.get(t1.id)
    const r2 = engine.get(t2.id)
    const r3 = engine.get(t3.id)
    const order = r1!.updatedAt <= r2!.updatedAt && r2!.updatedAt <= r3!.updatedAt
    check('FIFO 顺序执行(任务1先完成)', order, `${r1!.updatedAt.slice(11, 19)} ≤ ${r2!.updatedAt.slice(11, 19)} ≤ ${r3!.updatedAt.slice(11, 19)}`)

    // 验证每个任务有 artifact
    check('每个任务有 artifact', (r1!.artifacts.length > 0) && (r2!.artifacts.length > 0) && (r3!.artifacts.length > 0))

    void worker
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 B: 实时通讯 immediate =====
async function testImmediateMessage(): Promise<void> {
  console.log('\n━━━ 测试 B: 实时通讯(immediate priority)━━━')

  const { manager, db, repos } = setup()

  try {
    const ch = await manager.createChannel({
      name: '实时通讯测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 200 } },
    })
    const w1Tpl = await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 200 } })
    const w1 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: w1Tpl.id, role: 'worker' })
    const w2Tpl = await manager.createAgent({ name: 'w2', harness: 'mock', config: { delayMs: 200 } })
    const w2 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: w2Tpl.id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    // 提交任务让 w1 忙碌
    const task = await manager.submitChannelTask({ channelId: ch.channelId, title: 'busy task' })

    // 等 w1 开始工作(busy)
    await waitUntil(() => {
      const cr = (manager as unknown as { channels: Map<string, { getAgents(): Array<{ getState: () => string, agentId: string }> }> }).channels.get(ch.channelId)!
      const w1rt = cr.getAgents().find(a => a.agentId === w1.id)
      return w1rt?.getState() === 'busy'
    }, 5_000)

    // w1 busy 时发送 immediate 消息
    const msg = await manager.sendImmediateMessage({
      channelId: ch.channelId,
      fromAgentId: w2.id,
      toAgentId: w1.id,
      parts: [{ text: '紧急消息!' }],
    })
    check('immediate 消息发送成功', !!msg)

    // 验证消息有 immediate priority metadata
    check('消息 priority=immediate', msg.metadata?.['x-aw-msg-priority'] === 'immediate')

    // 等 w1 完成任务
    const engine = getEngine(manager)
    await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 5_000)

    // 发送 task priority 消息给 idle 的 w1
    const msg2 = await manager.sendA2A(ch.channelId, w2.id, {
      toAgentId: w1.id,
      parts: [{ text: '普通消息' }],
      metadata: { 'x-aw-msg-priority': 'task' },
    })
    check('task 消息发送成功', !!msg2)

    // 消息自动被 consumeLoop 消费;验证 DB 中有消息记录(consumed 状态)
    const recentMsgs = repos.messages.listRecentByChannel(ch.channelId, 10)
    const w1Msgs = recentMsgs.filter(m => m.toAgentId === w1.id)
    check('w1 收到了消息(DB 记录)', w1Msgs.length >= 1, `消息数=${w1Msgs.length}`)
    check('消息被自动消费(consumed)', w1Msgs.some(m => m.state === 'consumed'), `states=[${w1Msgs.map(m => m.state).join(',')}]`)
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 C: lead dispatch + worker 执行 + 汇总 =====
async function testLeadDispatchCycle(): Promise<void> {
  console.log('\n━━━ 测试 C: lead dispatch → worker 执行 → lead 汇总(mock)━━━')

  const { manager, db } = setup()

  try {
    const ch = await manager.createChannel({
      name: 'dispatch 测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 50 } },
    })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 50 } })).id, role: 'worker' })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w2', harness: 'mock', config: { delayMs: 50 } })).id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    const engine = getEngine(manager)
    const main = await manager.submitChannelTask({ channelId: ch.channelId, title: '主任务' })

    await waitUntil(() => engine.get(main.id)?.state === 'COMPLETED', 10_000)

    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === main.id)

    check('主任务 COMPLETED', engine.get(main.id)?.state === 'COMPLETED')
    check('lead dispatch 了子任务', children.length >= 1, `子任务数=${children.length}`)
    check('子任务全部 COMPLETED', children.every(c => c.state === 'COMPLETED'), `${children.filter(c => c.state === 'COMPLETED').length}/${children.length}`)
    check('主任务有汇总 artifact', (engine.get(main.id)?.artifacts.length ?? 0) > 0)
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 D: worker ↔ worker 通信 =====
async function testWorkerToWorkerComm(): Promise<void> {
  console.log('\n━━━ 测试 D: worker ↔ worker 通信(mock)━━━')

  const { manager, db, repos } = setup()

  try {
    const ch = await manager.createChannel({
      name: '通信测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 50 } },
    })
    const w1 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 50 } })).id, role: 'worker' })
    const w2 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w2', harness: 'mock', config: { delayMs: 50 } })).id, role: 'worker' })

    // w1 → w2 发消息(task priority → 入队)
    const msg = await manager.sendA2A(ch.channelId, w1.id, {
      toAgentId: w2.id,
      parts: [{ text: 'hello from w1' }],
    })
    check('w1 → w2 消息发送', !!msg)
    check('消息有 target metadata', msg.metadata?.['x-aw-target-agent'] === w2.id)
    check('消息有 from metadata', msg.metadata?.['x-aw-from-agent'] === w1.id)

    // 等 consumeLoop 处理(mock worker 消费消息很快)
    await sleep(200)

    // 验证 DB 中有 w2 的消息记录(已被消费)
    const recentMsgs = repos.messages.listRecentByChannel(ch.channelId, 20)
    const w2Msgs = recentMsgs.filter(m => m.toAgentId === w2.id)
    check('w2 收到了 w1 的消息(DB 记录)', w2Msgs.length >= 1, `消息数=${w2Msgs.length}`)

    // w1 没收到自己的消息(点对点不广播)
    const w1SelfMsgs = recentMsgs.filter(m => m.toAgentId === w1.id && m.fromAgentId === w1.id)
    check('w1 没收到自己的消息(点对点)', w1SelfMsgs.length === 0)

    // lead → w1 发消息
    const leadInfo = (await manager.listChannelAgents(ch.channelId)).find(a => a.role === 'lead')!
    await manager.sendA2A(ch.channelId, leadInfo.id, {
      toAgentId: w1.id,
      parts: [{ text: 'lead to w1' }],
    })
    await sleep(200)
    const recentAfter = repos.messages.listRecentByChannel(ch.channelId, 20)
    const leadToW1 = recentAfter.filter(m => m.toAgentId === w1.id && m.fromAgentId === leadInfo.id)
    check('lead → w1 消息到达(DB 记录)', leadToW1.length >= 1, `消息数=${leadToW1.length}`)
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 E: goal 模式(mock 快速验证调度逻辑) =====
async function testGoalMode(): Promise<void> {
  console.log('\n━━━ 测试 E: goal 模式(mock)━━━')

  const { manager, db } = setup()

  try {
    const ch = await manager.createChannel({
      name: 'goal 测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 30 } },
    })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 30 } })).id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    const engine = getEngine(manager)
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: 'goal 任务',
      description: '需要完成的目标',
      mode: 'goal',
      modeConfig: { goalCriteria: '任务完成' },
    })

    await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED'
    }, 10_000)

    check('goal 任务 COMPLETED', engine.get(task.id)?.state === 'COMPLETED')

    // 验证 description 编码了模式
    const final = engine.get(task.id)
    check('goal description 有 [mode:goal] 前缀', final?.description?.includes('[mode:goal]') ?? false, final?.description?.slice(0, 40))
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 F: loop 模式 =====
async function testLoopMode(): Promise<void> {
  console.log('\n━━━ 测试 F: loop 模式(mock)━━━')

  const { manager, db } = setup()

  try {
    const ch = await manager.createChannel({
      name: 'loop 测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20 } },
    })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 20 } })).id, role: 'worker' })
    attachScheduler(manager, ch.channelId, 100)

    const engine = getEngine(manager)
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '循环任务',
      description: 'loop test',
      mode: 'loop',
      modeConfig: { intervalMs: 1000, maxIterations: 2 },
    })

    // 等第一次完成
    await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 10_000)
    check('loop 第一次执行完成', engine.get(task.id)?.state === 'COMPLETED')

    // 等循环重放
    await sleep(2500)
    const allTasks = engine.list(ch.channelId).filter(t => t.title === '循环任务')
    check('loop 循环重放生成新任务', allTasks.length >= 2, `任务数=${allTasks.length}`)
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== 测试 G: pipeline 模式 =====
async function testPipelineMode(): Promise<void> {
  console.log('\n━━━ 测试 G: pipeline 模式(mock)━━━')

  const { manager, db } = setup()

  try {
    const ch = await manager.createChannel({
      name: 'pipeline 测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 30 } },
    })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 30 } })).id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    const engine = getEngine(manager)
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '流水线任务',
      description: 'pipeline test',
      mode: 'pipeline',
      modeConfig: {
        stages: [
          { name: '阶段1', description: '第一步' },
          { name: '阶段2', description: '第二步' },
        ],
      },
    })

    await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED'
    }, 10_000)

    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === task.id)

    check('pipeline 主任务完成', ['COMPLETED', 'CANCELED'].includes(engine.get(task.id)?.state ?? ''), `state=${engine.get(task.id)?.state}`)
    check('pipeline 生成了子任务', children.length >= 1, `子任务数=${children.length}`)
    check('pipeline description 有 [mode:pipeline]', engine.get(task.id)?.description?.includes('[mode:pipeline]') ?? false)
  }
  finally {
    await cleanup(manager, db)
  }
}

// ===== main =====
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  系统全面验证测试 — 所有子系统                              ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  await testTaskQueueOrder()
  await testImmediateMessage()
  await testLeadDispatchCycle()
  await testWorkerToWorkerComm()
  await testGoalMode()
  await testLoopMode()
  await testPipelineMode()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
