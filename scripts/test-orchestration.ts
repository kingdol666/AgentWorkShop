/**
 * 端到端编排测试(T8,§10 test-orchestration)— 完整闭环。
 *
 * 流程:用户向 Channel 提交主任务 → 真实 SchedulerLoop(tickMs=10)驱动 lead 观察快照、
 * 分解 dispatch 给 2 个 worker → worker(真实 MockAgentImpl,delayMs=0)自动接取执行上报 →
 * lead 汇总子任务成果交付(主任务 COMPLETED + 成果可见 + 成员进度互见 + 跨 channel 作用域隔离)。
 *
 * 装配::memory: db + 真实 Manager(createAgentChannelManager,默认真实 TaskEngine)
 *      + 真实 SchedulerLoop(mock harness 渠道,tickMs=10)+ 真实 TaskEngine。
 * lead 用测试内联的监督型 impl(SuperviseOnlyLead):run() 不执行任务(§2.1 lead 仅编排,
 * 避免 mock 剧本把主任务当普通 assign 自行执行);supervise() 做分解/汇总决策。
 * worker 用真实 MockAgentImpl(delayMs=0)。
 *
 * 运行:npx tsx scripts/test-orchestration.ts
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb, parseJson } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import {
  createAgentChannelManager,
  type AgentChannelManager,
  type AllRepos,
} from '../server/services/workshop/runtime/manager'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import type { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import type { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import { MockAgentImpl } from '../server/services/workshop/agents/mock-agent'
import type {
  AgentEvent,
  AgentInfo,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../server/services/workshop/agents/agent-interface'
import type { A2AArtifact, Part } from '../server/services/workshop/types/a2a'
import type { WorkspaceTask } from '../server/services/workshop/types/task'
import { AppError } from '../server/utils/errors'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setTimeout(resolve, ms)
  return promise
}

/** 轮询等待条件成立(上限 timeoutMs;sleep + 超时,与 §10 测试策略一致) */
async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return true
    if (Date.now() >= deadline) return cond()
    await sleep(20)
  }
}

function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

/** 终态(与 mock-agent 同语义) */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED'])

/** 汇总 artifact:列出每个子任务的成果文本(lead 交付时挂到父任务) */
function buildSummaryArtifact(
  parent: { title: string },
  children: { title: string, artifacts: A2AArtifact[] }[],
): A2AArtifact {
  const parts: Part[] = [{ text: `主任务「${parent.title}」子任务成果汇总:` }]
  for (const child of children) {
    for (const artifact of child.artifacts) {
      for (const part of artifact.parts) {
        const label = `[${child.title}] `
        parts.push({ text: 'text' in part ? `${label}${part.text}` : `${label}${JSON.stringify(part)}` })
      }
    }
  }
  return { artifactId: randomUUID(), name: '汇总', description: '子任务成果汇总', parts }
}

/**
 * 监督型 lead impl(测试内联,§2.1 lead=编排者语义):
 *  - run():no-op(lead 不直接执行任务;调度分解/汇总由 supervise 承担)
 *  - supervise():lead 自有且无子任务的任务 → dispatch 给全部空闲 worker(2 个 worker → 2 子任务);
 *                子任务全部完成 → complete 父任务并附子任务成果汇总 artifact
 */
class SuperviseOnlyLead implements AgentInterface {
  async* run(_request: AgentRunRequest, _ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    // lead 不执行任务(空事件流;assign 消息由平台自动接取后经 supervise 分解)
  }

  async supervise(
    snapshot: SupervisionSnapshot,
    ctx: AgentRunContext,
  ): Promise<SupervisionDecision[]> {
    const decisions: SupervisionDecision[] = []
    const idleWorkers = snapshot.members.filter(m => m.role === 'worker' && m.state === 'idle')
    for (const task of snapshot.tasks) {
      if (task.assigneeId !== ctx.agentId) continue
      if (TERMINAL.has(task.state)) continue
      const children = snapshot.tasks.filter(t => t.parentId === task.id)
      if (children.length === 0) {
        // 无子任务且任务可推进(SUBMITTED 待分解 / WORKING 已自动接取)→ 分解给每个空闲 worker
        if (task.state === 'SUBMITTED' || task.state === 'WORKING') {
          for (const worker of idleWorkers) {
            decisions.push({
              kind: 'dispatch',
              parentTaskId: task.id,
              assigneeId: worker.agentId,
              title: task.title,
              description: task.description,
            })
          }
        }
      }
      else if (
        (task.state === 'WAITING' || task.state === 'WORKING')
        && children.every(c => c.state === 'COMPLETED')
      ) {
        // 子任务全部完成 → 汇总成果交付父任务
        decisions.push({ kind: 'complete', taskId: task.id, artifacts: [buildSummaryArtifact(task, children)] })
      }
    }
    return decisions
  }
}

/** implFactory:lead → 监督型 impl(仅调度);worker → 真实 mock(delayMs=0) */
function buildImplFactory(): (agent: AgentInfo) => AgentInterface {
  return agent => (agent.role === 'lead' ? new SuperviseOnlyLead() : new MockAgentImpl(agent.config))
}

/** implFactory:全部真实 MockAgentImpl(生产路径:mock lead 的 supervise 剧本做调度) */
function buildRealMockFactory(): (agent: AgentInfo) => AgentInterface {
  return agent => new MockAgentImpl(agent.config)
}

interface Harness {
  db: DatabaseSync
  manager: AgentChannelManager
  repos: AllRepos
}

/** :memory: db + 真实 Manager(默认真实 TaskEngine)+ 注入 implFactory */
function setup(): Harness {
  const db = openWorkshopDb(':memory:')
  const repos: AllRepos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: buildImplFactory(), db })
  return { db, manager, repos }
}

/** 白盒取 manager 内部 ChannelRuntime(manager 未暴露 accessor;测试装配 SchedulerLoop 用) */
function channelRuntimeOf(manager: AgentChannelManager, channelId: string): ChannelRuntime {
  const internals = manager as unknown as { channels: Map<string, ChannelRuntime> }
  const cr = internals.channels.get(channelId)
  if (!cr) throw new AppError(404, 'NOT_FOUND', `channel runtime 不存在: ${channelId}`)
  return cr
}

/** 给 channel 挂载真实 SchedulerLoop 并启动(真实 Manager + 真实 SchedulerLoop 装配) */
function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): SchedulerLoop {
  const cr = channelRuntimeOf(manager, channelId)
  // cr.lead 运行时即 manager 装配的真实 AgentRuntime(接口类型为 AgentRuntimeLike,此处收窄)
  const lead = cr.lead as unknown as AgentRuntime
  const loop = new SchedulerLoop(cr, lead, { tickMs })
  cr.scheduler = loop
  loop.start()
  return loop
}

/** 创建带 lead + N 个 worker(mock harness)的 channel */
async function createTeamChannel(
  manager: AgentChannelManager,
  name: string,
  leadName: string,
  workerNames: string[],
): Promise<{ channelId: string, leadAgentId: string, workers: AgentInfo[] }> {
  const { channelId, leadAgentId } = await manager.createChannel({
    name,
    leadAgent: { name: leadName, harness: 'mock', config: { delayMs: 0 } },
  })
  if (!leadAgentId) throw new AppError(500, 'INTERNAL_ERROR', `channel ${channelId} 创建后无 lead`)
  const workers: AgentInfo[] = []
  for (const wn of workerNames) {
    const tpl = await manager.createAgent({ name: wn, harness: 'mock', config: { delayMs: 0 } })
    workers.push(await manager.addAgentToChannel({ channelId, agentId: tpl.id, role: 'worker' }))
  }
  return { channelId, leadAgentId, workers }
}

/** 场景 1:端到端闭环 — 主任务 → 2 子任务 → 汇总交付 → 进度互见 */
async function testOrchestrationFlow(h: Harness, loops: SchedulerLoop[], channels: string[]): Promise<void> {
  console.log('\n--- 1. 端到端编排:lead 分解 → 2 worker 执行 → lead 汇总交付 ---')
  const { manager } = h
  const team = await createTeamChannel(manager, '频道A', 'leadA', ['workerA1', 'workerA2'])
  channels.push(team.channelId)
  loops.push(attachScheduler(manager, team.channelId, 10))

  const main = await manager.submitChannelTask({
    channelId: team.channelId,
    title: '主任务',
    description: '统筹交付',
  })
  check(
    '主任务提交成功(SUBMITTED,assignee=lead)',
    main.state === 'SUBMITTED' && main.assigneeId === team.leadAgentId,
  )

  // 轮询等待主任务 COMPLETED(上限 10s);期间记录子任务出现过的中间状态
  const seenStates = new Map<string, Set<string>>()
  const mainDone = await waitUntil(async () => {
    const tasks = await manager.listTasks(team.leadAgentId)
    for (const t of tasks) {
      if (t.parentId !== main.id) continue
      const states = seenStates.get(t.id) ?? new Set<string>()
      states.add(t.state)
      seenStates.set(t.id, states)
    }
    return tasks.some(t => t.id === main.id && t.state === 'COMPLETED')
  }, 10_000)
  check('主任务在 10s 内 COMPLETED', mainDone, `state=${mainDone ? 'COMPLETED' : '超时'}`)

  const tasks = await manager.listTasks(team.leadAgentId)
  const children = tasks.filter(t => t.parentId === main.id)

  // ① 生成了 2 个子任务,且均 COMPLETED、进度 100
  const observed = new Set<string>()
  for (const states of seenStates.values()) {
    for (const s of states) observed.add(s)
  }
  check(
    '生成了 2 个子任务且均 COMPLETED/进度 100',
    children.length === 2 && children.every(c => c.state === 'COMPLETED' && c.progress === 100),
    `count=${children.length} 轮询观察到状态=[${[...observed].join('→') || '—'}]`,
  )

  // ② 每个子任务都有已消费的 assign 投递消息:证明 dispatch 落库投递 → mailbox 消费 →
  //    自动接取 ASSIGNED→WORKING 路径(子任务创建即 ASSIGNED,状态机强制 ASSIGNED→WORKING→COMPLETED)
  const recent = h.repos.messages.listRecentByChannel(team.channelId, 200)
  const assignTrailComplete = children.every(c =>
    recent.some(
      m =>
        m.taskId === c.id
        && m.toAgentId === c.assigneeId
        && m.state === 'consumed'
        && parseJson<Record<string, unknown>>(m.metadataJson, {})['x-aw-task-kind'] === 'assign',
    ),
  )
  check('每个子任务均有已消费的 assign 投递消息(ASSIGNED 后完成的证据)', assignTrailComplete)

  // ③ 子任务成果 artifact 存在 + 成员进度互见(同 channel 同事 getTask 可见成果)
  const [child1, child2] = children
  const viewByAssignee = await manager.getTask(child1.assigneeId, child1.id)
  const hasMockArtifact = (t: WorkspaceTask): boolean =>
    t.artifacts.some(a => a.parts.some(p => 'text' in p && p.text.includes('mock 成果')))
  check(
    'assignee getTask(自己子任务) 含成果 artifact',
    viewByAssignee.artifacts.length >= 1 && hasMockArtifact(viewByAssignee),
    `artifacts=${viewByAssignee.artifacts.length}`,
  )
  const viewByPeer = await manager.getTask(child2.assigneeId, child1.id)
  check(
    '同事 getTask(他人子任务) 进度成果互见',
    viewByPeer.id === child1.id && viewByPeer.artifacts.length >= 1 && hasMockArtifact(viewByPeer),
  )

  // ④ lead 完成时父任务含子任务成果汇总
  const mainTask = await manager.getTask(team.leadAgentId, main.id)
  const summary = mainTask.artifacts.find(a => a.name === '汇总')
  check(
    '父任务 COMPLETED 且含子任务成果汇总 artifact',
    mainTask.state === 'COMPLETED' && summary !== undefined,
    `artifacts=${mainTask.artifacts.length}`,
  )
  check(
    '汇总内容包含子任务成果文本',
    summary !== undefined && summary.parts.some(p => 'text' in p && p.text.includes('mock 成果')),
  )
}

/** 场景 2:作用域隔离 — 另一 channel 的 agent 看不到本 channel 任务 */
async function testScopeIsolation(h: Harness, channels: string[]): Promise<void> {
  console.log('\n--- 2. 作用域隔离:跨 channel 不可见 ---')
  const { manager } = h
  const teamA = await createTeamChannel(manager, '频道A2', 'leadA2', ['workerA2-1', 'workerA2-2'])
  const teamB = await createTeamChannel(manager, '频道B', 'leadB', ['workerB1'])
  channels.push(teamA.channelId, teamB.channelId)
  // B 频道不挂 SchedulerLoop:仅验证作用域,不发起任务流转

  const mainA = await manager.submitChannelTask({ channelId: teamA.channelId, title: 'A频道任务' })
  const tasksFromB = await manager.listTasks(teamB.workers[0].id)
  check(
    'B 频道 agent listTasks 不含 A 频道任务',
    !tasksFromB.some(t => t.id === mainA.id || t.channelId === teamA.channelId),
    `B 频道可见任务数=${tasksFromB.length}`,
  )

  let scopeError: AppError | null = null
  try {
    await manager.getTask(teamB.workers[0].id, mainA.id)
  }
  catch (err) {
    if (isAppError(err)) scopeError = err
  }
  check(
    'B 频道 agent getTask(A 任务) 抛 SCOPE_VIOLATION',
    scopeError !== null && scopeError.code === 'SCOPE_VIOLATION' && scopeError.status === 403,
    `code=${scopeError?.code ?? '无异常'} status=${scopeError?.status ?? '—'}`,
  )
}

/** 场景 3:生产路径 — 真实 MockAgentImpl lead(角色感知 run + supervise 剧本)+ 真实 SchedulerLoop 全自动闭环 */
async function testRealMockLeadFlow(h: Harness, loops: SchedulerLoop[], channels: string[]): Promise<void> {
  console.log('\n--- 3. 真实 Mock lead 全自动闭环(生产路径,无测试内联 impl) ---')
  const { manager } = h
  const team = await createTeamChannel(manager, '频道C', 'leadC', ['workerC1', 'workerC2'])
  channels.push(team.channelId)
  loops.push(attachScheduler(manager, team.channelId, 10))

  const main = await manager.submitChannelTask({
    channelId: team.channelId,
    title: '生产路径主任务',
    description: '真实 mock lead 自动调度',
  })

  const done = await waitUntil(async () => {
    const tasks = await manager.listTasks(team.leadAgentId)
    return tasks.some(t => t.id === main.id && t.state === 'COMPLETED')
  }, 10_000)
  check('真实 mock lead:主任务 10s 内 COMPLETED', done, done ? '' : '超时')

  const tasks = await manager.listTasks(team.leadAgentId)
  const children = tasks.filter(t => t.parentId === main.id)
  check('真实 mock lead:生成子任务且全部完成', children.length >= 1 && children.every(c => c.state === 'COMPLETED'), `count=${children.length}`)

  const parent = tasks.find(t => t.id === main.id)
  check('真实 mock lead:父任务汇总 artifact 存在', (parent?.artifacts.length ?? 0) > 0, `artifacts=${parent?.artifacts.length ?? 0}`)

  // 关键断言:lead 未自执行主任务(子任务 ≥1 即证明 dispatch 发生,而非 lead 自己 worker 剧本完成)
  check('真实 mock lead:未自执行主任务(dispatch 路径)', children.length >= 1)
}

async function main(): Promise<void> {
  const h = setup()
  const loops: SchedulerLoop[] = []
  const channels: string[] = []
  try {
    await testOrchestrationFlow(h, loops, channels)
    await testScopeIsolation(h, channels)
    // 场景 3 用独立 harness(真实 mock implFactory),避免污染场景 1/2 的监督型 lead 装配
    const db2 = openWorkshopDb(':memory:')
    const h2: Harness = {
      db: db2,
      manager: createAgentChannelManager({
        repos: {
          channels: createChannelRepo(db2),
          agents: createAgentRepo(db2),
          channelAgents: createChannelAgentRepo(db2),
          messages: createMessageRepo(db2),
          subscriptions: createSubscriptionRepo(db2),
          tasks: createTaskRepo(db2),
        },
        implFactory: buildRealMockFactory(),
        db: db2,
      }),
      repos: null as never,
    }
    await testRealMockLeadFlow(h2, loops, channels)
    h2.db.close()
  }
  finally {
    for (const loop of loops) loop.stop()
    for (const cid of channels) await h.manager.removeChannel(cid)
    h.db.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
