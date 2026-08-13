/**
 * AgentChannelManager — 统一管理(对象化)。
 * Channel/Agent/Task 全是对象;所有作业方法做权限校验(lead/assignee/channel 作用域)。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import type { A2AMessage, A2AArtifact, Part } from '../types/a2a'
import type { TaskState, WorkspaceTask } from '../types/task'
import type { AgentInfo, AgentInterface, AgentWorkspace } from '../agents/agent-interface'
import type { ChannelRepo } from '../db/channel.repo'
import type { AgentRepo } from '../db/agent.repo'
import type { MessageRepo } from '../db/message.repo'
import type { SubscriptionRepo } from '../db/subscription.repo'
import type { TaskRepo, TaskPatch } from '../db/task.repo'
import { parseJson } from '../db/database'
import type { AgentRow, ChannelRow, TaskRow } from '../db/database'
import { Mailbox, rowToMessage } from './mailbox'
import { AgentRuntime } from './agent-runtime'
import type { ChannelBus, TaskEngine } from './agent-runtime'
import { ChannelRuntime } from './channel-runtime'
import { TaskEngine as TaskEngineImpl } from './task-engine'

/** 全部仓储(依赖注入) */
export interface AllRepos {
  channels: ChannelRepo
  agents: AgentRepo
  messages: MessageRepo
  subscriptions: SubscriptionRepo
  tasks: TaskRepo
}

/** Manager 依赖 */
export interface ManagerDeps {
  repos: AllRepos
  implFactory: (agent: AgentInfo) => AgentInterface
  taskEngineFactory?: (repos: { tasks: TaskRepo, messages: MessageRepo }) => TaskEngine
  db: DatabaseSync
}

/** AgentRow → AgentInfo(config 反序列化) */
function rowToAgentInfo(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    channelId: row.channelId,
    name: row.name,
    harness: row.harness,
    role: row.role as 'lead' | 'worker',
    config: parseJson<Record<string, unknown>>(row.configJson, {}),
    token: row.token,
  }
}

/** TaskRow → WorkspaceTask(artifacts/history 反序列化) */
function rowToTask(row: TaskRow): WorkspaceTask {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId ?? undefined,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId ?? '',
    title: row.title,
    description: row.description ?? undefined,
    state: row.state as TaskState,
    progress: row.progress,
    retryCount: row.retryCount,
    artifacts: parseJson<A2AArtifact[]>(row.artifactsJson, []),
    history: parseJson<A2AMessage[]>(row.historyJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 构造 A2AMessage(统一入口) */
function buildMessage(
  channelId: string,
  role: 'ROLE_USER' | 'ROLE_AGENT',
  parts: Part[],
  metadata: Record<string, unknown>,
): A2AMessage {
  return { messageId: randomUUID(), contextId: channelId, role, parts, metadata }
}

export class AgentChannelManager {
  private channels = new Map<string, ChannelRuntime>()
  private agentIndex = new Map<string, AgentRuntime>()
  private buses = new Map<string, ChannelBus>()
  private taskEngine: TaskEngine | null = null

  constructor(private deps: ManagerDeps) {}

  // ===== 运行时装配 =====

  private getTaskEngine(): TaskEngine {
    if (!this.taskEngine) {
      const factory = this.deps.taskEngineFactory ?? (r => new TaskEngineImpl(r))
      this.taskEngine = factory({ tasks: this.deps.repos.tasks, messages: this.deps.repos.messages })
    }
    return this.taskEngine
  }

  private ensureChannelRuntime(channelId: string): ChannelRuntime {
    let cr = this.channels.get(channelId)
    if (!cr) {
      cr = new ChannelRuntime(channelId, {
        taskEngine: this.getTaskEngine(),
        subscriptionRepo: this.deps.repos.subscriptions,
      })
      this.channels.set(channelId, cr)
      this.buses.set(channelId, this.buildBus(cr))
    }
    return cr
  }

  private buildBus(cr: ChannelRuntime): ChannelBus {
    const listeners: Array<(e: { taskId: string, state?: TaskState, progress?: number }) => void> = []
    return {
      // 事件广播由集成阶段(WS hub)监听 onTaskEvent;T3 仅做调度唤醒
      emit: () => {
        cr.wakeScheduler()
      },
      onTaskEvent: (fn) => {
        listeners.push(fn)
      },
      wakeScheduler: () => {
        cr.wakeScheduler()
      },
    }
  }

  private wireAgent(row: AgentRow): AgentRuntime {
    const agent = rowToAgentInfo(row)
    const cr = this.ensureChannelRuntime(row.channelId)
    const bus = this.buses.get(row.channelId)!
    const mailbox = new Mailbox(this.deps.repos.messages, agent.id, () => cr.wakeScheduler())
    const workspace = this.buildWorkspace(agent)
    const runtime = new AgentRuntime(agent, this.deps.implFactory(agent), {
      mailbox,
      taskEngine: this.getTaskEngine(),
      bus,
      workspace,
    })
    cr.addAgent(runtime)
    this.agentIndex.set(agent.id, runtime)
    runtime.start()
    return runtime
  }

  /** Agent 自主作业能力面(绑定本 agent 身份,委托 manager 作业方法) */
  private buildWorkspace(agent: AgentInfo): AgentWorkspace {
    return {
      listAgents: () => this.listAgents(agent.channelId),
      dispatchTask: input => this.dispatchTask(agent.id, input),
      listTasks: () => this.listTasks(agent.id),
      getTask: taskId => this.getTask(agent.id, taskId),
      reportTask: input => this.reportTask(agent.id, input),
      completeTask: (taskId, artifacts) => this.completeTask(agent.id, { taskId, artifacts }),
      cancelTask: taskId => this.cancelTask(agent.id, { taskId }),
      sendMessage: input => this.sendA2A(agent.id, input),
      pollMailbox: limit => this.pollMailbox(agent.id, limit),
      subscribe: input => this.subscribe(agent.id, input),
    }
  }

  // ===== 管理面 =====

  async createChannel(input: {
    name: string
    description?: string
    leadAgent?: { name: string, harness: string, config?: Record<string, unknown> }
  }): Promise<{ channelId: string, leadAgentId?: string }> {
    const channel = this.deps.repos.channels.create({ name: input.name, description: input.description })
    let leadAgentId: string | undefined
    if (input.leadAgent) {
      const lead = this.deps.repos.agents.create({
        channelId: channel.id,
        name: input.leadAgent.name,
        harness: input.leadAgent.harness,
        role: 'lead',
        token: randomUUID(),
        config: input.leadAgent.config,
      })
      this.deps.repos.channels.update(channel.id, { leadAgentId: lead.id })
      leadAgentId = lead.id
      this.wireAgent(lead)
    }
    return { channelId: channel.id, leadAgentId }
  }

  async listChannels(): Promise<ChannelRow[]> {
    return this.deps.repos.channels.list()
  }

  async removeChannel(channelId: string): Promise<void> {
    const cr = this.channels.get(channelId)
    if (cr) {
      for (const agent of cr.getAgents()) {
        await agent.stop()
        this.agentIndex.delete(agent.agentId)
      }
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
    this.deps.repos.channels.remove(channelId)
  }

  async createAgent(input: {
    channelId: string
    name: string
    harness: string
    role: 'lead' | 'worker'
    config?: Record<string, unknown>
  }): Promise<AgentInfo> {
    // lead 唯一校验:channel 已有 lead 则拒绝
    if (input.role === 'lead') {
      const channel = this.deps.repos.channels.findById(input.channelId)
      if (channel && channel.leadAgentId) {
        throw new AppError(409, 'LEAD_EXISTS', `channel ${input.channelId} 已存在 lead`)
      }
    }
    const row = this.deps.repos.agents.create({
      channelId: input.channelId,
      name: input.name,
      harness: input.harness,
      role: input.role,
      token: randomUUID(),
      config: input.config,
    })
    if (input.role === 'lead') {
      this.deps.repos.channels.update(input.channelId, { leadAgentId: row.id })
    }
    this.wireAgent(row)
    return rowToAgentInfo(row)
  }

  async listAgents(channelId: string): Promise<AgentInfo[]> {
    return this.deps.repos.agents.listByChannel(channelId).map(rowToAgentInfo)
  }

  async removeAgent(agentId: string): Promise<void> {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) return
    const cr = this.channels.get(row.channelId)
    if (cr) await cr.removeAgent(agentId)
    this.agentIndex.delete(agentId)
    this.deps.repos.agents.remove(agentId)
    if (row.role === 'lead') {
      this.deps.repos.channels.update(row.channelId, { leadAgentId: null })
    }
  }

  // ===== 作业面 =====

  async submitChannelTask(input: {
    channelId: string
    title: string
    description?: string
    parts?: Part[]
  }): Promise<WorkspaceTask> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel || !channel.leadAgentId) {
      throw new AppError(400, 'NO_LEAD_AGENT', `channel ${input.channelId} 无 lead,请先创建 lead`)
    }
    const task = this.getTaskEngine().create({
      channelId: input.channelId,
      creatorId: '',
      assigneeId: channel.leadAgentId,
      title: input.title,
      description: input.description,
      parts: input.parts,
    })
    const message = buildMessage(input.channelId, 'ROLE_USER', input.parts ?? [], {
      'x-aw-task-kind': 'assign',
      'x-aw-task-id': task.id,
    })
    message.taskId = task.id
    this.route(input.channelId, message)
    this.ensureChannelRuntime(input.channelId).wakeScheduler()
    return task
  }

  async dispatchTask(
    callerAgentId: string,
    input: {
      parentTaskId?: string
      assigneeId: string
      title: string
      description?: string
      parts?: Part[]
    },
  ): Promise<WorkspaceTask> {
    const caller = this.requireAgent(callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可 dispatch 任务')
    }
    const assignee = this.deps.repos.agents.findById(input.assigneeId)
    if (!assignee || assignee.channelId !== caller.channelId) {
      throw new AppError(403, 'SCOPE_VIOLATION', 'assignee 不在本 channel')
    }
    let task: WorkspaceTask
    if (input.parentTaskId) {
      const parent = this.getTaskEngine().get(input.parentTaskId)
      if (!parent) throw new AppError(404, 'NOT_FOUND', `父任务不存在: ${input.parentTaskId}`)
      if (parent.channelId !== caller.channelId) {
        throw new AppError(403, 'SCOPE_VIOLATION', '父任务不在本 channel')
      }
      task = this.getTaskEngine().dispatch(parent, {
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
      })
      // dispatch 直接落库投递 assign 消息 → 唤醒 assignee 消费
      this.wakeAgent(input.assigneeId)
    }
    else {
      // 无父任务:创建 ASSIGNED 顶层子任务并 route 投递(route 已唤醒)
      task = this.getTaskEngine().create({
        channelId: caller.channelId,
        creatorId: callerAgentId,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
      })
      task = this.getTaskEngine().transition(task.id, 'ASSIGNED', callerAgentId)
      const message = buildMessage(caller.channelId, 'ROLE_USER', input.parts ?? [], {
        'x-aw-task-kind': 'assign',
        'x-aw-task-id': task.id,
        'x-aw-from-agent': callerAgentId,
      })
      message.taskId = task.id
      this.route(caller.channelId, message)
    }
    return task
  }

  async reportTask(
    callerAgentId: string,
    input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(callerAgentId, input.taskId)
    if (task.assigneeId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 assignee 可上报任务')
    }
    const patch: TaskPatch = {}
    if (input.progress !== undefined) patch.progress = input.progress
    if (input.artifact) patch.artifacts = [...task.artifacts, input.artifact]
    if (input.message) {
      patch.history = [
        ...task.history,
        { messageId: randomUUID(), contextId: task.channelId, role: 'ROLE_AGENT' as const, parts: [{ text: input.message }] },
      ]
    }
    const updated = this.deps.repos.tasks.update(input.taskId, patch)
    return rowToTask(updated!)
  }

  async completeTask(
    callerAgentId: string,
    input: { taskId: string, artifacts?: A2AArtifact[] },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(callerAgentId, input.taskId)
    if (task.assigneeId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 assignee 可完成任务')
    }
    const completed = this.getTaskEngine().complete(input.taskId, input.artifacts)
    if (completed.parentId) {
      // 子任务完成 → 投递 child-completed 给父 assignee + 父任务 WAITING→WORKING 判定
      this.getTaskEngine().onChildCompleted(completed)
      const parent = this.getTaskEngine().get(completed.parentId)
      if (parent) this.wakeAgent(parent.assigneeId)
    }
    return completed
  }

  async cancelTask(callerAgentId: string, input: { taskId: string }): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(callerAgentId, input.taskId)
    const caller = this.requireAgent(callerAgentId)
    const isLead = caller.role === 'lead'
    const isCreator = task.creatorId === callerAgentId
    if (!isLead && !isCreator) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead/creator 可取消任务')
    }
    const canceled = this.getTaskEngine().cancel(input.taskId, callerAgentId)
    // 中断 assignee 运行中的 run(卡死回收)
    this.agentIndex.get(canceled.assigneeId)?.abortCurrent()
    this.wakeAgent(canceled.assigneeId)
    return canceled
  }

  async listTasks(callerAgentId: string): Promise<WorkspaceTask[]> {
    const caller = this.requireAgent(callerAgentId)
    return this.deps.repos.tasks.listByChannel(caller.channelId).map(rowToTask)
  }

  async getTask(callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    return this.requireTaskInScope(callerAgentId, taskId)
  }

  async sendA2A(
    callerAgentId: string,
    input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> },
  ): Promise<A2AMessage> {
    const caller = this.requireAgent(callerAgentId)
    const target = this.deps.repos.agents.findById(input.toAgentId)
    if (!target || target.channelId !== caller.channelId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '目标 Agent 不在本 channel')
    }
    const message = buildMessage(caller.channelId, 'ROLE_AGENT', input.parts, {
      ...(input.metadata ?? {}),
      'x-aw-target-agent': input.toAgentId,
      'x-aw-from-agent': callerAgentId,
    })
    this.route(caller.channelId, message)
    return message
  }

  async pollMailbox(callerAgentId: string, limit = 100): Promise<A2AMessage[]> {
    this.requireAgent(callerAgentId)
    return this.deps.repos.messages
      .listPendingByAgent(callerAgentId)
      .slice(0, limit)
      .map(rowToMessage)
  }

  async subscribe(callerAgentId: string, input: { agentIds?: string[] }): Promise<void> {
    const caller = this.requireAgent(callerAgentId)
    for (const targetId of input.agentIds ?? []) {
      const target = this.deps.repos.agents.findById(targetId)
      if (!target || target.channelId !== caller.channelId) {
        throw new AppError(403, 'SCOPE_VIOLATION', `目标 Agent ${targetId} 不在本 channel`)
      }
      this.deps.repos.subscriptions.add(callerAgentId, targetId)
    }
  }

  findByToken(token: string): AgentInfo | undefined {
    const row = this.deps.repos.agents.findByToken(token)
    return row ? rowToAgentInfo(row) : undefined
  }

  /** 启动恢复:enabled channels/agents 重建运行时;consuming 重置;非终态任务重置 ASSIGNED */
  async restore(): Promise<void> {
    this.deps.repos.messages.resetConsuming()
    for (const row of this.deps.repos.tasks.listNonTerminal()) {
      this.deps.repos.tasks.update(row.id, { state: 'ASSIGNED' })
    }
    for (const channel of this.deps.repos.channels.list()) {
      if (channel.enabled !== 1) continue
      this.ensureChannelRuntime(channel.id)
      for (const agentRow of this.deps.repos.agents.listByChannel(channel.id)) {
        if (agentRow.enabled !== 1) continue
        if (this.agentIndex.has(agentRow.id)) continue
        this.wireAgent(agentRow)
      }
    }
  }

  // ===== 内部辅助 =====

  private route(channelId: string, message: A2AMessage): void {
    this.ensureChannelRuntime(channelId).route(message)
  }

  private wakeAgent(agentId: string): void {
    this.agentIndex.get(agentId)?.wakeMailbox()
  }

  private requireAgent(callerAgentId: string): AgentRow {
    const row = this.deps.repos.agents.findById(callerAgentId)
    if (!row) throw new AppError(403, 'SCOPE_VIOLATION', '调用方 Agent 不存在')
    return row
  }

  private requireTaskInScope(callerAgentId: string, taskId: string): WorkspaceTask {
    const caller = this.requireAgent(callerAgentId)
    const row = this.deps.repos.tasks.findById(taskId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    if (row.channelId !== caller.channelId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '任务不在本 channel')
    }
    return rowToTask(row)
  }
}

/** 工厂:创建 manager(测试与集成均可注入依赖) */
export function createAgentChannelManager(deps: ManagerDeps): AgentChannelManager {
  return new AgentChannelManager(deps)
}

let managerSingleton: AgentChannelManager | null = null

/**
 * 装配并返回进程单例(依赖就绪后由 plugin 调用)。
 * 用 getter 而非 mutable export,避免可写导出被误改。
 */
export function initWorkshopManager(deps: ManagerDeps): AgentChannelManager {
  managerSingleton = new AgentChannelManager(deps)
  return managerSingleton
}

/** 读取进程单例(未装配返回 null) */
export function getWorkshopManagerOrNull(): AgentChannelManager | null {
  return managerSingleton
}
