/**
 * SchedulerLoop 调度循环测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. MockAgentImpl 默认 simple/complex triage 与 child artifact 验收摘要
 *  2. wake() 立即触发一轮;空/异常 supervise 不触发盲派或父任务验收
 *  3. worker 失败重试与 busy stall watchdog 故障恢复
 *  4. 显式 goal/pipeline/loop 模式、stop() 与 createAgentImpl 工厂
 *
 * 装配:真实 :memory: repo + 真实 TaskEngine + 真实 ChannelRuntime + 真实 Mailbox
 *      + 真实 AgentRuntime(MockAgentImpl lead/worker)+ 真实 SchedulerLoop。
 */
import { randomUUID } from 'node:crypto'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import type { TaskPatch } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import type { WorkspaceTask } from '../server/services/workshop/types/task'
import { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus } from '../server/services/workshop/runtime/agent-runtime'
import { Mailbox, rowToMessage } from '../server/services/workshop/runtime/mailbox'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import { MockAgentImpl } from '../server/services/workshop/agents/mock-agent'
import { ClaudeSdkAgentImpl } from '../server/services/workshop/agents/claude-agent'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { encodeTaskMode, type ModeConfig } from '../server/services/workshop/runtime/execution-mode'
import type {
  AgentEvent,
  AgentInfo,
  AgentRunContext,
  AgentInterface,
  AgentWorkspace,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../server/services/workshop/agents/agent-interface'
import type { A2AArtifact, A2AMessage, ChannelMail } from '../server/services/workshop/types/a2a'
import { AppError } from '../server/utils/errors'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - start >= timeoutMs) return cond()
    await sleep(10)
  }
}

/** AgentRow(模板)与 ChannelAgentRow(实例)共有字段;实例 id 才是运行时身份 */
type RowWithConfig = { id: string, name: string, harness: string, configJson: string }

function rowToAgentInfo(row: RowWithConfig, channelId: string, role: 'lead' | 'worker'): AgentInfo {
  return {
    id: row.id,
    channelId,
    name: row.name,
    harness: row.harness,
    role,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
  }
}

interface WorkspaceDeps {
  engine: TaskEngine
  cr: ChannelRuntime
  tasks: ReturnType<typeof createTaskRepo>
  messages: ReturnType<typeof createMessageRepo>
}

/** 进程内 AgentWorkspace(委托真实 TaskEngine/ChannelRuntime/repo,模拟 manager 的最小能力面) */
function buildWorkspace(agent: AgentInfo, deps: WorkspaceDeps): AgentWorkspace {
  const { engine, cr, tasks, messages } = deps
  return {
    listAgents: async () => [],
    dispatchTask: async () => {
      throw new AppError(400, 'BAD_REQUEST', '测试 workspace 不使用 dispatchTask')
    },
    listTasks: async () => engine.list(agent.channelId),
    getTask: async (taskId) => {
      const task = engine.get(taskId)
      if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
      return task
    },
    reportTask: async ({ taskId, progress, artifact, message }) => {
      const task = engine.get(taskId)
      if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
      const patch: TaskPatch = {}
      if (progress !== undefined) patch.progress = progress
      if (artifact) patch.artifacts = [...task.artifacts, artifact]
      if (message) {
        patch.history = [
          ...task.history,
          { messageId: randomUUID(), contextId: task.channelId, role: 'ROLE_AGENT' as const, parts: [{ text: message }] },
        ]
      }
      tasks.update(taskId, patch)
      return engine.get(taskId)!
    },
    completeTask: async (taskId, artifacts) => {
      const completed = engine.complete(taskId, artifacts)
      if (completed.parentId) {
        engine.onChildCompleted(completed)
        const parent = engine.get(completed.parentId)
        if (parent) cr.getAgents().find(a => a.agentId === parent.assigneeId)?.wakeMailbox()
      }
      return completed
    },
    cancelTask: async taskId => engine.cancel(taskId, agent.id),
    myQueue: async () => engine.queueViewOf(agent.channelId, agent.id),
    queueOverview: async () => [],
    updateTask: async (taskId, patch) => engine.updateTask(taskId, patch, agent.id),
    reassignTask: async (taskId, toAgentId) => engine.reassign(taskId, toAgentId),
    sendMessage: async ({ toAgentId, parts, metadata }) => {
      const message: A2AMessage = {
        messageId: randomUUID(),
        contextId: agent.channelId,
        role: 'ROLE_AGENT',
        parts,
        metadata: { ...(metadata ?? {}), 'x-aw-target-agent': toAgentId, 'x-aw-from-agent': agent.id },
      }
      cr.route(message)
      return message
    },
    pollMailbox: async (limit = 100) =>
      messages.listPendingByChannelAgent(agent.channelId, agent.id).slice(0, limit).map(rowToMessage),
    listMail: async (opts) => {
      const limit = Math.max(1, Math.min(500, opts?.limit ?? 200))
      const rows = messages.listRecentByChannel(agent.channelId, limit)
      const mails: ChannelMail[] = rows.map(r => ({
        messageId: r.id,
        taskId: r.taskId,
        fromAgentId: r.fromAgentId,
        toAgentId: r.toAgentId,
        role: r.role as 'ROLE_USER' | 'ROLE_AGENT',
        parts: (JSON.parse(r.partsJson) ?? []) as ChannelMail['parts'],
        metadata: (JSON.parse(r.metadataJson) ?? {}) as Record<string, unknown>,
        state: r.state,
        createdAt: r.createdAt,
        consumedAt: r.consumedAt,
      }))
      return opts?.agentId
        ? mails.filter(m => m.fromAgentId === opts.agentId || m.toAgentId === opts.agentId)
        : mails
    },
    subscribe: async () => {},
    recallMemory: async () => [],
    saveMemory: async () => { throw new Error('unused') },
  }
}

interface Setup {
  engine: TaskEngine
  cr: ChannelRuntime
  lead: AgentRuntime
  worker: AgentRuntime
  workers: AgentRuntime[]
  channelId: string
  loop: SchedulerLoop
}

interface SetupOptions {
  tickMs?: number
  stallMs?: number
  workerCount?: number
  leadImpl?: AgentInterface
  workerImpl?: AgentInterface
}

function setup(opts: SetupOptions = {}): Setup {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createAgentRepo(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const subscriptions = createSubscriptionRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  const channel = channels.create({ name: 'test-channel' })

  const channelAgents = createChannelAgentRepo(db)
  const leadRow = agents.create({ name: 'lead', harness: 'mock', config: { delayMs: 0 } })
  const workerRow = agents.create({ name: 'worker', harness: 'mock', config: { delayMs: 0 } })
  // 实例行(独立身份 id)才是运行时身份:lead 派发时 assignee 用的是实例 id
  const leadInst = channelAgents.create({ channelId: channel.id, templateId: leadRow.id, name: leadRow.name, harness: leadRow.harness, config: { delayMs: 0 }, role: 'lead' })
  const workerInfos = Array.from({ length: Math.max(1, opts.workerCount ?? 1) }, (_, index) => {
    const name = index === 0 ? 'worker' : `worker-${index + 1}`
    const workerInst = channelAgents.create({ channelId: channel.id, templateId: workerRow.id, name, harness: workerRow.harness, config: { delayMs: 0 }, role: 'worker' })
    return rowToAgentInfo(workerInst, channel.id, 'worker')
  })
  const leadInfo = rowToAgentInfo(leadInst, channel.id, 'lead')

  const cr = new ChannelRuntime(channel.id, { taskEngine: engine, subscriptionRepo: subscriptions, channelAgents })
  const bus: ChannelBus = { emit: () => {}, onEvent: () => () => {}, notifyTask: () => {}, notifyAgent: () => {}, onAgentStatus: () => {}, onTaskEvent: () => {}, wakeScheduler: () => {} }

  const lead = new AgentRuntime(leadInfo, opts.leadImpl ?? new MockAgentImpl(leadInfo.config), {
    mailbox: new Mailbox(messages, leadInfo.channelId, leadInfo.id, () => cr.wakeScheduler()),
    taskEngine: engine,
    bus,
    workspace: buildWorkspace(leadInfo, { engine, cr, tasks, messages }),
  })
  const workers = workerInfos.map((workerInfo) => {
    const worker = new AgentRuntime(workerInfo, opts.workerImpl ?? new MockAgentImpl(workerInfo.config), {
      mailbox: new Mailbox(messages, workerInfo.channelId, workerInfo.id, () => cr.wakeScheduler()),
      taskEngine: engine,
      bus,
      workspace: buildWorkspace(workerInfo, { engine, cr, tasks, messages }),
    })
    cr.addAgent(worker)
    return worker
  })

  cr.addAgent(lead)
  lead.start()
  for (const worker of workers) worker.start()

  const loop = new SchedulerLoop(cr, lead, { tickMs: opts.tickMs ?? 10, stallMs: opts.stallMs })
  cr.scheduler = loop

  return { engine, cr, lead, worker: workers[0]!, workers, channelId: channel.id, loop }
}

async function teardown(s: Setup): Promise<void> {
  s.loop.stop()
  await Promise.all([s.lead.stop(), ...s.workers.map(worker => worker.stop())])
}

function submitTask(s: Setup, title: string, description = '统筹交付') {
  return s.engine.create({
    channelId: s.channelId,
    creatorId: '',
    assigneeId: s.lead.agentId,
    title,
    description,
  })
}

/** 提交 loop 模式主任务(描述按 [mode:loop][interval:..][max:..] 编码,与 manager.submitChannelTask 同构) */
function submitLoopTask(s: Setup, title: string, config: ModeConfig) {
  return s.engine.create({
    channelId: s.channelId,
    creatorId: '',
    assigneeId: s.lead.agentId,
    title,
    description: encodeTaskMode('loop', config, '循环测试任务'),
  })
}

/** 模拟 manager 的 loop 重提交回调:原样创建新一轮主任务(经调度循环 dispatch 给 worker) */
function wireLoopResubmit(s: Setup): void {
  s.loop.setLoopResubmitCallback((title, description) => {
    s.engine.create({
      channelId: s.channelId,
      creatorId: '',
      assigneeId: s.lead.agentId,
      title,
      description,
    })
  })
}

// ===== 场景 =====

interface SupervisionRecord {
  snapshot: SupervisionSnapshot
  decisions?: SupervisionDecision[]
  error?: unknown
}

type SuperviseScript = (
  snapshot: SupervisionSnapshot,
  ctx: AgentRunContext,
) => SupervisionDecision[] | Promise<SupervisionDecision[]>

/** 记录公开调度快照和 lead 决策,不依赖 harness prompt 文本。 */
class RecordingLeadImpl implements AgentInterface {
  readonly records: SupervisionRecord[] = []

  constructor(private readonly script: SuperviseScript) {}

  async* run(): AsyncIterable<AgentEvent> {}

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    try {
      const decisions = await this.script(snapshot, ctx)
      this.records.push({ snapshot, decisions })
      return decisions
    }
    catch (error) {
      this.records.push({ snapshot, error })
      throw error
    }
  }
}

function testArtifact(artifactId: string, name: string, text: string): A2AArtifact {
  return { artifactId, name, parts: [{ text }] }
}

class RecordingMockLeadImpl extends MockAgentImpl {
  readonly records: SupervisionRecord[] = []

  override async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    try {
      const decisions = await super.supervise(snapshot, ctx)
      this.records.push({ snapshot, decisions })
      return decisions
    }
    catch (error) {
      this.records.push({ snapshot, error })
      throw error
    }
  }
}

async function testSimpleTriage(): Promise<void> {
  console.log('\n--- 1. 默认 simple triage 由 MockAgentImpl lead 完成并产出 artifact ---')
  const leadImpl = new RecordingMockLeadImpl({ delayMs: 0 })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '简单主任务', '[mock:simple] answer directly without delegation')

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const finalTask = s.engine.get(parent.id)
  const record = leadImpl.records.find(item => item.snapshot.tasks.some(task => task.id === parent.id))
  check('MockAgentImpl.supervise 收到默认模式 root task', !!record)
  check(
    'lead 显式 complete 并产出 lead-direct-answer',
    record?.decisions?.some(decision => decision.kind === 'complete'
      && decision.taskId === parent.id
      && decision.artifacts?.some(artifact => artifact.name === 'lead-direct-answer')) === true,
  )
  check('simple task 完成并保留 lead artifact', completed && finalTask?.artifacts.some(a => a.name === 'lead-direct-answer'))
  check('simple task 不创建 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))

  await teardown(s)
}

async function testComplexTriageRequiresLeadCloseout(): Promise<void> {
  console.log('\n--- 2. 默认 complex triage 最多派两个 worker,lead 用真实 artifact 验收 ---')
  const leadImpl = new RecordingMockLeadImpl({ delayMs: 0 })
  const s = setup({ tickMs: 10, workerCount: 2, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '复杂主任务', '[mock:complex] delegate independent analysis and verification')

  const childrenCreated = await waitUntil(() =>
    s.engine.list(s.channelId).filter(task => task.parentId === parent.id).length === 2,
  )
  const children = s.engine.list(s.channelId).filter(task => task.parentId === parent.id)
  const dispatchRecord = leadImpl.records.find(record =>
    record.snapshot.tasks.some(task => task.id === parent.id && task.state === 'SUBMITTED')
    && record.decisions?.some(decision => decision.kind === 'dispatch' && decision.parentTaskId === parent.id),
  )
  const dispatched = dispatchRecord?.decisions?.filter(decision =>
    decision.kind === 'dispatch' && decision.parentTaskId === parent.id,
  ) ?? []
  check('默认 complex root 由 MockAgentImpl.supervise triage', !!dispatchRecord)
  check(
    'lead 派给最多两个可用 worker',
    childrenCreated && dispatched.length === 2
    && new Set(dispatched.map(decision => decision.kind === 'dispatch' ? decision.assigneeId : '')).size === 2
    && dispatched.every(decision => decision.kind === 'dispatch' && s.workers.some(worker => worker.agentId === decision.assigneeId)),
    `children=${children.length} dispatches=${dispatched.length}`,
  )

  const childrenCompleted = await waitUntil(() => children.length === 2
    && children.every(child => s.engine.get(child.id)?.state === 'COMPLETED'))
  const reviewRecordReady = await waitUntil(() => leadImpl.records.some((record) => {
    const tasks = record.snapshot.tasks
    const allChildrenCompleted = children.length === 2 && children.every(child =>
      tasks.some(task => task.id === child.id && task.state === 'COMPLETED'),
    )
    return allChildrenCompleted && record.decisions?.some(decision =>
      decision.kind === 'complete' && decision.taskId === parent.id
      && decision.artifacts?.some(artifact => artifact.name === 'lead-acceptance-summary'),
    ) === true
  }))
  const reviewRecord = leadImpl.records.find((record) => {
    const tasks = record.snapshot.tasks
    return children.length === 2
      && children.every(child => tasks.some(task => task.id === child.id && task.state === 'COMPLETED'))
      && record.decisions?.some(decision => decision.kind === 'complete' && decision.taskId === parent.id) === true
  })
  const reviewTasks = reviewRecord?.snapshot.tasks ?? []
  const artifactsVisible = children.length === 2 && children.every((child) => {
    const actual = s.engine.get(child.id)
    const observed = reviewTasks.find(task => task.id === child.id)
    return actual?.artifacts.some(artifact => artifact.name !== 'input'
      && observed?.artifacts.some(snapshotArtifact => snapshotArtifact.artifactId === artifact.artifactId)) === true
  })
  const parentAtReview = reviewTasks.find(task => task.id === parent.id)
  const acceptance = reviewRecord?.decisions?.find(decision =>
    decision.kind === 'complete' && decision.taskId === parent.id,
  )
  const acceptedSummary = acceptance?.kind === 'complete'
    ? acceptance.artifacts?.find(artifact => artifact.name === 'lead-acceptance-summary')
    : undefined

  check('所有 child 均实际完成并有交付物', childrenCompleted && children.every(child => !!s.engine.get(child.id)?.artifacts.length))
  check('child 完成时 parent 仍待 lead 验收', !!parentAtReview && !['COMPLETED', 'FAILED', 'CANCELED'].includes(parentAtReview.state), `state=${parentAtReview?.state}`)
  check('后续 supervise snapshot 可见真实 child artifact', reviewRecordReady && artifactsVisible)
  check('lead 显式返回 lead-acceptance-summary 再 complete', !!acceptedSummary)
  check(
    'lead 验收摘要落到已完成 parent',
    s.engine.get(parent.id)?.state === 'COMPLETED'
    && !!acceptedSummary
    && s.engine.get(parent.id)?.artifacts.some(artifact => artifact.artifactId === acceptedSummary.artifactId),
    `state=${s.engine.get(parent.id)?.state}`,
  )

  await teardown(s)
}
async function testWakeTriggersRound(): Promise<void> {
  console.log('\n--- 3. wake 立即触发一轮(大 tickMs,无定时 tick) ---')
  const s = setup({ tickMs: 100000 })
  s.loop.start()
  const parent = submitTask(s, '主任务', '[mock:complex] wake dispatches delegated work')
  s.loop.wake()

  const dispatched = await waitUntil(
    () => s.engine.list(s.channelId).some(t => t.parentId === parent.id && t.assigneeId === s.worker.agentId),
    2000,
  )
  check('wake 立即触发 dispatch(无定时 tick)', dispatched)

  await teardown(s)
}

async function testSuperviseEmptyDoesNotFallback(): Promise<void> {
  console.log('\n--- 4. supervise 返回空不默认 dispatch 或完成父任务 ---')
  const leadImpl = new RecordingLeadImpl(() => [])
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '空决策主任务')
  const observed = await waitUntil(() => leadImpl.records.some(record =>
    record.snapshot.tasks.some(task => task.id === parent.id),
  ))
  await sleep(150)

  check('空决策 supervise 已观察 root task', observed)
  check('空决策不派发 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))
  check('空决策不验收父任务', s.engine.get(parent.id)?.state === 'SUBMITTED', `state=${s.engine.get(parent.id)?.state}`)
  check('double 记录 supervise 空决定', leadImpl.records.some(record => record.decisions?.length === 0))

  await teardown(s)
}

async function testLeadRetriesAfterEmptyDecision(): Promise<void> {
  console.log('\n--- 6. 空 Lead 决策不盲派，并在退避后重试，避免 root 永久悬挂 ---')
  let calls = 0
  let rootId = ''
  const leadImpl = new RecordingLeadImpl(() => {
    calls++
    if (calls === 1) return []
    return [{ kind: 'complete', taskId: rootId, artifacts: [testArtifact('retry-answer', 'deliverable', 'Lead 重试后完成。')] }]
  })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '退避后重试的简单任务')
  rootId = parent.id

  await sleep(150)
  check('首次空决策不盲派且未完成 root', calls === 1
  && s.engine.get(parent.id)?.state === 'SUBMITTED'
  && !s.engine.list(s.channelId).some(task => task.parentId === parent.id))

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED', 8_000)
  check('退避重试后 Lead 可恢复并完成任务', completed && calls >= 2, `calls=${calls} state=${s.engine.get(parent.id)?.state}`)
  await teardown(s)
}
async function testSuperviseThrowDoesNotFallback(): Promise<void> {
  console.log('\n--- 5. supervise 抛错不默认 dispatch 或完成父任务 ---')
  const leadImpl = new RecordingLeadImpl(() => {
    throw new Error('supervise boom')
  })
  const s = setup({ tickMs: 10, leadImpl })
  s.loop.start()
  const parent = submitTask(s, '异常主任务')
  const observed = await waitUntil(() => leadImpl.records.some(record =>
    record.snapshot.tasks.some(task => task.id === parent.id),
  ))
  await sleep(150)

  check('抛错 supervise 已观察 root task', observed)
  check('抛错不派发 child', !s.engine.list(s.channelId).some(task => task.parentId === parent.id))
  check('抛错不验收父任务', s.engine.get(parent.id)?.state === 'SUBMITTED', `state=${s.engine.get(parent.id)?.state}`)
  check('double 记录 supervise 异常', leadImpl.records.some(record => record.error instanceof Error))

  await teardown(s)
}
class FlakyWorkerImpl implements AgentInterface {
  private attempts = 0
  private readonly fallback = new MockAgentImpl({ delayMs: 100 })

  async* run(request: Parameters<NonNullable<AgentInterface['run']>>[0], ctx: Parameters<NonNullable<AgentInterface['run']>>[1]): AsyncIterable<AgentEvent> {
    if (request.message.metadata?.['x-aw-task-kind'] === 'assign' && ctx.role === 'worker' && this.attempts++ === 0) {
      yield { kind: 'error', error: { code: 'TEST_TRANSIENT', message: 'transient test failure' } }
      return
    }
    yield* this.fallback.run(request, ctx)
  }
}

async function testRetryKeepsParentAlive(): Promise<void> {
  console.log('\n--- 6. 可重试子任务失败时不提前取消父任务 ---')
  const s = setup({ tickMs: 10, workerImpl: new FlakyWorkerImpl() })
  s.loop.start()
  const parent = submitTask(s, '可重试主任务', '[mock:complex] retry a transient worker failure')

  const retried = await waitUntil(() => {
    const child = s.engine.list(s.channelId).find(t => t.parentId === parent.id)
    return child?.retryCount === 1
  })
  const retriedChild = s.engine.list(s.channelId).find(t => t.parentId === parent.id)
  check('失败子任务被重派', retried, `parent=${s.engine.get(parent.id)?.state}`)
  check(
    '重试期间父任务保持 WAITING',
    s.engine.get(parent.id)?.state === 'WAITING'
    && (retriedChild?.state === 'ASSIGNED' || retriedChild?.state === 'WORKING'),
    `parent=${s.engine.get(parent.id)?.state} child=${retriedChild?.state}`,
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  check('重试成功后父任务完成', completed, `state=${s.engine.get(parent.id)?.state}`)

  await teardown(s)
}

class HeldWorkerImpl implements AgentInterface {
  started = false
  controlMessageCount = 0
  private releaseRun: (() => void) | undefined

  async* run(request: Parameters<NonNullable<AgentInterface['run']>>[0], ctx: Parameters<NonNullable<AgentInterface['run']>>[1]): AsyncIterable<AgentEvent> {
    const taskId = request.taskId
    if (request.message.metadata?.['x-aw-task-kind'] !== 'assign' || !taskId) {
      this.controlMessageCount += 1
      return
    }

    yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
    const gate = new Promise<void>((resolve) => {
      this.releaseRun = resolve
    })
    this.started = true
    await gate
    if (ctx.signal.aborted) return

    await ctx.workspace.completeTask(taskId, [testArtifact('watchdog-deliverable', 'worker-result', 'work completed after watchdog reminder')])
    yield { kind: 'done', final: { taskId } }
  }

  release(): void {
    this.releaseRun?.()
  }
}

async function testBusyStallWatchdogDoesNotCancel(): Promise<void> {
  console.log('\n--- 7. busy task watchdog 发出提醒但不取消进行中的工作 ---')
  const workerImpl = new HeldWorkerImpl()
  const s = setup({ tickMs: 10, stallMs: 25, leadImpl: new RecordingLeadImpl(() => []), workerImpl })
  const parent = submitTask(s, 'watchdog coordination task')
  s.engine.transition(parent.id, 'WORKING', s.lead.agentId)
  const child = s.engine.dispatch(parent, {
    assigneeId: s.worker.agentId,
    title: 'watchdog worker task',
    description: 'worker task for watchdog behavior',
  })
  s.worker.wakeMailbox()
  s.loop.start()

  const started = await waitUntil(() => workerImpl.started)
  await sleep(120)
  check('worker 已进入 held WORKING 回合', started && s.engine.get(child.id)?.state === 'WORKING')
  check('busy stall watchdog 不强制取消任务', s.engine.get(child.id)?.state === 'WORKING', `state=${s.engine.get(child.id)?.state}`)

  workerImpl.release()
  const childCompleted = await waitUntil(() => s.engine.get(child.id)?.state === 'COMPLETED')
  const notified = await waitUntil(() => workerImpl.controlMessageCount > 0)
  await sleep(40)
  check('释放后 worker 以交付完成 child', childCompleted && !!s.engine.get(child.id)?.artifacts.length)
  check('watchdog 提醒在回合结束后送达 worker', notified)
  check('空 supervise 后 ruleEngine 不验收 parent', s.engine.get(parent.id)?.state !== 'COMPLETED', `state=${s.engine.get(parent.id)?.state}`)
  check('ruleEngine 不延伸派发孙任务', !s.engine.list(s.channelId).some(task => task.parentId === child.id))

  await teardown(s)
}

async function testGoalModeRemainsLeadJudged(): Promise<void> {
  console.log('\n--- 8. 显式 goal 模式仍由 lead 判定并产出 goal-summary ---')
  const s = setup({ tickMs: 10, leadImpl: new MockAgentImpl({ delayMs: 0, goalRejectRounds: 1 }) })
  s.loop.start()
  const parent = submitTask(
    s,
    'goal mode task',
    encodeTaskMode('goal', { goalCriteria: 'deliver a verified result' }, 'explicit goal-mode test'),
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const task = s.engine.get(parent.id)
  check('goal 经补充判定后完成', completed, `state=${task?.state}`)
  check('goal 保留 goal-summary artifact', task?.artifacts.some(artifact => artifact.name === 'goal-summary') === true)
  check('goal 至少产生一次补充 child', s.engine.list(s.channelId).filter(item => item.parentId === parent.id).length >= 2)

  await teardown(s)
}

async function testPipelineModeRemainsOrdered(): Promise<void> {
  console.log('\n--- 9. 显式 pipeline 模式仍按阶段顺序推进并完成 ---')
  const s = setup({ tickMs: 10, leadImpl: new MockAgentImpl({ delayMs: 0 }) })
  s.loop.start()
  const parent = submitTask(
    s,
    'pipeline mode task',
    encodeTaskMode('pipeline', {
      stages: [
        { name: 'design', description: 'prepare the design' },
        { name: 'build', description: 'build the result' },
      ],
    }, 'explicit pipeline-mode test'),
  )

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  const children = s.engine.list(s.channelId).filter(task => task.parentId === parent.id)
  check('pipeline 全阶段完成后收口', completed, `state=${s.engine.get(parent.id)?.state}`)
  check(
    'pipeline child 按 design → build 顺序创建',
    children.length === 2 && children[0]?.title.includes('design') && children[1]?.title.includes('build'),
    children.map(task => task.title).join(' → '),
  )
  check('pipeline child 均已完成', children.length === 2 && children.every(task => task.state === 'COMPLETED'))

  await teardown(s)
}
async function testStopStopsScheduling(): Promise<void> {
  console.log('\n--- 10. stop 后不再调度 ---')
  const s = setup({ tickMs: 10 })
  s.loop.start()
  const first = submitTask(s, '任务一')
  const firstDone = await waitUntil(() => s.engine.get(first.id)?.state === 'COMPLETED')
  check('stop 前任务完整完成', firstDone)

  s.loop.stop()

  const second = submitTask(s, '任务二')
  await sleep(200)
  const state = s.engine.get(second.id)?.state
  const hasChild = s.engine.list(s.channelId).some(t => t.parentId === second.id)
  check('stop 后新任务不再被 dispatch', state === 'SUBMITTED' && !hasChild, `state=${state} hasChild=${hasChild}`)

  await teardown(s)
}

async function testLoopIntervalAndMaxIterations(): Promise<void> {
  console.log('\n--- 11. loop 模式:间隔生效 + maxIterations 后停止 ---')
  const s = setup({ tickMs: 10 })
  wireLoopResubmit(s)
  s.loop.start()

  const title = '循环任务'
  const intervalMs = 300
  const maxIterations = 2
  const first = submitLoopTask(s, title, { intervalMs, maxIterations })
  // mock lead dispatch 的子任务会继承父任务标题,统计主任务需排除子任务(parentId 存在)
  const parents = (): WorkspaceTask[] =>
    s.engine.list(s.channelId).filter(t => t.title === title && !t.parentId)

  // 首轮执行完成(此时才开始等待间隔)
  await waitUntil(() => s.engine.get(first.id)?.state === 'COMPLETED')
  check('loop 首轮执行完成', s.engine.get(first.id)?.state === 'COMPLETED')

  // 间隔后重提交:出现第 2 轮主任务,且间隔 ≥ intervalMs(从首轮完成时刻起算)
  const firstDoneAt = Date.now()
  const resubmitted = await waitUntil(() => {
    const same = parents()
    return same.length >= 2 && same[1]!.state === 'COMPLETED'
  }, 5000)
  const waitMs = Date.now() - firstDoneAt
  check('间隔后重提交并完成第 2 轮', resubmitted, `主任务数=${parents().length}`)
  check('等待时长 ≥ 配置间隔', waitMs >= intervalMs, `wait=${waitMs}ms interval=${intervalMs}ms`)

  // 达到 maxIterations=2 后不再重提交:再等数个间隔,主任务数仍为 2
  await sleep(intervalMs * 3)
  const finalCount = parents().length
  check('达到 maxIterations 后停止重提交', finalCount === maxIterations, `主任务数=${finalCount}(期望 ${maxIterations})`)

  // 全部主任务均完成(无残留半截循环)
  const loopTasks = parents()
  check('所有轮次主任务均完成', loopTasks.every(t => t.state === 'COMPLETED'), loopTasks.map(t => t.state).join(','))

  await teardown(s)
}

function testFactory(): void {
  console.log('\n--- 12. createAgentImpl 工厂 ---')
  const mk = (harness: string): AgentInfo => ({
    id: randomUUID(),
    channelId: 'ch',
    name: 'a',
    harness,
    role: 'worker',
    config: {},
  })

  check('mock → MockAgentImpl 实例', createAgentImpl(mk('mock')) instanceof MockAgentImpl)

  check('claude → ClaudeSdkAgentImpl 实例', createAgentImpl(mk('claude')) instanceof ClaudeSdkAgentImpl)

  try {
    createAgentImpl(mk('unknown'))
    check('未知 harness 抛 UNKNOWN_HARNESS', false, '未抛异常')
  }
  catch (e) {
    const err = e as AppError
    check(
      '未知 harness 抛 UNKNOWN_HARNESS',
      err instanceof AppError && err.code === 'UNKNOWN_HARNESS' && err.status === 400,
      `code=${err?.code} status=${err?.status}`,
    )
  }
}

async function main(): Promise<void> {
  await testSimpleTriage()
  await testComplexTriageRequiresLeadCloseout()
  await testWakeTriggersRound()
  await testSuperviseEmptyDoesNotFallback()
  await testLeadRetriesAfterEmptyDecision()
  await testSuperviseThrowDoesNotFallback()
  await testRetryKeepsParentAlive()
  await testBusyStallWatchdogDoesNotCancel()
  await testGoalModeRemainsLeadJudged()
  await testPipelineModeRemainsOrdered()
  await testStopStopsScheduling()
  await testLoopIntervalAndMaxIterations()
  testFactory()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
