/**
 * 端到端验证:每个 AgentRuntime 的任务队列管理 + 实时状态追踪 + lead 统一调度分发。
 *
 * 场景 A(用户要求的实际测试):
 *  1. 模拟用户向 channel 连发两个任务需求(submitChannelTask ×2)
 *  2. 观察 lead FIFO 处理外部队列:先提交的任务先分解(dispatch 子任务 createdAt 严格递增)
 *  3. 一轮内两个任务分给两个不同 worker(池化分配,不重复占同一个空闲 worker)
 *  4. worker 接任务 → busy(带 currentTaskId)→ 执行 → 完成后查队列取下一个 → 队列空 → idle
 *  5. 执行中再补两个任务 → 排队等待 → 逐个消化 → 全部完成后 worker idle
 *
 * 场景 B(lead 对 worker 队列的增删改查与调配,走 omp host tool 同款 manager 通道):
 *  - 查:queueViewOf 看 worker 待执行/执行中/已完成
 *  - 改:updateTask 修改排队任务内容,队列投递自动刷新
 *  - 调配:reassignTask 把排队任务迁移到另一 worker,旧 assignee 队列自动清退
 *  - 删:cancelTask 取消排队任务,过期投递作废,worker 永不执行
 *
 * 场景 C(omp rpc 原生集成冒烟):
 *  - 真实 omp 子进程(--mode rpc)注册全部 host tools(含 5 个新增队列管理工具)
 *
 * 运行: npx tsx scripts/e2e-task-queue.ts
 */
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
import { monitorChannel } from '../server/services/workshop/runtime/monitor'
import { HOST_TOOLS } from '../server/services/workshop/agents/omp-agent'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import type { AgentTaskQueueView } from '../server/services/workshop/types/task'

let failures = 0
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

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
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** manager 内部 TaskEngine 访问(与运行时同一实例;ws.ts 同风格类型收窄) */
function engineOf(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): { id: string, title: string, state: string, assigneeId: string, createdAt: string, parentId?: string } | undefined
      list(channelId: string): Array<{ id: string, title: string, state: string, assigneeId: string, createdAt: string, parentId?: string }>
      queueViewOf(channelId: string, agentId: string): AgentTaskQueueView
    }
  }).getTaskEngine()
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(20)
  }
  return pred()
}

/** 场景 A + A2:两任务 FIFO 分发 → 双 worker 执行 → 追加任务排队消化 → 全部完成转空闲 */
async function scenarioDispatchAndDrain(manager: AgentChannelManager): Promise<void> {
  console.log('\n━━━ 场景 A:外部两任务 FIFO 分发 + worker 执行 + 追加排队消化 ━━━')
  const ch = await manager.createChannel({
    name: 'queue-e2e-A',
    leadAgent: { name: 'lead-甲', harness: 'mock', config: { delayMs: 0 } },
  })
  const wTplA = await manager.createAgent({ name: 'worker-A', harness: 'mock', config: { delayMs: 200 } })
  const wTplB = await manager.createAgent({ name: 'worker-B', harness: 'mock', config: { delayMs: 200 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTplA.id, role: 'worker' })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTplB.id, role: 'worker' })

  const members = await manager.listChannelAgents(ch.channelId)
  const workers = members.filter(m => m.role === 'worker')
  const engine = engineOf(manager)

  // 先激活 channel(装配 bus + 调度循环),monitor 才能订阅到实时事件流
  manager.ensureChannelActive(ch.channelId, { tickMs: 50 })
  const mon = monitorChannel(manager, ch.channelId)
  const p1 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务一:统计苹果数', description: '读取 input 文件统计水果' })
  const p2 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务二:汇总会议纪要', description: '汇总 note 文件' })
  console.log(`  用户提交:P1=${p1.id.slice(0, 8)} P2=${p2.id.slice(0, 8)}`)

  // 2. lead FIFO:两个父任务都被分解出子任务
  const childOf = (parentId: string) => engine.list(ch.channelId).find(t => t.parentId === parentId)
  const bothDispatched = await waitUntil(() => !!childOf(p1.id) && !!childOf(p2.id), 10_000)
  check('lead FIFO 处理外部队列:两个任务都被分解分发', bothDispatched)
  const c1 = childOf(p1.id)!
  const c2 = childOf(p2.id)!
  check('FIFO 顺序:先提交的任务子任务先创建', c1.createdAt <= c2.createdAt, `c1@${c1.createdAt.slice(11, 23)} c2@${c2.createdAt.slice(11, 23)}`)

  // 3. 一轮内两个任务去了两个不同 worker(池化分配;若都给同一 worker 则说明分配退化)
  check('一轮内两任务分给不同 worker(最优分配)', c1.assigneeId !== c2.assigneeId, `w=${c1.assigneeId.slice(0, 8)}/${c2.assigneeId.slice(0, 8)}`)

  // 4. 执行中追加两个任务 → 排队,worker 完成当前任务后按 FIFO 消化
  const p3 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务三:整理清单', description: '第三需求' })
  const p4 = await manager.submitChannelTask({ channelId: ch.channelId, title: '任务四:输出报告', description: '第四需求' })
  const allDone = await waitUntil(
    () => [p1, p2, p3, p4].every(p => engine.get(p.id)?.state === 'COMPLETED'),
    30_000,
  )
  check('4 个外部任务全部完成(排队任务被逐个消化)', allDone,
    [p1, p2, p3, p4].map(p => `${p.id.slice(0, 8)}=${engine.get(p.id)?.state}`).join(' '))

  // 5. 每个 worker 内部执行顺序 = 其名下子任务(按 assignee 归属)创建顺序 = FIFO。
  //    过滤按 assignee 而非 transition by:父任务 WAITING→WORKING 的迁移 by=子任务 assignee,
  //    但那是 lead 汇总相位,不是该 worker 的执行相位。
  const workingTasks = mon.events
    .filter((e): e is Extract<typeof e, { taskId: string }> => e.kind === 'task.status' && e.state === 'WORKING')
    .map(e => engine.get(e.taskId))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
  for (const w of workers) {
    const seq = workingTasks.filter(t => t.assigneeId === w.id)
    const fifo = seq.every((t, i) => i === 0 || seq[i - 1]!.createdAt <= t.createdAt)
    check(`worker ${w.name} 执行顺序 FIFO(${seq.length} 个)`, seq.length >= 2 && fifo,
      seq.map(t => t.title.slice(0, 12)).join(' → '))
  }

  // 6. 状态实时追踪:busy 事件带 currentTaskId;全部完成后 worker 空闲且队列空
  const busyWithContext = mon.events.some(e =>
    e.kind === 'agent.status' && e.state === 'busy' && e.currentTaskId != null)
  check('agent.status busy 事件携带 currentTaskId(实时状态追踪)', busyWithContext)

  const workersIdle = await waitUntil(() =>
    workers.every(w => manager.getChannelAgent(w.id)?.runtimeState === 'idle'), 10_000)
  check('队列清空后全部 worker 标记 idle', workersIdle)
  for (const w of workers) {
    const q = engine.queueViewOf(ch.channelId, w.id)
    check(`worker ${w.name} 队列空 + 已完成 ${q.completed.length} 个`, q.queued.length === 0 && !q.current && q.completed.length >= 2)
  }
  mon.stop()
}

/** 场景 B:lead 对 worker 队列的查/改/调配/删(omp host tool 同款 manager 通道) */
async function scenarioQueueCrud(manager: AgentChannelManager): Promise<void> {
  console.log('\n━━━ 场景 B:lead 对 worker 队列的增删改查与调配 ━━━')
  const ch = await manager.createChannel({
    name: 'queue-e2e-B',
    leadAgent: { name: 'lead-乙', harness: 'mock', config: { delayMs: 0 } },
  })
  const wTpl1 = await manager.createAgent({ name: 'worker-甲', harness: 'mock', config: { delayMs: 500 } })
  const wTpl2 = await manager.createAgent({ name: 'worker-乙', harness: 'mock', config: { delayMs: 500 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl1.id, role: 'worker' })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl2.id, role: 'worker' })

  const members = await manager.listChannelAgents(ch.channelId)
  const lead = members.find(m => m.role === 'lead')!
  const [w1, w2] = members.filter(m => m.role === 'worker')
  const engine = engineOf(manager)

  // 激活 channel 装配 bus(不经 submitChannelTask,避免占位任务污染 worker 队列)
  manager.ensureChannelActive(ch.channelId, { tickMs: 50 })
  const mon = monitorChannel(manager, ch.channelId)

  // lead 直接分发(= omp host tool dispatch_task 同款通道):
  // C_a → w1(立即执行),C_b → w1(排队),C_c → w2(立即执行)
  const ca = await manager.dispatchTask(ch.channelId, lead.id, { assigneeId: w1.id, title: 'C_a-首批' })
  const cb = await manager.dispatchTask(ch.channelId, lead.id, { assigneeId: w1.id, title: 'C_b-次批' })
  const cc = await manager.dispatchTask(ch.channelId, lead.id, { assigneeId: w2.id, title: 'C_c-并行' })

  // 查:w1 执行中 C_a、队列 [C_b];w2 执行中 C_c
  await waitUntil(() => engine.get(ca.id)?.state === 'WORKING' && engine.get(cc.id)?.state === 'WORKING', 10_000)
  const q1 = engine.queueViewOf(ch.channelId, w1.id)
  check('查:w1 执行中 C_a + 队列 [C_b]', q1.current?.id === ca.id && q1.queued.map(t => t.id).join() === cb.id)

  // 改:更新排队任务 C_b 内容
  const updated = await manager.updateTask(ch.channelId, lead.id, cb.id, { title: 'C_b-改后内容', description: '改描述' })
  check('改:排队任务标题已更新', updated.title === 'C_b-改后内容' && engine.queueViewOf(ch.channelId, w1.id).queued[0]?.title === 'C_b-改后内容')

  // 调配:C_b 从 w1 迁到 w2;w1 队列清退,w2 队列接收
  const reassigned = await manager.reassignTask(ch.channelId, lead.id, cb.id, w2.id)
  const q1b = engine.queueViewOf(ch.channelId, w1.id)
  const q2b = engine.queueViewOf(ch.channelId, w2.id)
  check('调配:assignee 已换到 w2', reassigned.assigneeId === w2.id && engine.get(cb.id)?.assigneeId === w2.id)
  check('调配:w1 队列已清退', q1b.queued.length === 0 && !q1b.queued.some(t => t.id === cb.id))
  check('调配:w2 队列接收(FIFO 排在当前任务后)', q2b.queued.some(t => t.id === cb.id))

  // 删:向 w2 追加 C_d 后立即取消;过期投递作废
  const cd = await manager.dispatchTask(ch.channelId, lead.id, { assigneeId: w2.id, title: 'C_d-待删' })
  const canceled = await manager.cancelTask(ch.channelId, lead.id, { taskId: cd.id })
  check('删:任务已 CANCELED', canceled.state === 'CANCELED')

  // 终态:C_a/C_c/C_b 完成(调配后 C_b 由 w2 执行),C_d 永不执行
  const settled = await waitUntil(
    () => ['COMPLETED', 'FAILED', 'CANCELED'].includes(engine.get(ca.id)?.state ?? '')
      && ['COMPLETED', 'FAILED', 'CANCELED'].includes(engine.get(cb.id)?.state ?? '')
      && ['COMPLETED', 'FAILED', 'CANCELED'].includes(engine.get(cc.id)?.state ?? ''),
    30_000,
  )
  check('C_a/C_b/C_c 全部完成', settled,
    `C_a=${engine.get(ca.id)?.state} C_b=${engine.get(cb.id)?.state} C_c=${engine.get(cc.id)?.state}`)
  check('调配后的 C_b 由 w2 执行完成', engine.get(cb.id)?.state === 'COMPLETED' && engine.get(cb.id)?.assigneeId === w2.id)
  check('取消的 C_d 未被执行(仍 CANCELED)', engine.get(cd.id)?.state === 'CANCELED')

  // w1 从未执行 C_b(调配后无 WORKING 事件);w2 从未执行 C_d
  const worked = mon.events.filter(e => e.kind === 'task.status' && e.state === 'WORKING')
  check('w1 从未执行已调配走的 C_b', !worked.some(e => (e as { taskId: string }).taskId === cb.id && (e as { agentId?: string }).agentId === w1.id))
  check('w2 从未执行已取消的 C_d', !worked.some(e => (e as { taskId: string }).taskId === cd.id))

  // 过期投递作废:w2 邮箱无 C_d 的 pending 消息
  const msgs = (manager as unknown as {
    deps: { repos: { messages: { listPendingByChannelAgent(chId: string, aId: string): Array<{ taskId: string | null }> } } }
  }).deps.repos.messages.listPendingByChannelAgent(ch.channelId, w2.id)
  check('取消任务的过期投递已作废(无 pending)', !msgs.some(m => m.taskId === cd.id))

  // lead 队列总览(host tool get_queue_overview 同款通道)
  const overview = await manager.queueOverview(ch.channelId, lead.id)
  check('queueOverview 返回全员实时状态', overview.length === 3 && overview.every(s => s.state === 'idle' || s.state === 'busy' || s.state === 'stopped'))
  mon.stop()
}

/** 场景 C:真实 omp rpc 子进程注册全部 host tools(原生集成冒烟,无 LLM 调用) */
async function scenarioOmpRpc(): Promise<void> {
  console.log('\n━━━ 场景 C:omp rpc 原生集成(host tools 注册冒烟)━━━')
  const client = new OmpRpcClient({ command: 'omp' })
  try {
    await client.start()
    const resp = await client.send({ type: 'set_host_tools', tools: HOST_TOOLS })
    check(`omp rpc 就绪 + 注册 ${HOST_TOOLS.length} 个 host tools(含 5 个队列管理工具)`, resp.success === true)
    const names = HOST_TOOLS.map(t => t.name)
    check('新增队列工具均在注册列表', ['get_my_task_queue', 'get_queue_overview', 'reassign_task', 'update_task', 'cancel_task'].every(n => names.includes(n)))
  }
  finally {
    await client.dispose()
  }
}

async function main(): Promise<void> {
  console.log('━━━ AgentRuntime 任务队列管理 + 状态追踪 + lead 调度 端到端 ━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    await scenarioDispatchAndDrain(manager)
    await scenarioQueueCrud(manager)
    await scenarioOmpRpc()
  }
  finally {
    await manager.shutdown()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
