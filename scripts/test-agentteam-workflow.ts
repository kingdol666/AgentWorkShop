/**
 * AgentTeam 作业流程契约测试 —— Leader 三态分流 / 顺序 / 验收 / 群聊升级 / 群聊并行。
 *
 * 用**真实 manager**(真 channel/真 TaskEngine/真 ChannelRuntime/真 SchedulerLoop/真群聊层,
 * 只有 harness 是确定性 mock)验证用户要求的作业逻辑,而不是验证桩件:
 *
 *   A. 简单任务:Leader **自己直接作答**并完成根任务 → 不得产生任何子任务、worker 零执行。
 *   B. 专业任务:Leader 拆解 → 每个子任务带**验收标准**派发给 worker → worker 完工**只是提交**,
 *      父任务在验收前**不得**变成 COMPLETED → Leader 验收后按**计划顺序**产出验收摘要并收口。
 *   C. 群聊请求升级(本轮补齐的能力):Leader 在群聊回合内可把一次人类请求登记为**可追踪根任务**
 *      (submit_task),再对该根任务拆解派发、逐项验收 —— 在此之前 dispatch_task 强制要求
 *      parent_task_id,Lead 无法从群聊发起任何可追踪作业。
 *   D. 模式任务(goal/loop/pipeline)也必须拿到验收契约:模式指令是**附加**,不得顶替契约。
 *   E. 任务进行中并行使用群聊:普通发言 0 次 Agent 执行、@用户 只发通知、时间线顺序不乱,
 *      且群聊不干扰作业收口。
 *
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-agentteam-workflow.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离:用户仓储惰性 getDb() 会走 AW_DATA_DIR;指向临时目录,绝不触碰真实数据
process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-workflow-'))
process.env.AGENTWORKSHOP_TEST = '1'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const { createAgentChannelManager } = await import('../server/services/workshop/runtime/manager')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')
const { dispatchHostTool, createSessionState } = await import('../server/services/workshop/agents/host-tool-bridge')
const { supervisePrompt } = await import('../server/services/workshop/agents/prompt-builder')
const { encodeTaskMode } = await import('../server/services/workshop/runtime/execution-mode')
// 类型只在编译期用:写成内联 import 类型表达式,避免"运行期导入仅当类型用"的未用变量告警
type Manager = InstanceType<(typeof import('../server/services/workshop/runtime/manager'))['AgentChannelManager']>

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean, timeoutMs = 20_000, label = 'condition'): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - start >= timeoutMs) {
      console.log(`    (waitUntil 超时: ${label})`)
      return cond()
    }
    await sleep(20)
  }
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const manager: Manager = createAgentChannelManager({
  repos: {
    users: undefined as never,
    channelEvents: createChannelEventRepo(db),
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    schedules: undefined as never,
  },
  implFactory: createAgentImpl,
  db,
})

const OWNER = { id: 'user-owner', name: 'owner', role: 'user' }
const MEMBER = { id: 'user-member', name: 'member', role: 'user' }
const OTHER = { id: 'user-other', name: 'other', role: 'user' }

/** 建一个 team channel:mock lead + N 个 mock worker(worker 延迟可配,便于观察"验收前父任务未完成") */
async function buildTeam(name: string, workerCount = 2, workerDelayMs = 120): Promise<{
  channelId: string
  leadId: string
  workerIds: string[]
}> {
  const { channelId, leadAgentId } = await manager.createChannel({
    name,
    description: 'workflow contract test',
    ownerUserId: OWNER.id,
    leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 30 } },
  })
  const workerIds: string[] = []
  for (let i = 0; i < workerCount; i++) {
    const tpl = await manager.createAgent({ name: `${name}-w${i + 1}`, harness: 'mock', config: { delayMs: workerDelayMs } })
    await manager.addAgentToChannel({ channelId, agentId: tpl.id, role: 'worker' })
    const row = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.templateId === tpl.id)!
    workerIds.push(row.id)
  }
  manager.ensureChannelActive(channelId, { tickMs: 25 })
  return { channelId, leadId: leadAgentId!, workerIds }
}

const childrenOf = (channelId: string, parentId: string) =>
  manager.deps.repos.tasks.listByChannel(channelId).map(r => manager.getTaskEngine().get(r.id)!).filter(t => t?.parentId === parentId)

// ============================================================================
section('A. 简单任务 → Leader 自己作答(不得派发 worker)')
// ============================================================================
{
  const { channelId, workerIds } = await buildTeam('simple')
  // 人类提交(任务入口);[mock:simple] 显式声明"这题不需要分工"
  const root = await manager.submitChannelTask({
    channelId,
    title: '确认日志保留期设置',
    description: '[mock:simple] 只需一句话回答:日志保留期默认多少天?',
    fromLabel: 'owner',
  })
  check('A1 根任务创建并归属 Leader', root.assigneeId === manager.deps.repos.channels.findById(channelId)!.leadAgentId, `assignee=${root.assigneeId.slice(0, 8)}`)

  const done = await waitUntil(() => {
    const t = manager.getTaskEngine().get(root.id)
    return !!t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)
  }, 20_000, 'root terminal')
  const final = manager.getTaskEngine().get(root.id)!
  check('A2 简单任务被收口为 COMPLETED', done && final.state === 'COMPLETED', `state=${final.state}`)
  check('A3 根任务带 Leader 自己的作答产物(lead-direct-answer)',
    final.artifacts.some(a => a.name === 'lead-direct-answer'),
    final.artifacts.map(a => a.name).join(',') || '(无)')

  const kids = childrenOf(channelId, root.id)
  check('A4 简单任务**零**子任务(未把简单活推给 worker)', kids.length === 0, `children=${kids.length}`)

  // worker 全程未被唤醒执行任何任务
  const workerTasks = manager.deps.repos.tasks.listByChannel(channelId).filter(r => workerIds.includes(r.assigneeId))
  check('A5 worker 零任务(Agent 执行没有发生)', workerTasks.length === 0, `workerTasks=${workerTasks.length}`)
  check('A6 作答产物非空(不是空壳完成)', (final.artifacts.find(a => a.name === 'lead-direct-answer')?.parts ?? [])
    .some(p => 'text' in p && p.text.trim().length > 0))
}

// ============================================================================
section('B. 专业任务 → 拆解派发 → worker 提交 → Leader 验收 → 有序摘要')
// ============================================================================
{
  const { channelId, workerIds } = await buildTeam('complex', 2, 150)
  const root = await manager.submitChannelTask({
    channelId,
    title: '对比分析两套方案并给出选型建议',
    description: '[mock:complex] 需要分别做独立分析、相互核对,并给出可核对的结论。',
    fromLabel: 'owner',
  })

  // 采样"子任务刚 COMPLETED 的那一刻父任务是什么状态"。
  // 必须用**任务事件流**而不是定时轮询:notifyTask 在 TaskEngine.complete → transition 内
  // **同步**派发给监听者,而 onChildCompleted(父 WAITING→WORKING)与后续 lead 验收回合
  // 都发生在这之后 —— 所以此处读到的就是"完工那一刻"的真实状态。
  // 定时轮询是跟调度 tick 赛跑,采样到的是"之后"的状态,断言会假失败。
  const parentStateOnChildComplete: string[] = []
  const unsub = manager.subscribeTaskEvents(channelId, (e) => {
    if (e.state !== 'COMPLETED') return
    const childParentId = e.task?.parentId ?? manager.getTaskEngine().get(e.taskId)?.parentId
    if (!childParentId || childParentId !== root.id) return
    parentStateOnChildComplete.push(manager.getTaskEngine().get(root.id)?.state ?? '(gone)')
  })

  const done = await waitUntil(() => {
    const t = manager.getTaskEngine().get(root.id)
    return !!t && t.state === 'COMPLETED'
  }, 30_000, 'parent completed')
  unsub()

  const kids = childrenOf(channelId, root.id)
  const final = manager.getTaskEngine().get(root.id)!
  check('B1 专业任务被拆解为多个子任务', kids.length >= 2, `children=${kids.length}`)
  check('B2 子任务全部派给 worker(不是留在 Leader 名下)', kids.every(k => workerIds.includes(k.assigneeId)),
    kids.map(k => k.assigneeId.slice(0, 6)).join(','))
  check('B3 每个子任务描述含验收标准(Leader 自己定义验收)', kids.every(k => /验收标准/.test(k.description ?? '')),
    kids.map(k => (/验收标准/.test(k.description ?? '') ? 'Y' : 'N')).join(','))
  check('B4 每个子任务描述含目标与交付格式', kids.every(k => /本子任务目标/.test(k.description ?? '') && /输出/.test(k.description ?? '')))
  check('B5 子任务最终 COMPLETED(worker 交付了成果)', kids.every(k => k.state === 'COMPLETED'),
    kids.map(k => k.state).join(','))
  check('B6 子任务每次完工的瞬间父任务都**未**完成(完工只是提交,须回 Leader 验收)',
    parentStateOnChildComplete.length === kids.length
    && parentStateOnChildComplete.every(s => s === 'WAITING' || s === 'WORKING'),
    `观测到 ${parentStateOnChildComplete.length}/${kids.length} 次完工,当时父任务 state=[${parentStateOnChildComplete.join(',')}]`)
  check('B7 父任务最终由 Leader 收口为 COMPLETED', done && final.state === 'COMPLETED', `state=${final.state}`)
  const summary = final.artifacts.find(a => a.name === 'lead-acceptance-summary')
  check('B8 父任务带 Leader 的验收摘要(lead-acceptance-summary)', !!summary)
  const summaryLines = (summary?.parts ?? []).map(p => ('text' in p ? p.text : '')).filter(Boolean)
  check('B9 验收摘要逐项对应每个子任务', summaryLines.length === kids.length,
    `lines=${summaryLines.length} children=${kids.length}`)
  check('B10 验收顺序 = 子任务创建顺序(不混乱)',
    summaryLines.every((line, i) => line.includes(kids[i]!.title)),
    summaryLines.map(l => l.slice(0, 14)).join(' | '))
  check('B11 每条验收行都带上了 worker 的真实交付内容(非空壳)',
    summaryLines.every(l => !l.trim().endsWith('：')), `lines=${JSON.stringify(summaryLines.map(l => l.slice(-12)))}`)
}

// ============================================================================
section('C. 群聊请求 → Leader 升级为可追踪根任务并拆解(本轮补齐)')
// ============================================================================
{
  const { channelId, leadId, workerIds } = await buildTeam('chat-escalation', 2, 80)
  // 加入群聊需要先开启群聊(否则 409 CHAT_DISABLED)
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, MEMBER)
  // 本段先只验证"lead 用 host 工具从群聊起作业"这条链路本身。
  // 注意:调度循环不能靠"不调用 ensureChannelActive"来禁用 —— lead 运行时一旦装配,
  // wireMember 会自动补齐 SchedulerLoop(生产上防"worker 活着、lead 不派活"的僵尸态),
  // 所以这里显式暂停它,否则 mock lead 的自动 supervise 会和断言赛跑
  // (它的职责恰恰就是最终把父任务收口成 COMPLETED)。
  // 本段末尾再恢复调度,验证"活调度下端到端收口"。
  const cr = (manager as unknown as {
    channels: Map<string, { scheduler: { stop(): void } | null }>
  }).channels.get(channelId)!
  cr.scheduler?.stop()
  cr.scheduler = null

  // 造一个 leader 身份的 host-tool 上下文(与真实 harness 调用**同一入口**):
  // workspace 用 manager 真实装配的能力面(与运行时 wireMember 装配的是同一份),
  // 只有 memory 传空对象 —— submit_task/dispatch_task 不触碰记忆面。
  const leadAgent = manager.getChannelAgent(leadId)!
  const workspace = (manager as unknown as {
    // TS private 是类型层擦除;测试直接按结构取用生产装配函数,避免另造一份桩件而测偏
    buildWorkspace: (agent: unknown, memory: unknown) => Record<string, unknown>
  }).buildWorkspace(leadAgent, {})
  const bridgeCtx = {
    identity: { agentId: leadId, channelId, role: 'lead' as const, name: 'lead' },
    state: createSessionState(),
    getWorkspace: () => workspace as never,
  }

  const r1 = await dispatchHostTool(bridgeCtx, {
    toolName: 'submit_task',
    arguments: {
      title: '按用户群聊诉求产出部署方案',
      description: '用户在群聊里要求:给出上线部署方案,包含回滚步骤与验收清单。',
    },
  })
  check('C1 submit_task 工具可用且登记成功', !r1.isError, r1.text.slice(0, 90))

  const roots = manager.deps.repos.tasks.listByChannel(channelId)
    .map(r => manager.getTaskEngine().get(r.id)!)
    .filter(t => t && !t.parentId)
  check('C2 群聊请求已升级为可追踪根任务', roots.length === 1, `roots=${roots.length}`)
  const root = roots[0]!
  check('C3 根任务归属 Leader(assignee=lead)', root.assigneeId === leadId, `assignee=${root.assigneeId.slice(0, 8)}`)
  check('C4 根任务 creator 记录为 Lead(来源可追溯)', root.creatorId === leadId, `creator=${root.creatorId.slice(0, 8)}`)
  check('C5 根任务初态 SUBMITTED(等 Lead 继续分流)', root.state === 'SUBMITTED', `state=${root.state}`)

  // 幂等:再登记一次同标题不得产生第二个根任务
  await dispatchHostTool(bridgeCtx, {
    toolName: 'submit_task',
    arguments: { title: '按用户群聊诉求产出部署方案', description: '重复登记' },
  })
  const roots2 = manager.deps.repos.tasks.listByChannel(channelId)
    .map(r => manager.getTaskEngine().get(r.id)!)
    .filter(t => t && !t.parentId)
  check('C6 重复登记幂等(仍只有一个根任务)', roots2.length === 1, `roots=${roots2.length}`)

  // 对该根任务拆解派发 → 验收收口:走**真实生产入口** dispatch_task 工具,
  // 而不是直接调 manager.dispatchTask —— "lead 在同一回合里 submit_task → dispatch_task"
  // 正是"群聊请求 → 可追踪作业"的实际路径(根任务此刻仍是 SUBMITTED)。
  const r2 = await dispatchHostTool(bridgeCtx, {
    toolName: 'dispatch_task',
    arguments: {
      parent_task_id: root.id,
      assignee_id: workerIds[0]!,
      title: '写出部署与回滚步骤',
      description: '本子任务目标:给出部署+回滚步骤。输出:编号步骤清单。验收标准:步骤可执行且含回滚点。',
      route_reason: '唯一 worker,且任务属于其执行面',
    },
  })
  check('C7 根任务下可正常派发子任务(经 dispatch_task 真实入口)', !r2.isError, r2.text.slice(0, 76))
  const kidsAfterDispatch = childrenOf(channelId, root.id)
  const child = kidsAfterDispatch[0]!
  check('C8 派发后父任务进入 WAITING(不在 SUBMITTED 悬挂、不留下孤儿子任务)',
    kidsAfterDispatch.length === 1 && child.parentId === root.id
    && manager.getTaskEngine().get(root.id)!.state === 'WAITING',
    `children=${kidsAfterDispatch.length} parent=${manager.getTaskEngine().get(root.id)!.state}`)

  const childDone = await waitUntil(() => manager.getTaskEngine().get(child.id)?.state === 'COMPLETED', 15_000, 'child completed')
  check('C9 子任务由 worker 完成(提交)', childDone)
  const parentBeforeAccept = manager.getTaskEngine().get(root.id)!
  check('C10 子任务完工只是**提交**:父任务转入待验收(WORKING)而不是自动完成',
    parentBeforeAccept.state === 'WORKING', `state=${parentBeforeAccept.state}`)
  // Leader 验收:带验收摘要收口
  await manager.completeTask(channelId, leadId, {
    taskId: root.id,
    artifacts: [{
      artifactId: 'acc-1',
      name: 'lead-acceptance-summary',
      parts: [{ text: `验收 1/1｜${child.title}:已核对可执行性与回滚点,通过` }],
    }],
  })
  const parentDone = manager.getTaskEngine().get(root.id)!
  check('C11 Leader 验收后父任务 COMPLETED', parentDone.state === 'COMPLETED', `state=${parentDone.state}`)

  // 终态父任务不得再被分解:旧实现会"先建子任务、再迁移父任务",
  // 而 COMPLETED 无出边 → 抛错时子任务已落库(孤儿)。必须在任何副作用前拒绝。
  const beforeKids = childrenOf(channelId, root.id).length
  let terminalErr: { code?: string } | null = null
  try {
    await manager.dispatchTask(channelId, leadId, {
      parentTaskId: root.id,
      assigneeId: workerIds[0]!,
      title: '对已完成根任务的越界派发',
      description: '本不应被创建',
    })
  }
  catch (err) { terminalErr = err as { code?: string } }
  check('C11b 已完成的父任务拒绝再派发(且不留下孤儿子任务)',
    terminalErr?.code === 'TASK_TERMINAL' && childrenOf(channelId, root.id).length === beforeKids,
    `code=${terminalErr?.code ?? '(未抛错)'} children=${childrenOf(channelId, root.id).length}(原 ${beforeKids})`)

  // -------- 活调度端到端:开启调度循环,让 lead 自己把"群聊来源的根任务"拆解→验收→收口 --------
  manager.ensureChannelActive(channelId, { tickMs: 25 })
  const r3 = await dispatchHostTool(bridgeCtx, {
    toolName: 'submit_task',
    arguments: {
      title: '群聊升级:对比分析并给出选型结论',
      description: '[mock:complex] 用户在群聊里要求对比两套方案,分别核对后给出结论。',
    },
  })
  check('C12 群聊请求可登记为新的可追踪根任务', !r3.isError, r3.text.slice(0, 60))
  const liveRoot = manager.deps.repos.tasks.listByChannel(channelId)
    .map(r => manager.getTaskEngine().get(r.id)!)
    .filter(t => t && !t.parentId && t.title.startsWith('群聊升级:'))[0]!
  const liveDone = await waitUntil(
    () => manager.getTaskEngine().get(liveRoot.id)?.state === 'COMPLETED', 30_000, 'chat root accepted by lead')
  const liveKids = childrenOf(channelId, liveRoot.id)
  const liveSummary = (manager.getTaskEngine().get(liveRoot.id)?.artifacts ?? [])
    .find(a => a.name === 'lead-acceptance-summary')
  check('C13 群聊来源的根任务被 lead 自动拆解并全部派给 worker',
    liveKids.length >= 1 && liveKids.every(k => workerIds.includes(k.assigneeId)),
    `children=${liveKids.length} assignees=${liveKids.map(k => k.assigneeId.slice(0, 6)).join(',')}`)
  check('C14 群聊来源的根任务最终由 lead 验收收口(带 lead-acceptance-summary)',
    liveDone && !!liveSummary,
    `state=${manager.getTaskEngine().get(liveRoot.id)?.state} summary=${!!liveSummary}`)
}

// ============================================================================
section('D. 模式任务(goal)也必须拿到验收契约')
// ============================================================================
{
  const snapshot = {
    tick: 1,
    now: Date.now(),
    tasks: [{
      id: 'goal-root',
      channelId: 'ch',
      title: '目标型任务',
      description: encodeTaskMode('goal', { goalCriteria: '全部子项达标' }, '按目标推进'),
      assigneeId: 'lead-1',
      creatorId: '',
      state: 'WORKING' as const,
      progress: 0,
      retryCount: 0,
      artifacts: [],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    members: [{ agentId: 'lead-1', name: 'lead', role: 'lead' as const, state: 'idle' as const, queued: 0, completedCount: 0 }],
    pendingChildren: {},
    mail: [],
  }
  const prompt = supervisePrompt({
    snapshot: snapshot as never,
    agentName: 'lead',
    channelId: 'ch',
    ctxPrefix: '',
    manual: '',
  })
  check('D1 模式任务 prompt 含模式指令(goal 判定纪律)', /mode|goal|标准|criteria/i.test(prompt), `${prompt.length} chars`)
  check('D2 模式任务 prompt **同时**含 Lead 验收契约(不被模式挤掉)',
    /submission, not acceptance/i.test(prompt))
  check('D3 契约中的"有序总结"要求仍在', /ordered synthesis/i.test(prompt))
}

// ============================================================================
section('E. 作业进行中并行使用群聊(普通发言 0 执行 / @用户 只通知 / 顺序不乱)')
// ============================================================================
{
  const { channelId } = await buildTeam('chat-during-work', 2, 250)
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, MEMBER)

  // 起一个专业作业(会在群聊进行中被拆解执行)
  const root = await manager.submitChannelTask({
    channelId,
    title: '并行群聊下的专业作业',
    description: '[mock:complex] 需要拆分独立核对的作业。',
    fromLabel: 'owner',
  })

  await sleep(150)
  // 作业进行中:普通发言(无 @) → 0 次 Agent 执行
  const before = manager.groupChat.chat.countDeliveries(channelId)
  const plain = manager.sendChatMessage(channelId, MEMBER, {
    text: '进度怎么样了?我这边在等结论。',
    clientMessageId: 'during-work-plain',
  })
  check('E1 作业中普通发言:0 条 Agent 投递', plain.deliveries.length === 0, `deliveries=${plain.deliveries.length}`)
  check('E2 作业中普通发言不新增投递台账', manager.groupChat.chat.countDeliveries(channelId) === before)

  // 作业进行中:@另一位用户 → 只发定向通知,不触发 Agent
  manager.joinChannel(channelId, OTHER)
  const atUser = manager.sendChatMessage(channelId, MEMBER, {
    text: '@other 麻烦你也盯一下',
    mentions: [{ type: 'user', id: OTHER.id, label: 'other' }],
    clientMessageId: 'during-work-mention',
  })
  check('E3 @用户仍 0 条 Agent 投递', atUser.deliveries.length === 0)
  check('E4 @用户产生**被 @ 者**的定向通知(mention)',
    manager.groupChat.notifications.listRecent(OTHER.id, 20).some(n => n.type === 'mention'))
  // 自我 @ 不得给自己发通知(服务端按 m.id !== user.id 过滤)
  manager.sendChatMessage(channelId, MEMBER, {
    text: '@member 记一下',
    mentions: [{ type: 'user', id: MEMBER.id, label: 'member' }],
    clientMessageId: 'during-work-self-mention',
  })
  check('E4b 自己 @ 自己不发通知(也仍是 0 次 Agent 投递)',
    !manager.groupChat.notifications.listRecent(MEMBER.id, 20).some(n => n.type === 'mention'))

  // 作业收口不受群聊影响
  const done = await waitUntil(() => manager.getTaskEngine().get(root.id)?.state === 'COMPLETED', 30_000, 'root under chat load')
  check('E5 群聊并行不影响作业收口(父任务完成)', done)
  const kids = childrenOf(channelId, root.id)
  check('E6 拆解与验收仍完整(子任务全完成 + 父任务有验收摘要)',
    kids.length >= 1 && kids.every(k => k.state === 'COMPLETED')
    && (manager.getTaskEngine().get(root.id)?.artifacts ?? []).some(a => a.name === 'lead-acceptance-summary'))

  // 群聊时间线顺序:普通发言与 @用户按提交序落库,新旧一致
  const timeline = manager.listChatMessages(channelId, MEMBER, { limit: 50 })
  const texts = timeline.map(m => m.text)
  check('E7 群聊时间线按提交顺序排列(不混乱)',
    texts.indexOf('@member 麻烦你也盯一下') < texts.indexOf('进度怎么样了?我这边在等结论。'),
    texts.map(t => t.slice(0, 10)).join(' > '))
  check('E8 时间线 sender 归属正确(人类成员)', timeline.every(m => m.senderType === 'user' && m.senderId === MEMBER.id))
}

// ============================================================================
console.log(`\n${'='.repeat(64)}`)
console.log(`AgentTeam 作业流程契约: PASS=${passed}  FAIL=${failures.length}`)
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(64))
await manager.shutdown()
db.close()
process.exit(failures.length > 0 ? 1 : 0)
