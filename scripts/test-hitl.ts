/**
 * HITL 与成员生命周期 mock 测试:
 *  A. lead 创建团队成员 → 立即装配进 channel 运行时 + DB 同步(无需等首次投递)
 *  B. lead 移除团队成员 → 运行时卸载 + DB 成员行删除 + 一次性模板连带删除
 *  C. 每个 AgentRuntime 独立 stop(HITL 中断):成员保留、可重新装配、lead 停止后自动重激活
 *  D. 任务 HITL:用户可取消(lead/worker 任务均可)+ 重试 FAILED 任务
 *
 * 运行: npx tsx scripts/test-hitl.ts
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
import type { WorkspaceTask } from '../server/services/workshop/types/task'
import type { SupervisionDecision } from '../server/services/workshop/agents/agent-interface'

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
    await sleep(40)
  }
  return false
}

interface Harness {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
}

function setup(): Harness {
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

function getEngine(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
      transition(taskId: string, state: string, by: string): WorkspaceTask
    }
  }).getTaskEngine()
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs = 50): void {
  manager.ensureChannelActive(channelId, { tickMs, stallMs: 60_000 })
}

async function cleanup(h: Harness): Promise<void> {
  await h.manager.shutdown()
  h.db.close()
}

// ===== A. lead 建员:立即装配 + DB 同步 =====
async function testLeadSpawnWiresMember(): Promise<void> {
  console.log('\n━━━ A. lead 创建成员 → 立即装配 + DB 同步(mock)━━━')

  const h = setup()
  try {
    const spawn: SupervisionDecision = {
      kind: 'spawn_agent',
      name: 'w2',
      harness: 'mock',
      config: { delayMs: 20 },
      reason: 'lead 扩容测试',
    }
    const ch = await h.manager.createChannel({
      name: '建员装配测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20, teamOps: [spawn] } },
    })
    await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)

    // 首个 supervise tick 触发 spawn_agent → 新成员落库
    const spawned = await waitUntil(async () => {
      const members = await h.manager.listChannelAgents(ch.channelId)
      return members.some(m => m.name === 'w2')
    }, 5000)
    check('lead spawn_agent 后成员落库(channel_agents 行)', spawned)

    const w2 = (await h.manager.listChannelAgents(ch.channelId)).find(m => m.name === 'w2')
    check('DB 成员行包含 w2', !!w2, w2 ? `id=${w2.id.slice(0, 8)}` : '')
    const w2Detail = w2 ? h.manager.getChannelAgent(w2.id) : undefined
    check('新成员已装配(立即 wire,无需首次投递)', w2Detail?.wired === true, `wired=${w2Detail?.wired}`)

    // 装配后即可被调度:提交 2 个任务,w2 应实际执行到至少一个
    const engine = getEngine(h.manager)
    const t1 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '任务A' })
    const t2 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '任务B' })
    const allDone = await waitUntil(() =>
      engine.get(t1.id)?.state === 'COMPLETED' && engine.get(t2.id)?.state === 'COMPLETED', 15_000)
    check('装配成员可正常承接任务(全部完成)', allDone)
    const children = engine.list(ch.channelId).filter(t => t.parentId && (t.parentId === t1.id || t.parentId === t2.id))
    const byW2 = children.filter(t => t.assigneeId === w2?.id)
    check('w2 实际执行了任务', byW2.length >= 1, `w2 执行 ${byW2.length}/${children.length}`)
  }
  finally {
    await cleanup(h)
  }
}

// ===== B. lead 删员:运行时卸载 + DB 删除(成员行 + 一次性模板) =====
async function testLeadRemoveUnloadsAndDeletes(): Promise<void> {
  console.log('\n━━━ B. lead 移除成员 → 卸载运行时 + 删除数据库信息(mock)━━━')

  const h = setup()
  try {
    const spawn: SupervisionDecision = {
      kind: 'spawn_agent',
      name: 'w2',
      harness: 'mock',
      config: { delayMs: 20 },
      reason: '扩容',
    }
    const ch = await h.manager.createChannel({
      name: '删员卸载测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20, teamOps: [spawn] } },
    })
    const w1 = await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)

    await waitUntil(async () => (await h.manager.listChannelAgents(ch.channelId)).some(m => m.name === 'w2'), 5000)
    const w2 = (await h.manager.listChannelAgents(ch.channelId)).find(m => m.name === 'w2')!
    // templateId 不经 AgentInfo 暴露,测试直接查库
    const row = h.db.prepare('SELECT template_id AS templateId FROM channel_agents WHERE id = ?').get(w2.id) as { templateId: string } | undefined
    const templateId = row?.templateId ?? ''
    check('w2 模板存在(删除前)', !!templateId && !!h.manager.getAgent(templateId), templateId ? '' : '模板 id 缺失')

    // 等 w2 完成装配
    await waitUntil(() => h.manager.getChannelAgent(w2.id)?.wired === true, 5000)

    // 模拟 lead remove_agent 决策路径(与 SchedulerLoop.execute remove 同源)
    const lead = (await h.manager.listChannelAgents(ch.channelId)).find(m => m.role === 'lead')!
    const result = await h.manager.removeTeamMember(ch.channelId, lead.id, w2.id, 'HITL 测试裁撤')
    check('移除返回回收任务列表(无在途)', Array.isArray(result.recycledTasks))

    const members = await h.manager.listChannelAgents(ch.channelId)
    check('成员行已删除(DB)', !members.some(m => m.id === w2.id), `剩余 ${members.length} 人`)
    check('运行时已卸载(wired=false/无 runtime)', h.manager.getChannelAgent(w2.id) === undefined)
    check('一次性模板已连带删除(DB)', h.manager.getAgent(templateId) === undefined)

    // 剩余成员仍可正常执行(等一轮调度快照稳定,避开删员与决策竞态窗口)
    await sleep(250)
    const engine = getEngine(h.manager)
    const t = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '删员后任务' })
    const done = await waitUntil(() => engine.get(t.id)?.state === 'COMPLETED', 15_000)
    // 根任务 assignee 恒为 lead;校验实际执行的是剩余 worker w1
    const child = engine.list(ch.channelId).find(c => c.parentId === t.id)
    check('删员后 channel 仍可正常执行', done && child?.assigneeId === w1.id,
      `state=${engine.get(t.id)?.state} child=${child?.assigneeId.slice(0, 8)}`)
  }
  finally {
    await cleanup(h)
  }
}

// ===== C. 每个 AgentRuntime 独立 stop(HITL 中断) =====
async function testStopAgentRuntime(): Promise<void> {
  console.log('\n━━━ C. AgentRuntime 独立 stop(HITL 中断,mock)━━━')

  const h = setup()
  try {
    const ch = await h.manager.createChannel({
      name: '停止运行时测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20 } },
    })
    const w1 = await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 30 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)
    const engine = getEngine(h.manager)

    // worker 忙时 HITL stop
    await h.manager.submitChannelTask({ channelId: ch.channelId, title: '停止测试任务1' })
    await waitUntil(() => h.manager.getChannelAgent(w1.id)?.runtimeState === 'busy', 8000)
    const stopped = await h.manager.stopAgentRuntime(ch.channelId, w1.id, 'test')
    check('stopAgentRuntime 返回成功', stopped.stopped === true)
    check('worker 运行时已卸载(detached)', h.manager.getChannelAgent(w1.id)?.wired === false
    || h.manager.getChannelAgent(w1.id) === undefined)
    const members = await h.manager.listChannelAgents(ch.channelId)
    check('worker 成员行保留(interrupt 语义)', members.some(m => m.id === w1.id))

    // 中断后可重新装配执行新任务
    const t2 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '停止后重装任务' })
    const done2 = await waitUntil(() => engine.get(t2.id)?.state === 'COMPLETED', 15_000)
    check('stop 后新任务自动重新装配并完成', done2, `state=${engine.get(t2.id)?.state}`)

    // lead 停止:调度器随停;下次提交自动重激活
    const lead = (await h.manager.listChannelAgents(ch.channelId)).find(m => m.role === 'lead')!
    await h.manager.stopAgentRuntime(ch.channelId, lead.id, 'test')
    const cr = (h.manager as unknown as { channels: Map<string, { scheduler: unknown }> }).channels.get(ch.channelId)
    check('lead 停止后调度器已停', cr?.scheduler === null || cr?.scheduler === undefined)

    const t3 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: 'lead 重启后任务' })
    const done3 = await waitUntil(() => engine.get(t3.id)?.state === 'COMPLETED', 20_000)
    check('lead 停止后提交任务自动重激活并完成', done3, `state=${engine.get(t3.id)?.state}`)
  }
  finally {
    await cleanup(h)
  }
}

// ===== D. 任务 HITL:取消 + 重试(lead 根任务 / worker 子任务均可) =====
async function testTaskHITL(): Promise<void> {
  console.log('\n━━━ D. 任务 HITL:用户取消 / 重试(mock)━━━')

  const h = setup()
  try {
    const ch = await h.manager.createChannel({
      name: '任务HITL测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20 } },
    })
    // 慢 worker:拉开 HITL 操作时间窗,防任务在操作前自然完成(300ms×3 进度 ≈ 1s 一轮)
    const w1 = await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 300 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)
    const engine = getEngine(h.manager)
    const lead = (await h.manager.listChannelAgents(ch.channelId)).find(m => m.role === 'lead')!

    // 1. lead 根任务取消(HITL):提交后立即取消(SUBMITTED/WORKING/WAITING 均合法,1s 内不会完成)
    const t1 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '根任务可取消' })
    await sleep(150) // 等 lead 接取/派发(快照稳定)
    const canceledRoot = await h.manager.cancelTask(ch.channelId, lead.id, { taskId: t1.id })
    check('lead 根任务可被用户取消', canceledRoot.state === 'CANCELED', `state=${canceledRoot.state}`)

    // 2. worker 子任务取消(HITL):子任务执行中取消
    const t2 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '子任务可取消' })
    const child2 = await waitChildOf(h, engine, ch.channelId, t2.id)
    check('子任务已派发并执行(测试前置)', !!child2 && child2?.state === 'WORKING', `state=${child2?.state}`)
    const canceledChild = await h.manager.cancelTask(ch.channelId, lead.id, { taskId: child2!.id })
    check('worker 子任务可被用户取消', canceledChild.state === 'CANCELED', `state=${canceledChild.state}`)

    // 3. FAILED 任务重试(HITL):子任务置 FAILED 后经 retryTask 恢复执行
    const t3 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '可重试任务' })
    const child3 = await waitChildOf(h, engine, ch.channelId, t3.id)
    check('重试目标已派发(测试前置)', !!child3)
    engine.transition(child3!.id, 'FAILED', lead.id)
    check('任务已置 FAILED(测试前置)', engine.get(child3!.id)?.state === 'FAILED')
    const retried = await h.manager.retryTask(ch.channelId, lead.id, child3!.id)
    check('retryTask 重新指派(FAILED→ASSIGNED)', retried.state === 'ASSIGNED', `state=${retried.state} assignee=${retried.assigneeId === w1.id ? 'w1' : retried.assigneeId.slice(0, 8)}`)
    const done = await waitUntil(() => engine.get(child3!.id)?.state === 'COMPLETED', 15_000)
    check('重试后任务正常完成', done, `state=${engine.get(child3!.id)?.state}`)

    // 4. 非 FAILED 重试拒绝
    let rejected = false
    try {
      await h.manager.retryTask(ch.channelId, lead.id, child3!.id)
    }
    catch {
      rejected = true
    }
    check('非 FAILED 任务重试被拒绝(400)', rejected)

    // 5. 无可用 worker 时重试拒绝(移除全部 worker 后)
    const t4 = await h.manager.submitChannelTask({ channelId: ch.channelId, title: '无人重试任务' })
    const child4 = await waitChildOf(h, engine, ch.channelId, t4.id)
    if (child4) engine.transition(child4.id, 'FAILED', lead.id)
    else engine.transition(t4.id, 'FAILED', lead.id)
    const allWorkers = (await h.manager.listChannelAgents(ch.channelId)).filter(m => m.role === 'worker')
    for (const w of allWorkers) {
      await h.manager.removeTeamMember(ch.channelId, lead.id, w.id, '移除全部 worker')
    }
    const failedId = child4?.id ?? t4.id
    let noWorker = false
    try {
      await h.manager.retryTask(ch.channelId, lead.id, failedId)
    }
    catch {
      noWorker = true
    }
    check('无可用 worker 时重试返回 NO_WORKER', noWorker)
  }
  finally {
    await cleanup(h)
  }
}

/** 等待根任务派发出子任务(返回子任务;超时返回 undefined) */
async function waitChildOf(
  h: Harness,
  engine: ReturnType<typeof getEngine>,
  channelId: string,
  rootId: string,
  timeoutMs = 8000,
): Promise<WorkspaceTask | undefined> {
  let child: WorkspaceTask | undefined
  await waitUntil(() => {
    child = engine.list(channelId).find(t => t.parentId === rootId && t.state !== 'COMPLETED' && t.state !== 'CANCELED')
    return !!child
  }, timeoutMs)
  return child
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  HITL 与成员生命周期验证(mock):建员装配/删员卸载/独立stop/任务控制  ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  await testLeadSpawnWiresMember()
  await testLeadRemoveUnloadsAndDeletes()
  await testStopAgentRuntime()
  await testTaskHITL()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
