/**
 * SchedulerLoop 调度循环测试 —— 共享框架与场景搭建辅助。
 *
 * 装配:真实 :memory: repo + 真实 TaskEngine + 真实 ChannelRuntime + 真实 Mailbox
 *      + 真实 AgentRuntime(MockAgentImpl lead/worker)+ 真实 SchedulerLoop。
 * 12 个场景按主题拆到同目录 scenarios-*.ts,固定调用顺序由 main.ts 维护。
 */
import { randomUUID } from 'node:crypto'
import { openWorkshopDb } from '../../server/services/workshop/db/database'
import { createChannelRepo } from '../../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../../server/services/workshop/db/task.repo'
import type { TaskPatch } from '../../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../../server/services/workshop/db/subscription.repo'
import { TaskEngine } from '../../server/services/workshop/runtime/task-engine'
import { ChannelRuntime } from '../../server/services/workshop/runtime/channel-runtime'
import { AgentRuntime } from '../../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus } from '../../server/services/workshop/runtime/agent-runtime'
import { Mailbox, rowToMessage } from '../../server/services/workshop/runtime/mailbox'
import { SchedulerLoop } from '../../server/services/workshop/runtime/scheduler-loop'
import { MockAgentImpl } from '../../server/services/workshop/agents/mock-agent'
import { encodeTaskMode, type ModeConfig } from '../../server/services/workshop/runtime/execution-mode'
import type {
  AgentEvent,
  AgentInfo,
  AgentRunContext,
  AgentInterface,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../../server/services/workshop/agents/agent-interface'
import type { A2AArtifact, A2AMessage, ChannelMail } from '../../server/services/workshop/types/a2a'
import { AppError } from '../../server/utils/errors'

let failures = 0
export function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 断言失败计数(供 main.ts 打印汇总行与决定退出码);自增仍只发生在断言 helper 内 */
export function failureCount(): number {
  return failures
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
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

export interface Setup {
  engine: TaskEngine
  cr: ChannelRuntime
  lead: AgentRuntime
  worker: AgentRuntime
  workers: AgentRuntime[]
  channelId: string
  loop: SchedulerLoop
}

export interface SetupOptions {
  tickMs?: number
  stallMs?: number
  workerCount?: number
  leadImpl?: AgentInterface
  workerImpl?: AgentInterface
}

export function setup(opts: SetupOptions = {}): Setup {
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

export async function teardown(s: Setup): Promise<void> {
  s.loop.stop()
  await Promise.all([s.lead.stop(), ...s.workers.map(worker => worker.stop())])
}

export function submitTask(s: Setup, title: string, description = '统筹交付') {
  return s.engine.create({
    channelId: s.channelId,
    creatorId: '',
    assigneeId: s.lead.agentId,
    title,
    description,
  })
}

/** 提交 loop 模式主任务(描述按 [mode:loop][interval:..][max:..] 编码,与 manager.submitChannelTask 同构) */
export function submitLoopTask(s: Setup, title: string, config: ModeConfig) {
  return s.engine.create({
    channelId: s.channelId,
    creatorId: '',
    assigneeId: s.lead.agentId,
    title,
    description: encodeTaskMode('loop', config, '循环测试任务'),
  })
}

/** 模拟 manager 的 loop 重提交回调:原样创建新一轮主任务(经调度循环 dispatch 给 worker) */
export function wireLoopResubmit(s: Setup): void {
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

export interface SupervisionRecord {
  snapshot: SupervisionSnapshot
  decisions?: SupervisionDecision[]
  error?: unknown
}

export type SuperviseScript = (
  snapshot: SupervisionSnapshot,
  ctx: AgentRunContext,
) => SupervisionDecision[] | Promise<SupervisionDecision[]>

/** 记录公开调度快照和 lead 决策,不依赖 harness prompt 文本。 */
export class RecordingLeadImpl implements AgentInterface {
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

export function testArtifact(artifactId: string, name: string, text: string): A2AArtifact {
  return { artifactId, name, parts: [{ text }] }
}

export class RecordingMockLeadImpl extends MockAgentImpl {
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
