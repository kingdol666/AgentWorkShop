/**
 * AgentChannelManager — 统一管理(对象化)。
 * Channel / Agent 模板 / Channel Agent 实例 全是对象;所有作业方法做权限校验(lead/assignee/channel 作用域)。
 *
 * v3:Agent 模板与 Channel 实例分离:
 * - Agent 模板(agents):全局可复用数据结构(name/harness/config/enabled)
 * - Channel 实例(channel_agents):每次把模板放入 channel 都克隆出独立身份 id 的新实例
 *   (name/harness/config 复制自模板,另含独立 role + token)
 * - 每个实例在各自 channel 独立装配 AgentRuntime(独立 mailbox/impl 子进程/状态)
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import type { A2AMessage, A2AArtifact, Part } from '../types/a2a'
import type { TaskState, WorkspaceTask } from '../types/task'
import type { AgentInfo, AgentInterface, AgentWorkspace, AgentEvent, ExecutionMode } from '../agents/agent-interface'
import type { ModeConfig } from './execution-mode'
import { encodeTaskMode } from './execution-mode'
import type { ChannelRepo } from '../db/channel.repo'
import type { AgentRepo } from '../db/agent.repo'
import type { ChannelAgentRepo } from '../db/channel-agent.repo'
import type { MessageRepo } from '../db/message.repo'
import type { SubscriptionRepo } from '../db/subscription.repo'
import type { TaskRepo, TaskPatch } from '../db/task.repo'
import { parseJson } from '../db/database'
import type { AgentRow, ChannelAgentRow, ChannelRow, TaskRow } from '../db/database'
import { Mailbox, rowToMessage } from './mailbox'
import { AgentRuntime } from './agent-runtime'
import type { ChannelBus, TaskEngine } from './agent-runtime'
import { ChannelRuntime } from './channel-runtime'
import { SchedulerLoop, type SchedulerLoopOptions } from './scheduler-loop'
import { TaskEngine as TaskEngineImpl } from './task-engine'

/** 全部仓储(依赖注入) */
export interface AllRepos {
  channels: ChannelRepo
  agents: AgentRepo
  channelAgents: ChannelAgentRepo
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

/** Agent 模板详情(全局;含其克隆出的全部实例) */
export interface AgentTemplateDetail {
  id: string
  name: string
  harness: string
  config: Record<string, unknown>
  enabled: number
  /** 该模板克隆出的全部实例(跨 channel) */
  instances: Array<{ id: string, channelId: string, role: 'lead' | 'worker', token: string }>
  createdAt: string
  updatedAt: string
}

/** ChannelAgentRow → AgentInfo(实例视图:实例 id + 本 channel 的 role/token + 复制的 name/harness/config) */
function instanceToAgentInfo(m: ChannelAgentRow): AgentInfo {
  return {
    id: m.id,
    channelId: m.channelId,
    name: m.name,
    harness: m.harness,
    role: m.role as 'lead' | 'worker',
    config: parseJson<Record<string, unknown>>(m.configJson, {}),
    token: m.token,
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

/** 运行时实例复合键(channel, 实例) */
function runtimeKey(channelId: string, agentId: string): string {
  return `${channelId}\u0000${agentId}`
}

export class AgentChannelManager {
  private channels = new Map<string, ChannelRuntime>()
  /** 键 = runtimeKey(channelId, 实例 id);每个实例一个独立运行时 */
  private agentIndex = new Map<string, AgentRuntime>()
  private buses = new Map<string, ChannelBus>()
  private taskEngine: TaskEngine | null = null
  private idleSweeperTimer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: ManagerDeps) {}

  // ===== 运行时装配 =====

  private getTaskEngine(): TaskEngine {
    if (!this.taskEngine) {
      const factory = this.deps.taskEngineFactory ?? (r => new TaskEngineImpl(r, {
        onTaskChange: (e) => {
          this.buses.get(e.channelId)?.notifyTask({ taskId: e.taskId, state: e.state, agentId: e.agentId })
        },
      }))
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
        channelAgents: this.deps.repos.channelAgents,
      })
      cr.setLoader(id => this.ensureAgentRuntime(channelId, id))
      this.channels.set(channelId, cr)
      this.buses.set(channelId, this.buildBus(cr))
    }
    return cr
  }

  private buildBus(cr: ChannelRuntime): ChannelBus {
    const eventListeners = new Set<(event: AgentEvent, source: A2AMessage) => void>()
    const taskListeners = new Set<(e: { taskId: string, state?: TaskState, progress?: number }) => void>()
    const agentListeners = new Set<(e: { agentId: string, state: 'idle' | 'busy' | 'stopped' }) => void>()
    return {
      emit: (event, source) => {
        for (const fn of eventListeners) {
          try {
            fn(event, source)
          }
          catch (err) {
            console.error('[ChannelBus] event listener error:', err)
          }
        }
        cr.wakeScheduler()
      },
      onEvent: (fn) => {
        eventListeners.add(fn)
        return () => eventListeners.delete(fn)
      },
      notifyTask: (e) => {
        for (const fn of taskListeners) {
          try {
            fn(e)
          }
          catch (err) {
            console.error('[ChannelBus] task listener error:', err)
          }
        }
      },
      onTaskEvent: (fn) => {
        taskListeners.add(fn)
      },
      notifyAgent: (e) => {
        for (const fn of agentListeners) {
          try {
            fn(e)
          }
          catch (err) {
            console.error('[ChannelBus] agent listener error:', err)
          }
        }
      },
      onAgentStatus: (fn) => {
        agentListeners.add(fn)
      },
      wakeScheduler: () => {
        cr.wakeScheduler()
      },
    }
  }

  subscribeAgentStatus(channelId: string, fn: (e: { agentId: string, state: 'idle' | 'busy' | 'stopped' }) => void): () => void {
    const bus = this.buses.get(channelId)
    if (!bus) return () => {}
    bus.onAgentStatus(fn)
    return () => {}
  }

  subscribeChannelEvents(channelId: string, fn: (event: AgentEvent, source: A2AMessage) => void): () => void {
    return this.buses.get(channelId)?.onEvent(fn) ?? (() => {})
  }

  subscribeTaskEvents(channelId: string, fn: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string }) => void): () => void {
    const bus = this.buses.get(channelId)
    if (!bus) return () => {}
    bus.onTaskEvent(fn)
    return () => {}
  }

  private notifyTask(
    channelId: string,
    e: { taskId: string, state?: TaskState, progress?: number, agentId?: string },
  ): void {
    this.buses.get(channelId)?.notifyTask(e)
  }

  /** 按实例装配 AgentRuntime(每个实例一个独立运行时) */
  private wireMember(m: ChannelAgentRow): AgentRuntime {
    const agent = instanceToAgentInfo(m)
    const cr = this.ensureChannelRuntime(m.channelId)
    const bus = this.buses.get(m.channelId)!
    const mailbox = new Mailbox(this.deps.repos.messages, m.channelId, agent.id, () => cr.wakeScheduler())
    const workspace = this.buildWorkspace(agent)
    const chWorkspace = this.channelWorkspace(m.channelId)
    const agentWithCwd: AgentInfo = chWorkspace.length > 0
      ? { ...agent, config: { cwd: chWorkspace, ...agent.config } }
      : agent
    const runtime = new AgentRuntime(agent, this.deps.implFactory(agentWithCwd), {
      mailbox,
      taskEngine: this.getTaskEngine(),
      bus,
      workspace,
    })
    cr.addAgent(runtime)
    this.agentIndex.set(runtimeKey(m.channelId, agent.id), runtime)
    runtime.start()
    return runtime
  }

  /** 按需装配实例运行时(幂等):已装配返回缓存,否则从实例行 wire;禁用/不存在返回 undefined */
  private ensureAgentRuntime(channelId: string, agentId: string): AgentRuntime | undefined {
    const key = runtimeKey(channelId, agentId)
    const existing = this.agentIndex.get(key)
    if (existing) return existing
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m || m.enabled !== 1) return undefined
    return this.wireMember(m)
  }

  private runtimeOf(channelId: string, agentId: string): AgentRuntime | undefined {
    return this.agentIndex.get(runtimeKey(channelId, agentId))
  }

  /** 激活 channel:装配 lead 运行时 + 装配并启动 SchedulerLoop(幂等) */
  ensureChannelActive(channelId: string, options?: SchedulerLoopOptions): void {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel || channel.enabled !== 1 || !channel.leadAgentId) return
    const cr = this.ensureChannelRuntime(channelId)
    if (cr.scheduler) return
    const lead = this.ensureAgentRuntime(channelId, channel.leadAgentId)
    if (!lead) return
    const loop = new SchedulerLoop(cr, lead, options)
    loop.setLoopResubmitCallback((title, description) => {
      this.submitChannelTask({ channelId, title, description }).catch((err) => {
        console.error(`[AgentChannelManager:${channelId}] loop 重新提交失败:`, err)
      })
    })
    cr.scheduler = loop
    loop.start()
  }

  /** 停止并卸载某实例运行时(强制;删除实例/channel 时用) */
  private async stopAndDetach(channelId: string, agentId: string): Promise<void> {
    const key = runtimeKey(channelId, agentId)
    const runtime = this.agentIndex.get(key)
    if (!runtime) return
    const cr = this.channels.get(channelId)
    if (runtime.role === 'lead' && cr) {
      cr.scheduler?.stop()
      cr.scheduler = null
    }
    await runtime.stop()
    cr?.detachAgent(agentId)
    this.agentIndex.delete(key)
    if (cr && cr.getAgents().length === 0 && !cr.scheduler) {
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
  }

  /** 卸载实例运行时(空闲后释放内存,杀 omp 子进程);busy/有 pending/lead 有活跃任务 → 跳过 */
  async unloadAgent(channelId: string, agentId: string): Promise<void> {
    const runtime = this.runtimeOf(channelId, agentId)
    if (!runtime) return
    if (runtime.getState() !== 'idle') return
    if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
    if (runtime.role === 'lead') {
      const tasks = this.getTaskEngine().list(runtime.channelId)
      const hasActive = tasks.some(t => t.state !== 'COMPLETED' && t.state !== 'CANCELED' && t.state !== 'FAILED')
      if (hasActive) return
    }
    await this.stopAndDetach(channelId, agentId)
  }

  async unloadIdleAgents(): Promise<void> {
    for (const rt of [...this.agentIndex.values()]) {
      await this.unloadAgent(rt.channelId, rt.agentId)
    }
  }

  startIdleSweeper(options?: { intervalMs?: number, graceMs?: number }): () => void {
    const intervalMs = options?.intervalMs ?? 60_000
    const graceMs = options?.graceMs ?? 120_000
    const idleSince = new Map<string, number>()
    this.idleSweeperTimer = setInterval(() => {
      const now = Date.now()
      for (const rt of [...this.agentIndex.values()]) {
        const key = runtimeKey(rt.channelId, rt.agentId)
        if (rt.getState() === 'idle') {
          const since = idleSince.get(key) ?? now
          idleSince.set(key, since)
          if (now - since >= graceMs) {
            idleSince.delete(key)
            this.unloadAgent(rt.channelId, rt.agentId).catch((err) => {
              console.error(`[AgentChannelManager] 卸载 ${rt.channelId}/${rt.agentId} 失败:`, err)
            })
          }
        }
        else {
          idleSince.delete(key)
        }
      }
    }, intervalMs)
    return () => {
      if (this.idleSweeperTimer) {
        clearInterval(this.idleSweeperTimer)
        this.idleSweeperTimer = null
      }
    }
  }

  runtimeStatus(): { wiredAgents: string[], activeChannels: string[] } {
    return {
      wiredAgents: [...this.agentIndex.values()].map(rt => rt.agentId),
      activeChannels: [...this.channels.keys()],
    }
  }

  async shutdown(): Promise<void> {
    if (this.idleSweeperTimer) {
      clearInterval(this.idleSweeperTimer)
      this.idleSweeperTimer = null
    }
    for (const cr of this.channels.values()) {
      cr.scheduler?.stop()
      cr.scheduler = null
    }
    await Promise.all([...this.agentIndex.values()].map(a => a.stop()))
    this.agentIndex.clear()
    this.channels.clear()
    this.buses.clear()
  }

  /** Agent 自主作业能力面(绑定本实例身份与 channel,委托 manager 作业方法) */
  private buildWorkspace(agent: AgentInfo): AgentWorkspace {
    const channelId = agent.channelId
    return {
      listAgents: () => this.listChannelAgents(channelId),
      dispatchTask: input => this.dispatchTask(channelId, agent.id, input),
      listTasks: () => this.listTasks(channelId, agent.id),
      getTask: taskId => this.getTask(channelId, agent.id, taskId),
      reportTask: input => this.reportTask(channelId, agent.id, input),
      completeTask: (taskId, artifacts) => this.completeTask(channelId, agent.id, { taskId, artifacts }),
      cancelTask: taskId => this.cancelTask(channelId, agent.id, { taskId }),
      sendMessage: input => this.sendA2A(channelId, agent.id, input),
      pollMailbox: limit => this.pollMailbox(channelId, agent.id, limit),
      subscribe: input => this.subscribe(channelId, agent.id, input),
    }
  }

  // ===== Channel 管理面 =====

  async createChannel(input: {
    name: string
    description?: string
    workspace?: string
    leadAgent?: { name: string, harness: string, config?: Record<string, unknown> }
  }): Promise<{ channelId: string, leadAgentId?: string, workspace: string }> {
    const channel = this.deps.repos.channels.create({ name: input.name, description: input.description })
    const workspace = input.workspace && input.workspace.length > 0
      ? input.workspace
      : resolve(process.cwd(), 'data', 'workspaces', channel.id)
    this.deps.repos.channels.update(channel.id, { workspace })
    this.ensureWorkspaceDir(workspace)

    let leadAgentId: string | undefined
    if (input.leadAgent) {
      const tpl = this.deps.repos.agents.create({
        name: input.leadAgent.name,
        harness: input.leadAgent.harness,
        config: input.leadAgent.config,
      })
      const inst = this.deps.repos.channelAgents.create({
        channelId: channel.id,
        templateId: tpl.id,
        name: tpl.name,
        harness: tpl.harness,
        config: parseJson<Record<string, unknown>>(tpl.configJson, {}),
        role: 'lead',
      })
      this.deps.repos.channels.update(channel.id, { leadAgentId: inst.id })
      leadAgentId = inst.id
      // 懒加载:仅持久化,不装配运行时;首次任务提交时 ensureChannelActive 触发装配
    }
    return { channelId: channel.id, leadAgentId, workspace }
  }

  async getChannel(channelId: string): Promise<ChannelRow & { agents: AgentInfo[] }> {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    const agents = await this.listChannelAgents(channelId)
    return { ...channel, agents }
  }

  async updateChannel(channelId: string, patch: { name?: string, description?: string, workspace?: string, enabled?: number }): Promise<ChannelRow> {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    if (patch.workspace !== undefined && patch.workspace !== channel.workspace) {
      this.ensureWorkspaceDir(patch.workspace)
      await this.unloadChannelAgents(channelId)
    }
    if (patch.enabled === 0 && channel.enabled !== 0) {
      await this.unloadChannelAgents(channelId)
    }
    const updated = this.deps.repos.channels.update(channelId, patch)
    return updated!
  }

  private async unloadChannelAgents(channelId: string): Promise<void> {
    const cr = this.channels.get(channelId)
    if (cr) {
      cr.scheduler?.stop()
      cr.scheduler = null
      for (const agent of [...cr.getAgents()]) {
        await agent.stop()
        cr.detachAgent(agent.agentId)
        this.agentIndex.delete(runtimeKey(channelId, agent.agentId))
      }
      if (cr.getAgents().length === 0) {
        this.channels.delete(channelId)
        this.buses.delete(channelId)
      }
    }
  }

  async updateChannelWorkspace(channelId: string, workspace: string): Promise<ChannelRow> {
    return this.updateChannel(channelId, { workspace })
  }

  private ensureWorkspaceDir(workspace: string): void {
    mkdirSync(workspace, { recursive: true })
  }

  private channelWorkspace(channelId: string): string {
    return this.deps.repos.channels.findById(channelId)?.workspace ?? ''
  }

  async listChannels(): Promise<ChannelRow[]> {
    return this.deps.repos.channels.list()
  }

  async removeChannel(channelId: string): Promise<void> {
    const cr = this.channels.get(channelId)
    if (cr) {
      cr.scheduler?.stop()
      cr.scheduler = null
      for (const agent of [...cr.getAgents()]) {
        await agent.stop()
        this.agentIndex.delete(runtimeKey(channelId, agent.agentId))
      }
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
    this.deps.repos.channels.remove(channelId)
  }

  // ===== Agent 模板管理面(全局,可复用) =====

  /** 创建 Agent 模板(可复用数据结构) */
  async createAgent(input: {
    name: string
    harness: string
    config?: Record<string, unknown>
  }): Promise<AgentTemplateDetail> {
    const row = this.deps.repos.agents.create({ name: input.name, harness: input.harness, config: input.config })
    return this.templateDetailOf(row)
  }

  /** 列出全部 Agent 模板(全局) */
  async listAgents(): Promise<AgentTemplateDetail[]> {
    return this.deps.repos.agents.list().map(row => this.templateDetailOf(row))
  }

  /** Agent 模板详情(含其克隆出的全部实例) */
  getAgent(agentId: string): AgentTemplateDetail | undefined {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) return undefined
    return this.templateDetailOf(row)
  }

  /** 更新 Agent 模板(name/harness/config/enabled);不影响已克隆实例(复制语义) */
  async updateAgent(agentId: string, patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number }): Promise<AgentTemplateDetail> {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${agentId}`)
    const updated = this.deps.repos.agents.update(agentId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${agentId}`)
    return this.templateDetailOf(updated)
  }

  /** 删除 Agent 模板(实例保留,template_id 置空) */
  async removeAgent(agentId: string): Promise<void> {
    if (!this.deps.repos.agents.findById(agentId)) return
    this.deps.repos.agents.remove(agentId)
  }

  private templateDetailOf(row: AgentRow): AgentTemplateDetail {
    const instances = this.deps.repos.channelAgents.listByTemplate(row.id)
    return {
      id: row.id,
      name: row.name,
      harness: row.harness,
      config: parseJson<Record<string, unknown>>(row.configJson, {}),
      enabled: row.enabled,
      instances: instances.map(i => ({ id: i.id, channelId: i.channelId, role: i.role as 'lead' | 'worker', token: i.token })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== Channel 实例管理面 =====

  /** 把 Agent 模板放入 channel → 克隆出独立身份 id 的新实例(复制 name/harness/config) */
  async addAgentToChannel(input: {
    channelId: string
    agentId: string
    role: 'lead' | 'worker'
  }): Promise<AgentInfo> {
    const tpl = this.deps.repos.agents.findById(input.agentId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${input.agentId}`)
    if (input.role === 'lead') {
      const channel = this.deps.repos.channels.findById(input.channelId)
      if (channel && channel.leadAgentId) {
        throw new AppError(409, 'LEAD_EXISTS', `channel ${input.channelId} 已存在 lead`)
      }
    }
    const inst = this.deps.repos.channelAgents.create({
      channelId: input.channelId,
      templateId: tpl.id,
      name: tpl.name,
      harness: tpl.harness,
      config: parseJson<Record<string, unknown>>(tpl.configJson, {}),
      role: input.role,
    })
    if (input.role === 'lead') {
      this.deps.repos.channels.update(input.channelId, { leadAgentId: inst.id })
    }
    return instanceToAgentInfo(inst)
  }

  /** channel 实例列表 */
  async listChannelAgents(channelId: string): Promise<AgentInfo[]> {
    return this.deps.repos.channelAgents.listByChannel(channelId).map(instanceToAgentInfo)
  }

  /** 实例详情(含运行时装配状态) */
  getChannelAgent(instanceId: string): (AgentInfo & { wired: boolean, runtimeState: 'idle' | 'busy' | 'stopped' | null }) | undefined {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) return undefined
    const rt = this.runtimeOf(m.channelId, instanceId)
    return {
      ...instanceToAgentInfo(m),
      wired: rt !== undefined,
      runtimeState: rt ? rt.getState() : null,
    }
  }

  /** 更新实例(name/harness/config/enabled);变更后卸载已装配运行时以重载 */
  async updateChannelAgent(instanceId: string, patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number }): Promise<AgentInfo> {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    const updated = this.deps.repos.channelAgents.update(instanceId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    await this.unloadAgent(updated.channelId, instanceId)
    return instanceToAgentInfo(updated)
  }

  /** 从 channel 移除实例(仅删实例,不删模板) */
  async removeAgentFromChannel(channelId: string, instanceId: string): Promise<void> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, instanceId)
    if (!m) return
    await this.stopAndDetach(channelId, instanceId)
    if (m.role === 'lead') {
      this.deps.repos.channels.update(channelId, { leadAgentId: null })
    }
    this.deps.repos.subscriptions.removeByAgent(channelId, instanceId)
    this.deps.repos.channelAgents.remove(channelId, instanceId)
  }

  // ===== 任务作业面 =====

  async submitChannelTask(input: {
    channelId: string
    title: string
    description?: string
    parts?: Part[]
    mode?: ExecutionMode
    modeConfig?: ModeConfig
  }): Promise<WorkspaceTask> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel || !channel.leadAgentId) {
      throw new AppError(400, 'NO_LEAD_AGENT', `channel ${input.channelId} 无 lead,请先创建 lead`)
    }
    if (channel.enabled !== 1) {
      throw new AppError(403, 'CHANNEL_DISABLED', `channel ${input.channelId} 已禁用`)
    }
    this.ensureChannelActive(input.channelId)
    const description = input.mode
      ? encodeTaskMode(input.mode, input.modeConfig ?? {}, input.description ?? '')
      : input.description
    const task = this.getTaskEngine().create({
      channelId: input.channelId,
      creatorId: '',
      assigneeId: channel.leadAgentId,
      title: input.title,
      description,
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
    channelId: string,
    callerAgentId: string,
    input: {
      parentTaskId?: string
      assigneeId: string
      title: string
      description?: string
      parts?: Part[]
    },
  ): Promise<WorkspaceTask> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可 dispatch 任务')
    }
    const assignee = this.deps.repos.channelAgents.findByChannelAgent(channelId, input.assigneeId)
    if (!assignee) {
      throw new AppError(403, 'SCOPE_VIOLATION', 'assignee 不在本 channel')
    }
    let task: WorkspaceTask
    if (input.parentTaskId) {
      const parent = this.getTaskEngine().get(input.parentTaskId)
      if (!parent) throw new AppError(404, 'NOT_FOUND', `父任务不存在: ${input.parentTaskId}`)
      if (parent.channelId !== channelId) {
        throw new AppError(403, 'SCOPE_VIOLATION', '父任务不在本 channel')
      }
      task = this.getTaskEngine().dispatch(parent, {
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
      })
      this.wakeAgent(channelId, input.assigneeId)
    }
    else {
      task = this.getTaskEngine().create({
        channelId,
        creatorId: callerAgentId,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
      })
      task = this.getTaskEngine().transition(task.id, 'ASSIGNED', callerAgentId)
      const message = buildMessage(channelId, 'ROLE_USER', input.parts ?? [], {
        'x-aw-task-kind': 'assign',
        'x-aw-task-id': task.id,
        'x-aw-from-agent': callerAgentId,
      })
      message.taskId = task.id
      this.route(channelId, message)
    }
    return task
  }

  async reportTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
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
    const next = rowToTask(updated!)
    this.notifyTask(task.channelId, { taskId: task.id, progress: next.progress, agentId: callerAgentId })
    return next
  }

  async completeTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, artifacts?: A2AArtifact[] },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
    if (task.assigneeId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 assignee 可完成任务')
    }
    const completed = this.getTaskEngine().complete(input.taskId, input.artifacts)
    if (completed.parentId) {
      this.getTaskEngine().onChildCompleted(completed)
      const parent = this.getTaskEngine().get(completed.parentId)
      if (parent) this.wakeAgent(completed.channelId, parent.assigneeId)
    }
    return completed
  }

  async cancelTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
    const caller = this.requireMember(channelId, callerAgentId)
    const isLead = caller.role === 'lead'
    const isCreator = task.creatorId === callerAgentId
    if (!isLead && !isCreator) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead/creator 可取消任务')
    }
    const canceled = this.getTaskEngine().cancel(input.taskId, callerAgentId)
    this.runtimeOf(channelId, canceled.assigneeId)?.abortCurrent()
    this.wakeAgent(channelId, canceled.assigneeId)
    return canceled
  }

  async listTasks(channelId: string, callerAgentId: string): Promise<WorkspaceTask[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.tasks.listByChannel(channelId).map(rowToTask)
  }

  async getTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    return this.requireTaskInScope(channelId, callerAgentId, taskId)
  }

  async sendA2A(
    channelId: string,
    callerAgentId: string,
    input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> },
  ): Promise<A2AMessage> {
    this.requireMember(channelId, callerAgentId)
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, input.toAgentId)
    if (!target) {
      throw new AppError(403, 'SCOPE_VIOLATION', '目标 Agent 不在本 channel')
    }
    const message = buildMessage(channelId, 'ROLE_AGENT', input.parts, {
      ...(input.metadata ?? {}),
      'x-aw-target-agent': input.toAgentId,
      'x-aw-from-agent': callerAgentId,
    })
    this.route(channelId, message)
    return message
  }

  async sendImmediateMessage(input: {
    channelId: string
    fromAgentId?: string
    toAgentId: string
    parts: Part[]
  }): Promise<A2AMessage> {
    const message = buildMessage(input.channelId, 'ROLE_AGENT', input.parts, {
      'x-aw-target-agent': input.toAgentId,
      'x-aw-from-agent': input.fromAgentId ?? '',
      'x-aw-msg-priority': 'immediate',
    })
    this.route(input.channelId, message)
    return message
  }

  async pollMailbox(channelId: string, callerAgentId: string, limit = 100): Promise<A2AMessage[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.messages
      .listPendingByChannelAgent(channelId, callerAgentId)
      .slice(0, limit)
      .map(rowToMessage)
  }

  async subscribe(channelId: string, callerAgentId: string, input: { agentIds?: string[] }): Promise<void> {
    this.requireMember(channelId, callerAgentId)
    for (const targetId of input.agentIds ?? []) {
      const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, targetId)
      if (!target) {
        throw new AppError(403, 'SCOPE_VIOLATION', `目标 Agent ${targetId} 不在本 channel`)
      }
      this.deps.repos.subscriptions.add(channelId, callerAgentId, targetId)
    }
  }

  /** 实例级 token → 实例视图(AgentInfo) */
  findByToken(token: string): AgentInfo | undefined {
    const m = this.deps.repos.channelAgents.findByToken(token)
    return m ? instanceToAgentInfo(m) : undefined
  }

  async restore(): Promise<void> {
    this.deps.repos.messages.resetConsuming()
    const nonTerminal = this.deps.repos.tasks.listNonTerminal()
    for (const row of nonTerminal) {
      this.deps.repos.tasks.update(row.id, { state: 'ASSIGNED' })
    }
    const activeChannelIds = new Set(nonTerminal.map(t => t.channelId))
    for (const channelId of activeChannelIds) {
      const channel = this.deps.repos.channels.findById(channelId)
      if (!channel || channel.enabled !== 1) continue
      this.ensureChannelActive(channelId)
    }
  }

  // ===== 内部辅助 =====

  private route(channelId: string, message: A2AMessage): void {
    this.ensureChannelRuntime(channelId).route(message)
  }

  private wakeAgent(channelId: string, agentId: string): void {
    this.ensureAgentRuntime(channelId, agentId)?.wakeMailbox()
  }

  /** 校验调用方是本 channel 实例;返回实例行(含 role) */
  private requireMember(channelId: string, agentId: string): ChannelAgentRow {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(403, 'SCOPE_VIOLATION', '调用方 Agent 不在本 channel')
    return m
  }

  private requireTaskInScope(channelId: string, callerAgentId: string, taskId: string): WorkspaceTask {
    this.requireMember(channelId, callerAgentId)
    const row = this.deps.repos.tasks.findById(taskId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    if (row.channelId !== channelId) {
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

export function initWorkshopManager(deps: ManagerDeps): AgentChannelManager {
  managerSingleton = new AgentChannelManager(deps)
  return managerSingleton
}

export function getWorkshopManagerOrNull(): AgentChannelManager | null {
  return managerSingleton
}
