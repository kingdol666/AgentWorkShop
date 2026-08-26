/**
 * E2E:Lead 执行中自主团队管理(成员 创建/更新/删除 + 孤儿任务回收)。
 *
 * 覆盖面:
 *  1. 工具注入按角色差异化:hostToolsForRole(worker 剔除调度/团队管理;lead 全量含新工具)
 *  2. 决策路径:mock lead 首个 supervise tick 发 spawn_agent → SchedulerLoop 执行 → 新成员入册
 *  3. 工具桥路径(与 omp host tool 同源):manager.createTeamMember/updateTeamMember/removeTeamMember
 *     - 权限:worker 调用 → 403;lead 改/删自己 → 400
 *     - 事件:AEP agent.member(op=added/updated/removed,by=lead:<id>)广播
 *  4. 新成员可被调度:queueOverview 可见 → 接收 dispatch → 完成任务
 *  5. 孤儿任务回收:
 *     - 排队中(ASSIGNED)成员被移除 → 任务重派给剩余最短队列成员
 *     - 执行中(WORKING)成员被移除 → 任务 FAILED → 调度循环重试重派 → 最终 COMPLETED
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
import { createUserRepo } from '../server/services/workshop/db/user.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { MemberChangeEvent } from '../server/services/workshop/runtime/agent-runtime'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { hostToolsForRole } from '../server/services/workshop/agents/omp-agent'
import { AppError } from '../server/utils/errors'

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
    await sleep(50)
  }
  return false
}

function setup(): { manager: AgentChannelManager } {
  const db = openWorkshopDb(':memory:')
  const repos = {
    users: createUserRepo(db),
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
  return { manager }
}

async function main(): Promise<void> {
  console.log('== 1. 工具注入按角色差异化 ==')
  {
    const leadTools = hostToolsForRole('lead').map(t => t.name)
    const workerTools = hostToolsForRole('worker').map(t => t.name)
    check('lead 拥有团队管理三工具', ['create_team_agent', 'update_team_agent', 'remove_team_agent'].every(n => leadTools.includes(n)))
    check('worker 无团队管理/派发工具', ['create_team_agent', 'update_team_agent', 'remove_team_agent', 'dispatch_task', 'reassign_task'].every(n => !workerTools.includes(n)))
    check('worker 保留执行/通信/记忆面', ['complete_task', 'report_progress', 'send_message_to_agent', 'search_memory', 'save_memory'].every(n => workerTools.includes(n)))
    check('lead 保留全量(worker 工具不缺)', workerTools.every(n => leadTools.includes(n)), `lead=${leadTools.length} worker=${workerTools.length}`)
  }

  console.log('== 2. 决策路径:lead spawn_agent → 新成员入册 ==')
  const { manager } = setup()
  const memberEvents: MemberChangeEvent[] = []
  const leadConfig = {
    delayMs: 100,
    // mock lead 首个 supervise tick 的团队管理剧本
    teamOps: [
      { kind: 'spawn_agent' as const, name: 'test-writer', harness: 'mock', config: { delayMs: 120 }, reason: '扩容:任务需要专职测试编写' },
    ],
  }
  const { channelId, leadAgentId } = await manager.createChannel({
    name: 'team-mgmt',
    leadAgent: { name: 'lead', harness: 'mock', config: leadConfig },
  })
  manager.subscribeMemberEvents(channelId, e => memberEvents.push(e))
  const w1tpl = await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 120 } })
  await manager.addAgentToChannel({ channelId, agentId: w1tpl.id, role: 'worker' })

  const task = await manager.submitChannelTask({ channelId, title: '交付一个功能', description: '分解并完成' })
  const spawned = await waitUntil(async () => (await manager.listChannelAgents(channelId)).some(a => a.name === 'test-writer'), 10_000)
  check('spawn_agent 决策落地:新成员入册', spawned)
  const spawnEvt = memberEvents.find(e => e.op === 'added' && e.name === 'test-writer')
  check('agent.member(added) 事件广播(by=lead:…)', !!spawnEvt && spawnEvt.by === `lead:${leadAgentId}`, JSON.stringify(spawnEvt ?? null))
  check('新成员为 worker 角色', spawnEvt?.role === 'worker')

  const completed = await waitUntil(async () =>
    (await manager.listTasks(channelId, leadAgentId!)).find(t => t.id === task.id)?.state === 'COMPLETED', 15_000)
  check('主任务在新团队配置下正常完成', completed)

  console.log('== 3. 工具桥路径:createTeamMember/updateTeamMember ==')
  const docWriter = await manager.createTeamMember(channelId, leadAgentId!, {
    name: 'doc-writer',
    harness: 'mock',
    config: { systemPromptPrefix: '你是文档专家', delayMs: 100 },
    reason: '需要文档专员',
  })
  check('createTeamMember 成功返回实例', !!docWriter.id && docWriter.role === 'worker' && docWriter.harness === 'mock')
  const templates = await manager.listAgents()
  check('按需落模板(可复用)', templates.some(t => t.name === 'doc-writer'))
  const renamed = await manager.updateTeamMember(channelId, leadAgentId!, docWriter.id, { name: 'doc-writer-v2', reason: '更名' })
  check('updateTeamMember 改名生效', renamed.name === 'doc-writer-v2')
  const updEvt = memberEvents.find(e => e.op === 'updated' && e.agentId === docWriter.id)
  check('agent.member(updated) 事件广播', !!updEvt && updEvt.name === 'doc-writer-v2')

  console.log('== 4. 权限校验 ==')
  const workers = (await manager.listChannelAgents(channelId)).filter(a => a.role === 'worker')
  const anyWorker = workers[0]!
  let saw403 = false
  try {
    await manager.createTeamMember(channelId, anyWorker.id, { name: 'rogue', harness: 'mock' })
  }
  catch (err) { saw403 = err instanceof AppError && err.status === 403 }
  check('worker 调 createTeamMember → 403', saw403)
  let saw400self = false
  try {
    await manager.removeTeamMember(channelId, leadAgentId!, leadAgentId!)
  }
  catch (err) { saw400self = err instanceof AppError && err.status === 400 }
  check('lead 移除自己 → 400', saw400self)
  let saw400selfUpd = false
  try {
    await manager.updateTeamMember(channelId, leadAgentId!, leadAgentId!, { name: 'x' })
  }
  catch (err) { saw400selfUpd = err instanceof AppError && err.status === 400 }
  check('lead 更新自己 → 400', saw400selfUpd)

  console.log('== 5. 新成员可被调度 ==')
  const testWriter = (await manager.listChannelAgents(channelId)).find(a => a.name === 'test-writer')!
  const overview = await manager.queueOverview(channelId, leadAgentId!)
  check('queueOverview 可见新成员', overview.some(o => o.agentId === testWriter.id))
  // 直接以 lead 身份 dispatch 给新成员(验证完整投递链)
  const directTask = await manager.dispatchTask(channelId, leadAgentId!, {
    assigneeId: testWriter.id,
    title: '编写测试用例',
    parentTaskId: undefined,
    description: '为核心模块编写测试',
  })
  const directDone = await waitUntil(async () => (await manager.getTask(channelId, leadAgentId!, directTask.id)).state === 'COMPLETED', 10_000)
  check('新成员接取并完成任务', directDone)

  console.log('== 6. 孤儿任务回收:排队中(ASSIGNED)成员移除 → 重派 ==')
  // 造一个"排队中"任务:给启用成员连发两个任务(FIFO)——第一个进入 WORKING,
  // 第二个滞留其信箱 ASSIGNED(排队中,未消费)——随后移除成员经回收路径重派。
  // (注:新版有"投递失败补偿",向已禁用成员派发会被 DELIVERY_FAILED 拒绝并回收任务,
  //  因此排队任务只可能存在于"曾可投递但未及消费"的成员队列中)
  const idleTpl = await manager.createAgent({ name: 'idle-queue', harness: 'mock', config: { delayMs: 100 } })
  const idleMember = await manager.addAgentToChannel({ channelId, agentId: idleTpl.id, role: 'worker' })
  await manager.dispatchTask(channelId, leadAgentId!, {
    assigneeId: idleMember.id,
    title: '队列首任务',
    description: '先被消费',
  })
  const queuedTask = await manager.dispatchTask(channelId, leadAgentId!, {
    assigneeId: idleMember.id,
    title: '排队中的任务',
    description: '等待回收',
  })
  await sleep(200)
  const queuedState = (await manager.getTask(channelId, leadAgentId!, queuedTask.id)).state
  check('第二个任务滞留排队(ASSIGNED)', queuedState === 'ASSIGNED', queuedState)
  const recycle = await manager.removeTeamMember(channelId, leadAgentId!, idleMember.id, '清理闲置成员')
  check('removeTeamMember 返回回收任务列表', recycle.recycledTasks.includes(queuedTask.id), JSON.stringify(recycle.recycledTasks))
  const afterTask = await manager.getTask(channelId, leadAgentId!, queuedTask.id)
  check('排队任务已重派给剩余成员', afterTask.assigneeId !== idleMember.id, `→ ${afterTask.assigneeId.slice(0, 8)}`)
  const gone = !(await manager.listChannelAgents(channelId)).some(a => a.id === idleMember.id)
  check('成员已从名册移除', gone)
  const rmEvt = memberEvents.find(e => e.op === 'removed' && e.agentId === idleMember.id)
  check('agent.member(removed) 事件广播(含 reason)', !!rmEvt && rmEvt.reason === '清理闲置成员')
  const recycleDone = await waitUntil(async () => (await manager.getTask(channelId, leadAgentId!, queuedTask.id)).state === 'COMPLETED', 10_000)
  check('重派任务最终完成(工作不丢失)', recycleDone)

  console.log('== 7. 孤儿任务回收:执行中(WORKING)成员移除 → FAILED → 重试 ==')
  const slowTpl = await manager.createAgent({ name: 'slow-worker', harness: 'mock', config: { delayMs: 60_000 } })
  const slowMember = await manager.addAgentToChannel({ channelId, agentId: slowTpl.id, role: 'worker' })
  const workingTask = await manager.dispatchTask(channelId, leadAgentId!, {
    assigneeId: slowMember.id,
    title: '长任务',
    description: '会被中途裁撤',
  })
  const isWorking = await waitUntil(async () => (await manager.getTask(channelId, leadAgentId!, workingTask.id)).state === 'WORKING', 10_000)
  check('慢 worker 进入 WORKING', isWorking)
  const recycle2 = await manager.removeTeamMember(channelId, leadAgentId!, slowMember.id, '执行太慢,裁撤')
  check('执行中任务被回收(转 FAILED 待重试)', recycle2.recycledTasks.includes(workingTask.id))
  const retryDone = await waitUntil(async () =>
    (await manager.getTask(channelId, leadAgentId!, workingTask.id)).state === 'COMPLETED', 15_000)
  const afterRetry = await manager.getTask(channelId, leadAgentId!, workingTask.id)
  check('调度循环重试重派并最终完成(工作不丢失)', retryDone && afterRetry.assigneeId !== slowMember.id, `state=${afterRetry.state}, retry=${afterRetry.retryCount}`)

  await manager.shutdown()
  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err)
  process.exit(1)
})
