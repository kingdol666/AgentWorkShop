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
import { createLogger } from '../logger'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { userRepository } from '../../../repositories/user.repository'
import type { A2AMessage, A2AArtifact, ChannelMail, Part } from '../types/a2a'
import type { AgentStatusView, AgentTaskQueueView, TaskState, WorkspaceTask } from '../types/task'
import { TERMINAL_TASK_STATES } from '../types/task'
import type { AgentInfo, AgentInterface, AgentWorkspace, AgentEvent, ExecutionMode } from '../agents/agent-interface'
import type { ModeConfig } from './execution-mode'
import { encodeTaskMode, isGoalSummaryArtifact } from './execution-mode'
import type { ChannelRepo } from '../db/channel.repo'
import type { AgentRepo } from '../db/agent.repo'
import type { TeamRepo } from '../db/team.repo'
import type { TeamMemberRepo } from '../db/team-member.repo'
import type { ChannelAgentRepo } from '../db/channel-agent.repo'
import type { MessageRepo } from '../db/message.repo'
import type { SubscriptionRepo } from '../db/subscription.repo'
import type { TaskRepo, TaskPatch } from '../db/task.repo'
import { parseJson, type AgentRow, type ChannelAgentRow, type ChannelRow, type ChannelTemplateRow, type MemoryRow, type MessageRow, type TaskRow, type TeamRow, type UserRow, type WorkspaceRow } from '../db/database'
import { Mailbox, rowToMessage } from './mailbox'
import { AgentRuntime } from './agent-runtime'
import type { ChannelBus, MemberChangeEvent, TaskEngine, TaskEventTask } from './agent-runtime'
import { ChannelRuntime } from './channel-runtime'
import { SchedulerLoop, type SchedulerLoopOptions } from './scheduler-loop'
import { TaskEngine as TaskEngineImpl } from './task-engine'
import { AgentMemory, runMemoryMaintenance, segmentCJK, unsegmentCJK, vectorizeMemory, type MaintenanceResult, type MemorySnippet } from './memory'
import { memorySettings } from '../settings'
import { createEnvEmbeddingProvider } from './embedding-provider'
import { listHarnessProcesses, listAliveHarnessProcessesByAgent, sweepHarnessProcesses, killHarnessProcess } from '../agents/harness-process'
import { hasTerminalSession, sweepTerminalSessions } from '../agents/harness-terminal'
import { knownHarnesses } from '../agents/registry'
import { hostToolsForRole } from '../agents/host-tool-bridge'
import { TEAM_AGENT_ID, type MemoryRepo } from '../db/memory.repo'
import type { UserRepo } from '../db/user.repo'
import type { ChannelEventRepo } from '../db/channel-event.repo'
import type { ChannelTemplateRepo, ChannelTemplateMember } from '../db/channel-template.repo'

const log = createLogger('workshop.manager')

/** 全部仓储(依赖注入) */
export interface AllRepos {
  users: UserRepo
  channelEvents: ChannelEventRepo
  channels: ChannelRepo
  agents: AgentRepo
  teams: TeamRepo
  teamMembers: TeamMemberRepo
  channelTemplates: ChannelTemplateRepo
  channelAgents: ChannelAgentRepo
  messages: MessageRepo
  subscriptions: SubscriptionRepo
  tasks: TaskRepo
  memories: MemoryRepo
}

/** Manager 依赖 */
export interface ManagerDeps {
  repos: AllRepos
  implFactory: (agent: AgentInfo) => AgentInterface
  taskEngineFactory?: (repos: { tasks: TaskRepo, messages: MessageRepo }) => TaskEngine
  db: DatabaseSync
}

/** 权限主体(路由层 ResolvedUser 的子集;role 供 admin 判定) */
export interface ActingUser {
  id: string
  role?: string
}

/** Agent 模板详情(全局;含其克隆出的全部实例) */
export interface AgentTemplateDetail {
  id: string
  name: string
  harness: string
  config: Record<string, unknown>
  enabled: number
  /** 可见性:'private' | 'public' */
  visibility: string
  /** 内置模板(owner NULL;公开只读,任何人含 admin 不可修改删除) */
  isBuiltin: boolean
  /** 归属用户(null = 内置公共) */
  ownerUserId: string | null
  /** 该模板克隆出的全部实例(跨 channel) */
  instances: Array<{ id: string, channelId: string, role: 'lead' | 'worker', token: string }>
  createdAt: string
  updatedAt: string
}

/** AgentTeam 详情(含成员模板快照) */
export interface AgentTeamDetail {
  id: string
  name: string
  description: string
  /** 可见性:'private' | 'public' */
  visibility: string
  /** 内置编组(owner NULL;公开只读,任何人含 admin 不可修改删除) */
  isBuiltin: boolean
  /** 归属用户(null = 内置公共) */
  ownerUserId: string | null
  /** 成员(按加入顺序;快照含模板当前 name/harness,便于前端展示) */
  members: Array<{
    templateId: string
    name: string
    harness: string
    role: 'lead' | 'worker'
    addedAt: string
  }>
  createdAt: string
  updatedAt: string
}

/** Channel 模板详情(场景 + 工作目录 + 成员组合;lead/members 已反序列化) */
export interface ChannelTemplateDetail {
  id: string
  name: string
  description: string
  scenarioPrompt: string
  workspace: string
  /** 内联 lead 定义(空 = 无 lead) */
  lead: { name: string, harness: string, config?: Record<string, unknown> } | null
  /** 成员组合:引用 Agent 模板或内联定义 */
  members: ChannelTemplateMember[]
  visibility: string
  isBuiltin: boolean
  ownerUserId: string | null
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
    enabled: m.enabled,
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
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** MessageRow → ChannelMail(parts/metadata 反序列化;渠道邮件公开投影) */
function rowToChannelMail(row: MessageRow): ChannelMail {
  return {
    messageId: row.id,
    taskId: row.taskId,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    role: row.role as 'ROLE_USER' | 'ROLE_AGENT',
    parts: parseJson<Part[]>(row.partsJson, []),
    metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
    state: row.state,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
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

/** factory 支持的 harness 集(registry 单一事实源;lead 建成员时校验) */
const KNOWN_HARNESSES = new Set(knownHarnesses())

/** 全局用户名解析(带 60s 缓存;owner 归属呈现用,解析失败返回 null) */
const ownerNameCache = new Map<string, { name: string | null, at: number }>()
export function resolveOwnerName(userId: string): string | null {
  const hit = ownerNameCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.name
  let name: string | null
  try {
    name = userRepository.findById(userId)?.name ?? null
  }
  catch {
    name = null
  }
  ownerNameCache.set(userId, { name, at: Date.now() })
  return name
}

/** 运行时资源监控:单个 ChannelRuntime 视图 */
export interface RuntimeChannelView {
  channelId: string
  /** 已装配(wired)的 AgentRuntime 数 */
  wiredAgentCount: number
  /** channel 内成员总数(含未装配;来自 DB) */
  memberCount: number
  /** 是否为 lead 装配并启动了 SchedulerLoop */
  hasScheduler: boolean
  leadAgentId: string | null
  /** 归属用户(admin 全量视图附带;普通用户视图为自身) */
  ownerUserId?: string | null
  /** 归属用户名(admin 视角呈现创建者) */
  ownerName?: string | null
}

/** 运行时资源监控:单个 AgentRuntime 视图 */
export interface RuntimeAgentView {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  state: 'idle' | 'busy' | 'stopped'
  currentTaskId: string | null
  queuedCount: number
  completedCount: number
  /** harness 进程(进程内 harness 为 null) */
  process: { pid: number, alive: boolean, command: string } | null
  /** 归属用户(admin 全量视图附带;普通用户视图为自身) */
  ownerUserId?: string | null
  ownerName?: string | null
}

/** 运行时资源监控:harnest 进程视图(注册表,含孤儿) */
export interface RuntimeProcessView {
  pid: number
  harness: string
  command: string
  args: string[]
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  startedAt: number
  alive: boolean
  exitCode: number | null
  /** 是否被某个已装配 runtime 引用(否则为孤儿进程) */
  bound: boolean
  /** 终端镜像是否可接入(harness-terminal tap 已挂载;/monitor 终端按钮依据) */
  terminal: boolean
}

/** 运行时资源监控:全量快照 */
export interface RuntimeMonitorSnapshot {
  generatedAt: string
  /** 服务端(宿主)进程 pid */
  serverPid: number
  uptimeMs: number
  channels: RuntimeChannelView[]
  agents: RuntimeAgentView[]
  processes: RuntimeProcessView[]
  counts: {
    channels: number
    agents: number
    processes: number
    aliveProcesses: number
    orphanProcesses: number
  }
}

export class AgentChannelManager {
  private channels = new Map<string, ChannelRuntime>()
  /** 键 = runtimeKey(channelId, 实例 id);每个实例一个独立运行时 */
  private agentIndex = new Map<string, AgentRuntime>()
  private buses = new Map<string, ChannelBus>()
  private taskEngine: TaskEngine | null = null
  private idleSweeperTimer: NodeJS.Timeout | null = null
  private memoryTimer: NodeJS.Timeout | null = null
  /** 全 manager 共享的 env 向量 provider(未配置 → null 纯 FTS;熔断/维度全体实例共享) */
  private readonly memoryEmbedder = createEnvEmbeddingProvider()
  /** 反思游标:每 agent 上次聚合的当月任务数(月度幂等增量判定) */
  private readonly reflectCounts = new Map<string, number>()

  constructor(private deps: ManagerDeps) {
    // 记忆衰减清理定时器(失败只记日志,绝不抛出;unref 不阻进程退出;非法/非正 env 回退默认)
    this.memoryTimer = setInterval(() => {
      try {
        runMemoryMaintenance(this.deps.repos.memories)
      }
      catch (err) {
        log.error('[memory] 维护任务异常', err)
      }
      // 空闲反思(sleep-time compute):busy runtime 存在即整轮跳过,绝不与作业争抢
      try {
        this.reflectIdleMemories()
      }
      catch (err) {
        log.error('[memory] 反思任务异常', err)
      }
    }, memorySettings().maintenance_ms)
    this.memoryTimer.unref?.()
  }

  // ===== 运行时装配 =====

  private getTaskEngine(): TaskEngine {
    if (!this.taskEngine) {
      const factory = this.deps.taskEngineFactory ?? (r => new TaskEngineImpl(r, {
        onTaskChange: (e) => {
          // 全字段转发(含 progress):TaskEngine 内部进度变化(applyEvent 分块折算 /
          // complete 置 100)须经总线 → WS task.progress 实时同步,否则前端实体进度滞后
          this.buses.get(e.channelId)?.notifyTask({
            taskId: e.taskId,
            state: e.state,
            progress: e.progress,
            agentId: e.agentId,
            task: e.task,
          })
          // 事件驱动调度:任务状态变化即唤醒该频道调度循环(空闲退避即刻恢复快节奏)
          this.channels.get(e.channelId)?.scheduler?.wake()
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
      // 路由成功 → 总线通知(a2a.message 帧):经 runtime 回调统一收口,
      // 调度器直呼 channelRuntime.route 的消息同样可见
      }, msg => this.buses.get(channelId)?.notifyMessage(msg))
      cr.setLoader(id => this.ensureAgentRuntime(channelId, id))
      this.channels.set(channelId, cr)
      this.buses.set(channelId, this.buildBus(cr))
      // 团队记忆沉淀(任务终态事件单点收口):team-task 共享行 + 编年史滚动重写。
      // 事件总线保证每次状态迁移恰好一次通知——worker/lead 各自私有域 harvest 之外
      // 的团队域写入不存在双写;失败仅记日志,绝不影响任务流。
      this.buses.get(channelId)!.onTaskEvent(e => this.recordTeamTaskTerminal(channelId, e))
    }
    return cr
  }

  /**
   * 团队历史沉淀(任务终态):① team-task 共享行(成果/失败原因,全员可检索);
   * ② 团队编年史滚动重写(最近 12 条终态任务轨迹)。
   */
  private recordTeamTaskTerminal(channelId: string, e: { taskId: string, state?: TaskState, task?: TaskEventTask }): void {
    if (!e.state || !TERMINAL_TASK_STATES[e.state]) return
    try {
      const completed = e.state === 'COMPLETED'
      const task = e.task
      const title = task?.title ?? `任务 ${e.taskId.slice(0, 8)}`
      // 成果提取与 AgentMemory.recordTaskOutcome 同口径(deliverable/summary 优先)
      const artifacts = (task?.artifacts ?? []) as A2AArtifact[]
      const preferred = artifacts.filter(a => a.name === 'deliverable' || a.name === 'summary')
      const source = preferred.length > 0 ? preferred : artifacts
      const deliverable = source
        .flatMap(a => a.parts)
        .map(p => ('text' in p ? p.text : ''))
        .join(' ')
        .trim()
      const content = completed
        ? (deliverable || title)
        : `任务「${title}」${e.state === 'CANCELED' ? '已取消' : '未完成'}${deliverable ? `;已有进展: ${deliverable.slice(0, 200)}` : ''}`
      const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: TEAM_AGENT_ID, embedder: this.memoryEmbedder ?? undefined })
      void mem.appendTeamTaskRecord({
        taskId: e.taskId,
        title,
        content,
        importance: completed ? 0.8 : 0.55,
      }).catch((err) => { log.error('[memory] team-task 沉淀失败:', err) })
      this.refreshChronicle(channelId)
    }
    catch (err) {
      log.error('[memory] 团队任务沉淀异常:', err)
    }
  }

  /** 团队编年史滚动重写(最近 12 条终态任务;chronicle:<channelId> 幂等单行;免向量化) */
  private refreshChronicle(channelId: string): void {
    try {
      const terminal = this.getTaskEngine().list(channelId)
        .filter(t => TERMINAL_TASK_STATES[t.state])
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 12)
      if (terminal.length === 0) return
      const entries = terminal.map((t) => {
        const stamp = t.updatedAt.slice(5, 16).replace('T', ' ')
        const deliverable = t.artifacts
          .flatMap(a => a.parts)
          .map(p => ('text' in p ? p.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        const state = t.state === 'COMPLETED' ? '完成' : t.state === 'FAILED' ? '失败' : '取消'
        return `${stamp} [${state}] ${t.title} — ${t.assigneeId.slice(0, 8)}${deliverable ? `(${deliverable})` : ''}`
      })
      new AgentMemory(this.deps.repos.memories, { channelId, agentId: TEAM_AGENT_ID })
        .upsertChronicle(entries.join('\n'))
    }
    catch (err) {
      log.error('[memory] 编年史刷新失败:', err)
    }
  }

  /**
   * 空闲反思(sleep-time compute,零 LLM):当月 episodic-task 增量 ≥ 阈值时,
   * 聚合标题+结论成 semantic 反思行(月度 dedupKey 幂等;FTS 可检索,免向量化)。
   */
  private reflectIdleMemories(): void {
    for (const rt of this.agentIndex.values()) {
      if (rt.getState() === 'busy') return
    }
    const trigger = memorySettings().reflect_trigger
    const month = new Date().toISOString().slice(0, 7)
    for (const agentId of this.deps.repos.memories.listMemoryAgentIds()) {
      const rows = this.deps.repos.memories.listByAgentWithRowid(agentId, 1_000_000)
        .filter(r => r.kind === 'episodic-task' && r.createdAt.slice(0, 7) === month)
      const prev = this.reflectCounts.get(agentId) ?? 0
      if (rows.length < trigger || rows.length <= prev) continue
      // 行可能跨 channel(历史迁移):按 channel 分组,各组建反思
      const byChannel = new Map<string, typeof rows>()
      for (const r of rows) {
        const list = byChannel.get(r.channelId) ?? []
        list.push(r)
        byChannel.set(r.channelId, list)
      }
      for (const [channelId, list] of byChannel) {
        const lines = list.slice(0, 20).map(r => `- ${r.title}:${unsegmentCJK(r.content).slice(0, 60)}`)
        new AgentMemory(this.deps.repos.memories, { channelId, agentId })
          .upsertReflection({ month, content: [`当月 ${list.length} 项任务经验聚合:`, ...lines].join('\n') })
      }
      this.reflectCounts.set(agentId, rows.length)
      log.info(`[memory] 反思蒸馏:agent=${agentId.slice(0, 8)} 当月 ${rows.length} 项任务已聚合`)
    }
  }

  private buildBus(cr: ChannelRuntime): ChannelBus {
    const eventListeners = new Set<(event: AgentEvent, source: A2AMessage) => void>()
    const taskListeners = new Set<(e: { taskId: string, state?: TaskState, progress?: number }) => void>()
    const agentListeners = new Set<(e: { agentId: string, state: 'idle' | 'busy' | 'stopped' }) => void>()
    const messageListeners = new Set<(message: A2AMessage) => void>()
    const memoryListeners = new Set<(e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void>()
    const memberListeners = new Set<(e: MemberChangeEvent) => void>()
    return {
      emit: (event, source) => {
        for (const fn of eventListeners) {
          try {
            fn(event, source)
          }
          catch (err) {
            log.error('[ChannelBus] event listener error:', err)
          }
        }
        cr.wakeScheduler()
      },
      onEvent: (fn) => {
        eventListeners.add(fn)
        return () => eventListeners.delete(fn)
      },
      notifyTask: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => {
        for (const fn of taskListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] task listener error:', err)
          }
        }
      },
      onTaskEvent: (fn) => {
        taskListeners.add(fn)
        return () => taskListeners.delete(fn)
      },
      notifyAgent: (e) => {
        for (const fn of agentListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] agent listener error:', err)
          }
        }
      },
      onAgentStatus: (fn) => {
        agentListeners.add(fn)
        return () => agentListeners.delete(fn)
      },
      notifyMessage: (message) => {
        for (const fn of messageListeners) {
          try {
            fn(message)
          }
          catch (err) {
            log.error('[ChannelBus] message listener error:', err)
          }
        }
      },
      onMessage: (fn) => {
        messageListeners.add(fn)
        return () => messageListeners.delete(fn)
      },
      notifyMemory: (e) => {
        for (const fn of memoryListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] memory listener error:', err)
          }
        }
      },
      onMemoryEvent: (fn) => {
        memoryListeners.add(fn)
        return () => memoryListeners.delete(fn)
      },
      notifyMember: (e) => {
        for (const fn of memberListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] member listener error:', err)
          }
        }
      },
      onMemberEvent: (fn) => {
        memberListeners.add(fn)
        return () => memberListeners.delete(fn)
      },
      wakeScheduler: () => {
        cr.wakeScheduler()
      },
    }
  }

  subscribeAgentStatus(channelId: string, fn: (e: Parameters<ChannelBus['notifyAgent']>[0]) => void): () => void {
    // 先确保 bus 存在:channel 尚未激活时订阅会被静默丢弃(monitor 先订阅后提交任务的场景)
    // 返回 bus 的真实退订函数:stream 重绑时必须可退订,否则同一 bus 上订阅两份 → 事件双发
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onAgentStatus(fn) ?? (() => {})
  }

  subscribeChannelEvents(channelId: string, fn: (event: AgentEvent, source: A2AMessage) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onEvent(fn) ?? (() => {})
  }

  subscribeTaskEvents(channelId: string, fn: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => void): () => void {
    // 真实退订(同上:防 stream 重绑泄漏导致 task.status 双发落库)
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onTaskEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内消息投递(AEP a2a.message 事件源;route 汇流点触发) */
  subscribeChannelMessages(channelId: string, fn: (message: A2AMessage) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMessage(fn) ?? (() => {})
  }

  /** 订阅 channel 内记忆写入(AEP memory.saved 事件源) */
  subscribeMemoryEvents(channelId: string, fn: (e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMemoryEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内团队成员增/改/删(AEP agent.member 事件源;lead 工具桥与 REST 入口共用汇流点) */
  subscribeMemberEvents(channelId: string, fn: (e: MemberChangeEvent) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMemberEvent(fn) ?? (() => {})
  }

  private notifyTask(
    channelId: string,
    e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask },
  ): void {
    this.buses.get(channelId)?.notifyTask(e)
  }

  /** 团队成员变更广播(AEP agent.member 事件源;lead 工具桥与 REST 入口共用) */
  private notifyMember(channelId: string, e: MemberChangeEvent): void {
    this.buses.get(channelId)?.notifyMember(e)
  }

  /** 按实例装配 AgentRuntime(每个实例一个独立运行时) */
  private wireMember(m: ChannelAgentRow): AgentRuntime {
    const agent = instanceToAgentInfo(m)
    const cr = this.ensureChannelRuntime(m.channelId)
    const bus = this.buses.get(m.channelId)!
    const mailbox = new Mailbox(this.deps.repos.messages, m.channelId, agent.id, () => cr.wakeScheduler())
    const memory = new AgentMemory(this.deps.repos.memories, { channelId: m.channelId, agentId: agent.id, embedder: this.memoryEmbedder ?? undefined })
    const workspace = this.buildWorkspace(agent, memory)
    const chWorkspace = this.channelWorkspace(m.channelId)
    // channel 级作业场景 prompt 注入 harness config(用户场景 × 系统设计组合的入口;
    // 变更经 updateChannel 回收成员运行时,下次装配拿到新场景)
    const scenarioPrompt = this.deps.repos.channels.findById(m.channelId)?.scenarioPrompt ?? ''
    const configWithCtx: Record<string, unknown> = { ...agent.config }
    if (scenarioPrompt) configWithCtx.scenarioPrompt = scenarioPrompt
    if (chWorkspace.length > 0) configWithCtx.cwd = chWorkspace
    const agentWithCtx: AgentInfo = { ...agent, config: configWithCtx }
    const runtime = new AgentRuntime(agent, this.deps.implFactory(agentWithCtx), {
      mailbox,
      taskEngine: this.getTaskEngine(),
      bus,
      workspace,
      memory,
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
    const loop = new SchedulerLoop(cr, lead, {
      ...options,
      // 调度快照的邮件上下文(lead 观察 worker 间通信的唯一来源;DB 为事实源)
      supervisionMail: limit => this.deps.repos.messages
        .listRecentByChannel(channelId, limit)
        .map(rowToChannelMail),
    })
    loop.setLoopResubmitCallback((title, description) => {
      this.submitChannelTask({ channelId, title, description }).catch((err) => {
        // 清理竞态:channel 已删除/lead 已卸载时的到期重放 → 静默(NOT_FOUND 为预期)
        const code = (err as { code?: string }).code
        if (code === 'NOT_FOUND' || code === 'NO_LEAD_AGENT') return
        log.error(`[AgentChannelManager:${channelId}] loop 重新提交失败:`, err)
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
    // 先摘除再停机:runtime.stop() 会关闭 mailbox,若成员仍在 route 视野内,
    // 停机窗口内到达的消息会被 closed mailbox 静默吞掉但 delivered 照常上报
    // (发送方收到成功假象);先 detach 让 route 立即按"成员不存在"如实失败
    cr?.detachAgent(agentId)
    await runtime.stop()
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
        // 存活校准优先:休眠/强杀后子进程 exit 事件可能不达,周期探 OS 实际存在性,
        // 死进程收敛为已退出(在途回合归位,下一回合自动重生),避免 stuck busy/死客户端空转
        try {
          rt.reconcileProcess()
        }
        catch (err) {
          log.error(`[AgentChannelManager] 校准 ${rt.channelId}/${rt.agentId} 进程存活失败:`, err)
        }
        const key = runtimeKey(rt.channelId, rt.agentId)
        if (rt.getState() === 'idle') {
          const since = idleSince.get(key) ?? now
          idleSince.set(key, since)
          if (now - since >= graceMs) {
            idleSince.delete(key)
            this.unloadAgent(rt.channelId, rt.agentId).catch((err) => {
              log.error(`[AgentChannelManager] 卸载 ${rt.channelId}/${rt.agentId} 失败:`, err)
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

  /**
   * 运行时资源监控快照:已装配的 ChannelRuntime / AgentRuntime
   * + 全部已启动的 harness 进程(注册表,含已脱离 runtimes 的孤儿进程)。
   */
  monitorRuntime(): RuntimeMonitorSnapshot {
    sweepHarnessProcesses()
    sweepTerminalSessions()
    const channels: RuntimeChannelView[] = [...this.channels.values()].map((cr) => {
      const channel = this.deps.repos.channels.findById(cr.channelId)
      return {
        channelId: cr.channelId,
        wiredAgentCount: cr.getAgents().length,
        memberCount: this.deps.repos.channelAgents.listByChannel(cr.channelId).length,
        hasScheduler: cr.scheduler !== null,
        leadAgentId: channel?.leadAgentId ?? null,
        ownerUserId: channel?.ownerUserId ?? null,
      }
    })
    const agents: RuntimeAgentView[] = [...this.agentIndex.values()].map((rt) => {
      const status = rt.getStatus()
      const row = this.deps.repos.channelAgents.findByChannelAgent(rt.channelId, rt.agentId)
      return {
        channelId: rt.channelId,
        agentId: rt.agentId,
        name: rt.name,
        role: rt.role,
        harness: row?.harness ?? '?',
        state: status.state,
        currentTaskId: status.currentTaskId,
        queuedCount: status.queuedCount,
        completedCount: status.completedCount,
        process: rt.getProcessInfo(),
      }
    })
    const channelOwner = new Map(channels.map(c => [c.channelId, c.ownerUserId ?? null]))
    const boundPids = new Set(
      agents.map(a => a.process?.pid).filter((p): p is number => typeof p === 'number'),
    )
    const processes: RuntimeProcessView[] = listHarnessProcesses().map(p => ({
      pid: p.pid,
      harness: p.harness,
      command: p.command,
      args: p.args,
      agentId: p.agentId,
      channelId: p.channelId,
      name: p.name,
      role: p.role,
      startedAt: p.startedAt,
      alive: p.alive,
      exitCode: p.exitCode,
      bound: boundPids.has(p.pid),
      terminal: hasTerminalSession(p.pid),
    }))
    for (const a of agents) {
      a.ownerUserId = channelOwner.get(a.channelId) ?? null
    }
    for (const p of processes) {
      ;(p as RuntimeProcessView & { ownerUserId?: string | null }).ownerUserId = p.channelId
        ? channelOwner.get(p.channelId) ?? null
        : null
    }
    return {
      generatedAt: new Date().toISOString(),
      serverPid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      channels,
      agents,
      processes,
      counts: {
        channels: channels.length,
        agents: agents.length,
        processes: processes.length,
        aliveProcesses: processes.filter(p => p.alive).length,
        orphanProcesses: processes.filter(p => p.alive && !p.bound).length,
      },
    }
  }

  /**
   * 用户级监控快照(v10 用户隔离):
   * - 普通用户:仅本人 channel 的 runtime/agent,以及绑定到本人 channel 的进程;
   *   未绑定/孤儿进程与遗留无主 channel 一律不可见。
   * - admin:全量视图,每个 channel/agent/process 附带 ownerUserId(ownerName 由路由层补注)。
   */
  monitorRuntimeForUser(user: ActingUser): RuntimeMonitorSnapshot & { scope: 'user' | 'admin', ownerNames?: Record<string, string> } {
    const snap = this.monitorRuntime()
    if (user.role === 'admin') {
      const ownerIds = new Set<string>()
      for (const c of snap.channels) {
        if (c.ownerUserId) ownerIds.add(c.ownerUserId)
      }
      const ownerNames: Record<string, string> = {}
      for (const id of ownerIds) {
        const name = resolveOwnerName(id)
        if (name) ownerNames[id] = name
      }
      for (const c of snap.channels) c.ownerName = c.ownerUserId ? ownerNames[c.ownerUserId] ?? null : null
      for (const a of snap.agents) a.ownerName = a.ownerUserId ? ownerNames[a.ownerUserId] ?? null : null
      return { ...snap, scope: 'admin', ownerNames }
    }
    const visibleChannels = new Set(snap.channels.filter(c => c.ownerUserId === user.id).map(c => c.channelId))
    // 本人有主但当前未装配 runtime 的 channel 也计入 channels 视图(成员数来自 DB,装配为 0)
    for (const row of this.deps.repos.channels.list()) {
      if (row.ownerUserId === user.id) visibleChannels.add(row.id)
    }
    const channels = snap.channels.filter(c => visibleChannels.has(c.channelId))
    for (const row of this.deps.repos.channels.list()) {
      if (visibleChannels.has(row.id) && !channels.some(c => c.channelId === row.id)) {
        channels.push({
          channelId: row.id,
          wiredAgentCount: 0,
          memberCount: this.deps.repos.channelAgents.listByChannel(row.id).length,
          hasScheduler: false,
          leadAgentId: row.leadAgentId,
          ownerUserId: row.ownerUserId,
        })
      }
    }
    const agents = snap.agents.filter(a => visibleChannels.has(a.channelId))
    const processes = snap.processes.filter(p => p.channelId !== null && visibleChannels.has(p.channelId))
    return {
      generatedAt: snap.generatedAt,
      serverPid: snap.serverPid,
      uptimeMs: snap.uptimeMs,
      channels,
      agents,
      processes,
      counts: {
        channels: channels.length,
        agents: agents.length,
        processes: processes.length,
        aliveProcesses: processes.filter(p => p.alive).length,
        orphanProcesses: processes.filter(p => p.alive && !p.bound).length,
      },
      scope: 'user',
    }
  }

  /**
   * 终止指定 runtime 的 harness 进程 → 对应 AgentRuntime 随之 stop 并卸载。
   * 语义比 HITL stopAgentRuntime 更强:先强杀进程(进程树),再走 stopAndDetach
   * (停 SchedulerLoop / 中断当前 run / dispose impl / 移出索引)。成员行保留,
   * 后续任务投递按需重新装配。
   * runtime 未装配(如已被空闲卸载)但进程残留 → 按 agentId 兜底强杀进程,防资源浪费。
   */
  async terminateRuntimeProcess(channelId: string, agentId: string): Promise<{ agentId: string, stopped: boolean }> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
    const runtime = this.runtimeOf(channelId, agentId)
    if (runtime) {
      try {
        runtime.killProcess()
      }
      catch (err) {
        log.error(`[AgentChannelManager] 终止进程失败 ${channelId}/${agentId}:`, err)
      }
      await this.stopAndDetach(channelId, agentId)
      return { agentId, stopped: true }
    }
    const leftover = listAliveHarnessProcessesByAgent(agentId)
    for (const p of leftover) killHarnessProcess(p.pid)
    return { agentId, stopped: leftover.length > 0 }
  }

  /** 按 PID 终止 harness 进程(孤儿进程专用;已绑定 runtime 的请走 terminateRuntimeProcess) */
  killHarnessProcessByPid(pid: number): { pid: number, killed: boolean } {
    return { pid, killed: killHarnessProcess(pid) }
  }

  async shutdown(): Promise<void> {
    if (this.idleSweeperTimer) {
      clearInterval(this.idleSweeperTimer)
      this.idleSweeperTimer = null
    }
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
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
  private buildWorkspace(agent: AgentInfo, memory: AgentMemory): AgentWorkspace {
    const channelId = agent.channelId
    return {
      listAgents: () => this.listChannelAgents(channelId),
      dispatchTask: input => this.dispatchTask(channelId, agent.id, input),
      listTasks: () => this.listTasks(channelId, agent.id),
      getTask: taskId => this.getTask(channelId, agent.id, taskId),
      reportTask: input => this.reportTask(channelId, agent.id, input),
      completeTask: (taskId, artifacts) => this.completeTask(channelId, agent.id, { taskId, artifacts }),
      cancelTask: taskId => this.cancelTask(channelId, agent.id, { taskId }),
      myQueue: () => this.myQueue(channelId, agent.id),
      queueOverview: () => this.queueOverview(channelId, agent.id),
      updateTask: (taskId, patch) => this.updateTask(channelId, agent.id, taskId, patch),
      reassignTask: (taskId, toAgentId) => this.reassignTask(channelId, agent.id, taskId, toAgentId),
      sendMessage: input => this.sendA2A(channelId, agent.id, input),
      sendCrossChannelMessage: input => this.sendCrossChannelMessage(channelId, agent.id, input),
      listOtherTeams: () => this.listOtherTeamsOverview(channelId, agent.id),
      searchOtherTeamsMemory: input => this.recallOtherTeamsMemory(channelId, agent.id, input),
      refuseTask: (taskId, reason) => this.refuseTask(channelId, agent.id, taskId, reason),
      pollMailbox: limit => this.pollMailbox(channelId, agent.id, limit),
      waitMailbox: (limit, waitMs) => this.waitMailbox(channelId, agent.id, limit ?? 10, waitMs ?? 0),
      ackMailbox: ids => Promise.resolve(this.ackMailbox(channelId, agent.id, ids)),
      listMail: opts => this.listChannelMail(channelId, agent.id, opts),
      subscribe: input => this.subscribe(channelId, agent.id, input),
      // 记忆按需抓取/主动沉淀(成员校验 + 委托本实例 AgentMemory;shared 写入即 Channel 公共域)
      recallMemory: async (input) => {
        this.requireMember(channelId, agent.id)
        return memory.recallRows(input.query, { scope: input.scope, limit: input.limit })
      },
      saveMemory: async (input) => {
        this.requireMember(channelId, agent.id)
        const saved = await memory.save(input)
        this.buses.get(channelId)?.notifyMemory({ agentId: agent.id, scope: input.scope, title: input.title, dedupKey: saved.dedupKey })
        return saved
      },
      // 会话压缩摘要入库(harvest 桥):omp 压缩产出 → 本成员 episodic-session 记忆
      recordSessionMemory: async (input) => {
        const saved = await memory.recordSessionCompaction(input)
        this.buses.get(channelId)?.notifyMemory({ agentId: agent.id, scope: 'private', title: `会话压缩摘要(${input.summary.length}字)`, dedupKey: saved.dedupKey })
      },
      // 团队成员管理(仅 lead;manager 内二次校验角色,工具面与决策面共用)
      createTeamMember: input => this.createTeamMember(channelId, agent.id, input),
      updateTeamMember: (agentId, patch) => this.updateTeamMember(channelId, agent.id, agentId, patch),
      removeTeamMember: (agentId, reason) => this.removeTeamMember(channelId, agent.id, agentId, reason),
    }
  }

  // ===== 用户面(用户级隔离;管理 API 凭证 = 用户 token)=====

  /** 注册用户(name 唯一 → 409;token 仅此一次返回) */
  registerUser(name: string): UserRow {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', '用户名不能为空')
    if (this.deps.repos.users.getByName(trimmed)) {
      throw new AppError(409, 'USER_EXISTS', `用户名已存在: ${trimmed}`)
    }
    return this.deps.repos.users.create(trimmed)
  }

  /** 用户 token → 用户(无效 → 401;REST resolveUser / WS sub 共用) */
  getUserByToken(token: string): UserRow | null {
    return this.deps.repos.users.getByToken(token)
  }

  /**
   * 资源 owner 守卫:owner 匹配放行;NULL owner(遗留公共数据)只读——
   * 写操作一律拒绝(FORBIDDEN_LEGACY,提示归属缺失);他人资源 → 403。
   */
  requireOwned(ownerUserId: string | null | undefined, userId: string, what: string): void {
    if (ownerUserId === null || ownerUserId === undefined) {
      throw new AppError(403, 'FORBIDDEN_LEGACY', `${what} 为遗留公共数据(无归属),禁止变更`)
    }
    if (ownerUserId !== userId) {
      throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户`)
    }
  }

  /**
   * 模板/资源可写守卫(v10 权限系统):
   * - 内置模板(owner NULL)→ 任何人(含 admin)不可修改删除(TEMPLATE_BUILTIN);
   * - 属主 → 放行;
   * - admin → 越权放行(最高管理权限);
   * - 其余 → 403 SCOPE_VIOLATION。
   */
  requireWritable(ownerUserId: string | null | undefined, user: ActingUser, what: string): void {
    if (ownerUserId === null || ownerUserId === undefined) {
      throw new AppError(403, 'TEMPLATE_BUILTIN', `${what} 为内置公共模板,不可修改或删除`)
    }
    if (ownerUserId === user.id) return
    if (user.role === 'admin') return
    throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户`)
  }

  /**
   * 模板可读守卫:属主 / public / admin 放行;他人 private → 403(不存在语义由调用方先判)。
   */
  requireTemplateReadable(tpl: { ownerUserId: string | null, visibility: string }, user: ActingUser, what: string): void {
    if (tpl.ownerUserId === null || tpl.ownerUserId === user.id) return
    if (tpl.visibility === 'public') return
    if (user.role === 'admin') return
    throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户且未公开`)
  }

  /** channel 读取(已认证用户可见本人 + 遗留公共;不存在 → 404) */
  getChannelForUser(channelId: string, userId: string): ChannelRow {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    if (channel.ownerUserId !== null && channel.ownerUserId !== userId) {
      throw new AppError(403, 'SCOPE_VIOLATION', 'channel 不属于当前用户')
    }
    return channel
  }

  /** 用户视角 channel 列表(本人 + 遗留公共) */
  listChannelsForUser(userId: string): ChannelRow[] {
    return this.deps.repos.channels.listForOwner(userId)
  }

  // ===== Workspace(服务端持久化;按 owner 隔离)=====

  listWorkspaces(userId: string): Array<WorkspaceRow & { channelIds: string[] }> {
    return this.deps.repos.users.listWorkspaces(userId).map(ws => ({
      ...ws,
      // 挂载引用自愈:channel 删除(removeChannel)不级联清理 workspace_channels,
      // 死引用会让前端订阅永不到达(左栏"幽灵频道"+ 右栏空数据假象)——
      // 读取时过滤并顺手删除挂载行,历史脏数据随读取收敛
      channelIds: this.deps.repos.users.listMountedChannels(ws.id).filter((id) => {
        if (this.deps.repos.channels.findById(id)) return true
        this.deps.repos.users.unmountChannel(ws.id, id)
        return false
      }),
    }))
  }

  createWorkspace(userId: string, name: string): WorkspaceRow & { channelIds: string[] } {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', 'Workspace 名称不能为空')
    const ws = this.deps.repos.users.createWorkspace(userId, trimmed)
    return { ...ws, channelIds: [] }
  }

  deleteWorkspace(userId: string, workspaceId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    this.deps.repos.users.deleteWorkspace(workspaceId)
  }

  /** 挂载 channel(须为本人的 channel;遗留公共不可挂载) */
  mountChannelToWorkspace(userId: string, workspaceId: string, channelId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    this.requireOwned(channel.ownerUserId, userId, 'channel')
    this.deps.repos.users.mountChannel(workspaceId, channelId)
  }

  unmountChannelFromWorkspace(userId: string, workspaceId: string, channelId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    this.deps.repos.users.unmountChannel(workspaceId, channelId)
  }

  // ===== Channel 管理面 =====

  async createChannel(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    workspace?: string
    leadAgent?: { name: string, harness: string, config?: Record<string, unknown> }
    ownerUserId?: string | null
  }): Promise<{ channelId: string, leadAgentId?: string, workspace: string }> {
    const channel = this.deps.repos.channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
    const workspace = input.workspace && input.workspace.length > 0
      ? input.workspace
      : resolve(process.cwd(), 'data', 'workspaces', channel.id)
    this.deps.repos.channels.update(channel.id, { workspace })
    this.ensureWorkspaceDir(workspace)

    let leadAgentId: string | undefined
    if (input.leadAgent) {
      // lead 内联模板归属 channel 属主(private;避免落成无主内置模板)
      const tpl = this.deps.repos.agents.create({
        name: input.leadAgent.name,
        harness: input.leadAgent.harness,
        config: input.leadAgent.config,
        ownerUserId: input.ownerUserId ?? null,
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

  async updateChannel(channelId: string, patch: { name?: string, description?: string, scenarioPrompt?: string, workspace?: string, enabled?: number }): Promise<ChannelRow> {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    if (patch.workspace !== undefined && patch.workspace !== channel.workspace) {
      this.ensureWorkspaceDir(patch.workspace)
      await this.unloadChannelAgents(channelId)
    }
    if (patch.enabled === 0 && channel.enabled !== 0) {
      await this.unloadChannelAgents(channelId)
    }
    // 场景 prompt 变更 → 回收成员运行时(下次装配注入新场景;进度任务不受影响,
    // 排队任务在成员重新装配后按需恢复)
    if (patch.scenarioPrompt !== undefined && patch.scenarioPrompt !== channel.scenarioPrompt) {
      await this.unloadChannelAgents(channelId)
    }
    const updated = this.deps.repos.channels.update(channelId, patch)
    // 卸载后 channel 需重新激活(懒装配 lead + 恢复调度驱动)
    if (updated && updated.leadAgentId && (patch.scenarioPrompt !== undefined || patch.workspace !== undefined)) {
      this.ensureChannelActive(channelId)
    }
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
    // 记忆级联清理:成员私有行 + team 公共行(防残留行污染他 channel 的 FTS/team 检索域)
    this.deps.repos.memories.deleteByChannel(channelId)
    this.deps.repos.channels.remove(channelId)
  }

  // ===== Agent 模板管理面(全局,可复用;v10 可见性隔离) =====

  /** 创建 Agent 模板(可复用数据结构;visibility 缺省 private) */
  async createAgent(input: {
    name: string
    harness: string
    config?: Record<string, unknown>
    visibility?: string
    ownerUserId?: string | null
  }): Promise<AgentTemplateDetail> {
    const row = this.deps.repos.agents.create({ name: input.name, harness: input.harness, config: input.config, visibility: input.visibility, ownerUserId: input.ownerUserId ?? null })
    return this.templateDetailOf(row)
  }

  /** 列出全部 Agent 模板(全局) */
  async listAgents(): Promise<AgentTemplateDetail[]> {
    return this.deps.repos.agents.list().map(row => this.templateDetailOf(row))
  }

  /** 用户视角模板列表(本人 + 遗留公共) */
  async listAgentsForUser(userId: string): Promise<AgentTemplateDetail[]> {
    return this.deps.repos.agents.listForOwner(userId).map(row => this.templateDetailOf(row))
  }

  /** 可见性感知列表:普通用户 = 本人(任意可见性)+ 全部 public(含内置);admin = 全量 */
  async listAgentsVisibleTo(user: ActingUser): Promise<AgentTemplateDetail[]> {
    const rows = user.role === 'admin'
      ? this.deps.repos.agents.list()
      : this.deps.repos.agents.listVisible(user.id)
    return rows.map(row => this.templateDetailOf(row))
  }

  /** Agent 模板详情(含其克隆出的全部实例) */
  getAgent(agentId: string): AgentTemplateDetail | undefined {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) return undefined
    return this.templateDetailOf(row)
  }

  /** 更新 Agent 模板(name/harness/config/enabled/visibility);不影响已克隆实例(复制语义) */
  async updateAgent(agentId: string, patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, visibility?: string }): Promise<AgentTemplateDetail> {
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
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
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
    /** 模板 config 覆盖项(浅合并;用于注入/覆盖 systemPromptPrefix 等场景配置) */
    configOverride?: Record<string, unknown>
    /** 操作发起方(AEP agent.member 的 by;缺省 'user') */
    by?: string
    reason?: string
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
      config: { ...parseJson<Record<string, unknown>>(tpl.configJson, {}), ...input.configOverride },
      role: input.role,
    })
    if (input.role === 'lead') {
      this.deps.repos.channels.update(input.channelId, { leadAgentId: inst.id })
    }
    this.notifyMember(input.channelId, {
      op: 'added',
      agentId: inst.id,
      name: inst.name,
      role: inst.role as 'lead' | 'worker',
      harness: inst.harness,
      enabled: inst.enabled,
      config: parseJson<Record<string, unknown>>(inst.configJson, {}),
      by: input.by ?? 'user',
      reason: input.reason,
    })
    return instanceToAgentInfo(inst)
  }

  async listChannelAgents(channelId: string): Promise<AgentInfo[]> {
    return this.deps.repos.channelAgents.listByChannel(channelId).map(instanceToAgentInfo)
  }

  /** Agent 记忆列表(私有观察面;content 还原为未切分原文,客户端可读):实例须存在于本 channel */
  listMemories(channelId: string, agentId: string, limit = 50): MemoryRow[] {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${agentId}`)
    return this.deps.repos.memories.listByAgent(agentId, limit)
      .map(r => ({ ...r, content: unsegmentCJK(r.content) }))
  }

  /**
   * 记忆混合检索(REST/客户端观察面;与 agent 运行时 search_memory 工具同源算法):
   * 以 targetAgent 视角召回(私有域 + 本 channel 公共域),scope 过滤同 recallRows。
   * caller 须为本 channel 成员;返回结构化片段(综合分排序,content 未切分原文)。
   */
  async searchAgentMemories(
    channelId: string,
    callerAgentId: string,
    targetAgentId: string,
    input: { query: string, scope?: 'auto' | 'private' | 'shared', limit?: number },
    opts: { byOwner?: boolean } = {},
  ): Promise<MemorySnippet[]> {
    // byOwner:人类 owner(channel 属主)经控制台检索,跳过 agent 成员校验
    if (!opts.byOwner) this.requireMember(channelId, callerAgentId)
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: targetAgentId, embedder: this.memoryEmbedder ?? undefined })
    return mem.recallRows(input.query, { scope: input.scope, limit: input.limit })
  }

  // ===== 团队共享记忆域(agent_id='__team__' 哨兵;lead 策展,channel 内全员 recall 可见)=====

  /** 团队共享记忆列表(channel 级;任意本 channel 成员可读;content 还原为未切分原文) */
  listTeamMemories(channelId: string, limit = 50): MemoryRow[] {
    if (!this.deps.repos.channels.findById(channelId)) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    return this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, limit)
      .map(r => ({ ...r, content: unsegmentCJK(r.content) }))
  }

  /** 写/更新团队记忆(仅 lead;稳定 dedupKey 幂等刷新;成功后 fire-and-forget 向量化) */
  addTeamMemory(channelId: string, callerAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string }, opts: { byOwner?: boolean } = {}): MemoryRow[] {
    // byOwner:人类 owner 策展(与 lead 同权;curator 身份以 __team__ 哨兵入事件)
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可写团队记忆')
    }
    const dedupKey = input.dedupKey ?? `manual:${randomUUID()}`
    this.deps.repos.memories.upsert({
      channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    })
    // 策展行同样入向量域(未切分原文;provider 未配置/失败 → 静默留 FTS)
    void vectorizeMemory(this.deps.repos.memories, this.memoryEmbedder, channelId, TEAM_AGENT_ID, dedupKey, input.content).catch(() => {})
    this.buses.get(channelId)?.notifyMemory({ agentId: callerAgentId, scope: 'shared', title: input.title, dedupKey })
    return this.listTeamMemories(channelId)
  }

  /** 删团队记忆(仅 lead;vec 行残留由维护任务统一清理) */
  deleteTeamMemory(channelId: string, callerAgentId: string, memoryId: string, opts: { byOwner?: boolean } = {}): void {
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可删团队记忆')
    }
    const row = this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, 1_000_000).find(r => r.id === memoryId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `团队记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
  }

  /** 手动触发记忆衰减清理(REST 透传;策略与定时器同一函数) */
  runMemoryMaintenanceNow(): MaintenanceResult {
    return runMemoryMaintenance(this.deps.repos.memories)
  }

  // ===== Agent 私有记忆策展(本人或 lead 写/删;kind='semantic' 人工策展)=====

  /** 写/更新 Agent 私有记忆(caller 须为本人或 lead;稳定 dedupKey 幂等刷新)。
   *  scope='shared'(caller 任意成员)→ 落 Channel 公共域(agent:<caller>:<key> 命名空间,全员可检索)。 */
  addAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string, scope?: 'private' | 'shared' }, opts: { byOwner?: boolean } = {}): void {
    // byOwner:人类 owner 策展任意成员记忆(本人/lead 校验旁路;curator 以目标成员入事件)
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller) throw new AppError(403, 'SCOPE_VIOLATION', '调用方 Agent 不在本 channel')
      if (input.scope !== 'shared' && callerAgentId !== targetAgentId && caller.role !== 'lead') {
        throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可策展 Agent 记忆')
      }
    }
    if (input.scope === 'shared') {
      // 共享域:走 AgentMemory.save 同源路径(命名空间 dedup + 自动向量化)
      const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: callerAgentId, embedder: this.memoryEmbedder ?? undefined })
      void mem.save({
        title: input.title,
        content: input.content,
        importance: input.importance,
        scope: 'shared',
        dedupKey: input.dedupKey,
      }).then(saved => this.buses.get(channelId)?.notifyMemory({ agentId: callerAgentId, scope: 'shared', title: input.title, dedupKey: saved.dedupKey })).catch(() => {})
      return
    }
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    const dedupKey = input.dedupKey ?? `manual:${randomUUID()}`
    this.deps.repos.memories.upsert({
      channelId,
      agentId: targetAgentId,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    })
    // 策展行同样入向量域(未切分原文;provider 未配置/失败 → 静默留 FTS)
    void vectorizeMemory(this.deps.repos.memories, this.memoryEmbedder, channelId, targetAgentId, dedupKey, input.content).catch(() => {})
    this.buses.get(channelId)?.notifyMemory({ agentId: targetAgentId, scope: 'private', title: input.title, dedupKey })
  }

  /** 删 Agent 私有记忆(caller 须为本人或 lead;行须属该 agent) */
  deleteAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, memoryId: string, opts: { byOwner?: boolean } = {}): void {
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || (callerAgentId !== targetAgentId && caller.role !== 'lead')) {
        throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可删除 Agent 记忆')
      }
    }
    const row = this.deps.repos.memories.listByAgent(targetAgentId, 10_000)
      .find(r => r.id === memoryId && r.channelId === channelId && r.agentId === targetAgentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
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
  async updateChannelAgent(
    instanceId: string,
    patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number },
    meta?: { channelId?: string, by?: string, reason?: string },
  ): Promise<AgentInfo> {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    const updated = this.deps.repos.channelAgents.update(instanceId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    await this.unloadAgent(updated.channelId, instanceId)
    this.notifyMember(updated.channelId, {
      op: 'updated',
      agentId: instanceId,
      name: updated.name,
      role: updated.role as 'lead' | 'worker',
      harness: updated.harness,
      enabled: updated.enabled,
      config: parseJson<Record<string, unknown>>(updated.configJson, {}),
      by: meta?.by ?? 'user',
      reason: meta?.reason,
    })
    return instanceToAgentInfo(updated)
  }

  /** 从 channel 移除实例(仅删实例,不删模板) */
  async removeAgentFromChannel(channelId: string, instanceId: string, meta?: { by?: string, reason?: string }): Promise<void> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, instanceId)
    if (!m) return
    await this.stopAndDetach(channelId, instanceId)
    if (m.role === 'lead') {
      this.deps.repos.channels.update(channelId, { leadAgentId: null })
    }
    this.deps.repos.subscriptions.removeByAgent(channelId, instanceId)
    this.deps.repos.channelAgents.remove(channelId, instanceId)
    this.notifyMember(channelId, {
      op: 'removed',
      agentId: instanceId,
      name: m.name,
      role: m.role as 'lead' | 'worker',
      harness: m.harness,
      enabled: m.enabled,
      by: meta?.by ?? 'user',
      reason: meta?.reason,
    })
  }

  // ===== Lead 自主团队管理面(执行中扩容/调参/裁撤;工具桥 + 调度决策共用) =====

  /** lead 在本 channel 新建团队成员(worker):按需落模板(owner=channel 属主)并克隆为独立实例 */
  async createTeamMember(
    channelId: string,
    callerAgentId: string,
    input: { name: string, harness?: string, config?: Record<string, unknown>, templateId?: string, reason?: string },
  ): Promise<AgentInfo> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    const name = input.name.trim()
    if (!name) throw new AppError(400, 'BAD_REQUEST', '成员名不能为空')
    let templateId = input.templateId
    if (templateId) {
      if (!this.deps.repos.agents.findById(templateId)) {
        throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${templateId}`)
      }
    }
    else {
      const harness = input.harness ?? 'omp'
      if (!KNOWN_HARNESSES.has(harness)) {
        throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${harness}(可选 ${[...KNOWN_HARNESSES].join('/')})`)
      }
      const tpl = this.deps.repos.agents.create({
        name,
        harness,
        config: input.config,
        ownerUserId: channel.ownerUserId ?? null,
      })
      templateId = tpl.id
    }
    // 新成员立即装配:lead 建员即进入 channel 运行时(前端/调度立即可见,
    // 无需等首次任务投递的懒加载;DB 已由 addAgentToChannel 同步落库)
    const member = await this.addAgentToChannel({
      channelId,
      agentId: templateId,
      role: 'worker',
      by: `lead:${callerAgentId}`,
      reason: input.reason,
    })
    this.ensureAgentRuntime(channelId, member.id)
    return member
  }

  /** lead 更新团队成员(改名/改配置/启停;不能改自己);变更后卸载运行时,下次消费按新配置重载 */
  async updateTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    patch: { name?: string, config?: Record<string, unknown>, enabled?: number, reason?: string },
  ): Promise<AgentInfo> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    if (agentId === callerAgentId) {
      throw new AppError(400, 'BAD_REQUEST', 'lead 不能在执行中更新自己(避免自毁调度循环)')
    }
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!target) throw new AppError(404, 'NOT_FOUND', `团队成员不存在: ${agentId}`)
    return this.updateChannelAgent(agentId, patch, { channelId, by: `lead:${callerAgentId}`, reason: patch.reason })
  }

  /**
   * lead 移除团队成员(worker;不能移除自己)。
   * 孤儿任务回收(成员移除后其任务不能悬死):
   *  - SUBMITTED/ASSIGNED(排队中)→ 重派给剩余队列最短的 worker;无接收者 → 取消
   *  - WORKING/WAITING(执行中)→ 中止运行时并置 FAILED,交调度循环按重试策略重派
   */
  async removeTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    reason?: string,
  ): Promise<{ recycledTasks: string[] }> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    if (agentId === callerAgentId) {
      throw new AppError(400, 'BAD_REQUEST', 'lead 不能移除自己(移除 lead 请用 REST 删除)')
    }
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!target) throw new AppError(404, 'NOT_FOUND', `团队成员不存在: ${agentId}`)

    const recycledTasks: string[] = []
    const orphans = this.deps.repos.tasks
      .listByChannelAssignee(channelId, agentId)
      .map(rowToTask)
      .filter(t => !TERMINAL_TASK_STATES[t.state])
    for (const task of orphans) {
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') {
        const receiver = this.pickReceiverWorker(channelId, agentId)
        if (receiver) {
          this.getTaskEngine().reassign(task.id, receiver)
          this.wakeAgent(channelId, receiver)
        }
        else {
          this.getTaskEngine().cancel(task.id, callerAgentId)
        }
      }
      else {
        // WORKING/WAITING:先中止在跑回合,再走 FAILED(调度循环 retry/reassign 兜底)
        this.runtimeOf(channelId, agentId)?.abortCurrent()
        if (task.state === 'WAITING') {
          this.getTaskEngine().transition(task.id, 'WORKING', callerAgentId)
        }
        this.getTaskEngine().transition(task.id, 'FAILED', callerAgentId)
      }
      recycledTasks.push(task.id)
    }

    await this.removeAgentFromChannel(channelId, agentId, { by: `lead:${callerAgentId}`, reason })
    // lead 现场创建的一次性模板:无任何 channel 实例、未被编组引用 → 连模板一并删除
    // (数据库信息彻底清理;有外部引用则保留模板,仅删实例行)
    if (target.templateId) {
      const instances = this.deps.repos.channelAgents.listByTemplate(target.templateId)
      const teamRefs = this.deps.repos.teamMembers.listByTemplate(target.templateId)
      if (instances.length === 0 && teamRefs.length === 0) {
        this.deps.repos.agents.remove(target.templateId)
      }
    }
    return { recycledTasks }
  }

  /** 剩余可用 worker 里选队列最短者(成员移除重派接收者) */
  private pickReceiverWorker(channelId: string, excludeAgentId: string): string | null {
    const candidates = this.deps.repos.channelAgents
      .listByChannel(channelId)
      .filter(m => m.enabled === 1 && m.role === 'worker' && m.id !== excludeAgentId)
    let best: string | null = null
    let bestLen = Number.POSITIVE_INFINITY
    for (const m of candidates) {
      const len = this.getTaskEngine().queueViewOf(channelId, m.id).queued.length
      if (len < bestLen) {
        best = m.id
        bestLen = len
      }
    }
    return best
  }

  // ===== AgentTeam 管理面(模板编组 + 批量部署;v10 可见性隔离) =====

  /** 创建 AgentTeam */
  async createTeam(input: { name: string, description?: string, visibility?: string, ownerUserId?: string | null }): Promise<AgentTeamDetail> {
    const row = this.deps.repos.teams.create({ name: input.name, description: input.description, visibility: input.visibility, ownerUserId: input.ownerUserId ?? null })
    return this.teamDetailOf(row)
  }

  /** 全部 AgentTeam */
  async listTeams(): Promise<AgentTeamDetail[]> {
    return this.deps.repos.teams.list().map(row => this.teamDetailOf(row))
  }

  /** 用户视角编组列表(本人 + 遗留公共) */
  async listTeamsForUser(userId: string): Promise<AgentTeamDetail[]> {
    return this.deps.repos.teams.listForOwner(userId).map(row => this.teamDetailOf(row))
  }

  /** 可见性感知列表:普通用户 = 本人(任意可见性)+ 全部 public(含内置);admin = 全量 */
  async listTeamsVisibleTo(user: ActingUser): Promise<AgentTeamDetail[]> {
    const rows = user.role === 'admin'
      ? this.deps.repos.teams.list()
      : this.deps.repos.teams.listVisible(user.id)
    return rows.map(row => this.teamDetailOf(row))
  }

  /** AgentTeam 详情(含成员模板快照);不存在返回 undefined */
  getTeam(teamId: string): AgentTeamDetail | undefined {
    const row = this.deps.repos.teams.findById(teamId)
    if (!row) return undefined
    return this.teamDetailOf(row)
  }

  /** 更新 AgentTeam(name/description/visibility) */
  async updateTeam(teamId: string, patch: { name?: string, description?: string, visibility?: string }): Promise<AgentTeamDetail> {
    const updated = this.deps.repos.teams.update(teamId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
    return this.teamDetailOf(updated)
  }

  /** 删除 AgentTeam(仅删编组关系,不动模板与其已部署实例) */
  async removeTeam(teamId: string): Promise<void> {
    this.deps.repos.teams.remove(teamId)
  }

  /** 把 Agent 模板加入 AgentTeam(同 team 内模板唯一;至多一个 lead) */
  async addTemplateToTeam(input: { teamId: string, templateId: string, role?: 'lead' | 'worker' }): Promise<AgentTeamDetail> {
    const team = this.deps.repos.teams.findById(input.teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${input.teamId}`)
    const tpl = this.deps.repos.agents.findById(input.templateId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${input.templateId}`)
    const role = input.role ?? 'worker'
    if (this.deps.repos.teamMembers.findByTeamTemplate(input.teamId, input.templateId)) {
      throw new AppError(409, 'ALREADY_MEMBER', `模板 ${input.templateId} 已在 team ${input.teamId} 中`)
    }
    if (role === 'lead' && this.deps.repos.teamMembers.countLead(input.teamId) > 0) {
      throw new AppError(409, 'LEAD_EXISTS', `team ${input.teamId} 已存在 lead`)
    }
    this.deps.repos.teamMembers.add({ teamId: input.teamId, templateId: input.templateId, role })
    return this.teamDetailOf(team)
  }

  /** 从 AgentTeam 移除 Agent 模板(仅删编组关系) */
  async removeTemplateFromTeam(teamId: string, templateId: string): Promise<AgentTeamDetail> {
    const team = this.deps.repos.teams.findById(teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
    const member = this.deps.repos.teamMembers.findByTeamTemplate(teamId, templateId)
    if (!member) throw new AppError(404, 'NOT_FOUND', `模板 ${templateId} 不在 team ${teamId} 中`)
    this.deps.repos.teamMembers.remove(teamId, templateId)
    return this.teamDetailOf(team)
  }

  /**
   * 批量部署 AgentTeam → Channel:对每个成员模板调用 addAgentToChannel 克隆出独立实例。
   * - channel 已有 lead 且 team 成员含 lead → 该成员 409 LEAD_EXISTS,默认整体失败(事务性语义)。
   *   实际上为简化:逐个克隆,失败时抛错(已克隆实例保留,调用方可 remove 重试)。
   * - 返回每个成员的部署结果(实例 AgentInfo)。
   */
  async deployTeamToChannel(input: {
    channelId: string
    teamId: string
  }): Promise<{ channelId: string, teamId: string, agents: AgentInfo[] }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${input.channelId}`)
    const team = this.deps.repos.teams.findById(input.teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${input.teamId}`)
    const members = this.deps.repos.teamMembers.listByTeam(input.teamId)
    if (members.length === 0) {
      throw new AppError(400, 'TEAM_EMPTY', `team ${input.teamId} 无成员,先添加 Agent 模板`)
    }
    const agents: AgentInfo[] = []
    for (const m of members) {
      const inst = await this.addAgentToChannel({
        channelId: input.channelId,
        agentId: m.templateId,
        role: m.role === 'lead' ? 'lead' : 'worker',
      })
      agents.push(inst)
    }
    return { channelId: input.channelId, teamId: input.teamId, agents }
  }

  private teamDetailOf(row: TeamRow): AgentTeamDetail {
    const members = this.deps.repos.teamMembers.listByTeam(row.id)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      members: members.map((m) => {
        const tpl = this.deps.repos.agents.findById(m.templateId)
        return {
          templateId: m.templateId,
          name: tpl?.name ?? '(deleted)',
          harness: tpl?.harness ?? '',
          role: m.role === 'lead' ? 'lead' : 'worker',
          addedAt: m.createdAt,
        }
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== Channel 模板管理面(v10:场景 + 工作目录 + 成员组合;实例化一键建 channel) =====

  /** 可见性感知 Channel 模板列表:普通用户 = 本人 + public(含内置);admin = 全量 */
  listChannelTemplatesVisibleTo(user: ActingUser): ChannelTemplateDetail[] {
    const rows = user.role === 'admin'
      ? this.deps.repos.channelTemplates.list()
      : this.deps.repos.channelTemplates.listVisible(user.id)
    return rows.map(row => this.channelTemplateDetailOf(row))
  }

  /** Channel 模板详情;不存在返回 undefined */
  getChannelTemplate(templateId: string): ChannelTemplateDetail | undefined {
    const row = this.deps.repos.channelTemplates.findById(templateId)
    if (!row) return undefined
    return this.channelTemplateDetailOf(row)
  }

  /** 创建 Channel 模板 */
  createChannelTemplate(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    workspace?: string
    lead?: { name: string, harness: string, config?: Record<string, unknown> } | null
    members?: ChannelTemplateMember[]
    visibility?: string
    ownerUserId: string
  }): ChannelTemplateDetail {
    this.assertHarness(input.lead?.harness)
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: input.scenarioPrompt,
      workspace: input.workspace,
      lead: input.lead ?? null,
      members: input.members ?? [],
      visibility: input.visibility,
      ownerUserId: input.ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 从既有 Channel 实例捕获模板:场景 + 工作目录 + lead(内联)+ 成员(有模板引用则引用,否则内联快照) */
  createChannelTemplateFromChannel(channelId: string, input: { name: string, description?: string, visibility?: string }, ownerUserId: string): ChannelTemplateDetail {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    const members = this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.id !== channel.leadAgentId)
      .map((m): ChannelTemplateMember => m.templateId
        ? { templateId: m.templateId, role: m.role === 'lead' ? 'lead' : 'worker' }
        : { inline: { name: m.name, harness: m.harness, config: parseJson<Record<string, unknown>>(m.configJson, {}) }, role: m.role === 'lead' ? 'lead' : 'worker' })
    const leadInst = channel.leadAgentId
      ? this.deps.repos.channelAgents.findById(channel.leadAgentId)
      : undefined
    const lead = leadInst
      ? {
          name: leadInst.name,
          harness: leadInst.harness,
          config: parseJson<Record<string, unknown>>(leadInst.configJson, {}),
        }
      : null
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: channel.scenarioPrompt,
      workspace: channel.workspace,
      lead,
      members,
      visibility: input.visibility,
      ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 更新 Channel 模板(属主/admin;内置拒绝) */
  updateChannelTemplate(templateId: string, patch: Parameters<ChannelTemplateRepo['update']>[1]): ChannelTemplateDetail {
    const updated = this.deps.repos.channelTemplates.update(templateId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    return this.channelTemplateDetailOf(updated)
  }

  /** 删除 Channel 模板(属主/admin;内置拒绝) */
  removeChannelTemplate(templateId: string): void {
    this.deps.repos.channelTemplates.remove(templateId)
  }

  /**
   * 实例化 Channel 模板 → 新 channel(属主 = 操作用户):
   * 场景/工作目录照搬;lead 内联创建;成员逐个克隆(引用模板时校验操作者可读)。
   * 返回 createChannel 同构结果 + 成员实例数。
   */
  async instantiateChannelTemplate(templateId: string, user: ActingUser, nameOverride?: string): Promise<{ channelId: string, workspace: string, agentCount: number, leadAgentId?: string }> {
    const tpl = this.deps.repos.channelTemplates.findById(templateId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    this.requireTemplateReadable(tpl, user, 'Channel 模板')
    const lead = tpl.leadJson
      ? parseJson<{ name: string, harness: string, config?: Record<string, unknown> } | null>(tpl.leadJson, null)
      : null
    const created = await this.createChannel({
      name: (nameOverride && nameOverride.trim()) || tpl.name,
      description: tpl.description,
      scenarioPrompt: tpl.scenarioPrompt,
      workspace: tpl.workspace || undefined,
      leadAgent: lead ? { name: lead.name, harness: lead.harness, config: lead.config } : undefined,
      ownerUserId: user.id,
    })
    const members = parseJson<ChannelTemplateMember[]>(tpl.membersJson, [])
    let agentCount = lead ? 1 : 0
    for (const m of members) {
      if ('templateId' in m) {
        const tplRow = this.deps.repos.agents.findById(m.templateId)
        if (!tplRow) throw new AppError(404, 'NOT_FOUND', `成员 Agent 模板不存在: ${m.templateId}`)
        this.requireTemplateReadable(tplRow, user, '成员 Agent 模板')
        await this.addAgentToChannel({ channelId: created.channelId, agentId: m.templateId, role: m.role, by: 'template' })
      }
      else {
        this.assertHarness(m.inline.harness)
        const inlineTpl = await this.createAgent({ name: m.inline.name, harness: m.inline.harness, config: m.inline.config, ownerUserId: user.id })
        await this.addAgentToChannel({ channelId: created.channelId, agentId: inlineTpl.id, role: m.role, by: 'template' })
      }
      agentCount += 1
    }
    return { channelId: created.channelId, workspace: created.workspace, agentCount, leadAgentId: created.leadAgentId }
  }

  private assertHarness(harness: string | undefined): void {
    if (harness && !KNOWN_HARNESSES.has(harness)) {
      throw new AppError(400, 'BAD_REQUEST', `未知 harness: ${harness}`)
    }
  }

  private channelTemplateDetailOf(row: ChannelTemplateRow): ChannelTemplateDetail {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scenarioPrompt: row.scenarioPrompt,
      workspace: row.workspace,
      lead: row.leadJson ? parseJson<ChannelTemplateDetail['lead']>(row.leadJson, null) : null,
      members: parseJson<ChannelTemplateMember[]>(row.membersJson, []),
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== 任务作业面 =====

  /**
   * 人类向 channel 提交任务(HITL 控制面入口):
   *  - 缺省 assigneeId → 自动路由 lead(原行为);
   *  - 指定 assigneeId(Composer @ 某成员)→ 直发该成员:任务 create→ASSIGNED,
   *    assign 消息直投其信箱(不经 lead 调度,人类即此刻的调度者);
   *  - fromLabel(登录用户名)盖章 x-aw-from-label → 时间线以"用户章"渲染发送者。
   */
  async submitChannelTask(input: {
    channelId: string
    title: string
    description?: string
    parts?: Part[]
    mode?: ExecutionMode
    modeConfig?: ModeConfig
    /** HITL 直发目标(缺省 lead);须为本 channel 启用成员 */
    assigneeId?: string
    /** 人类发送者显示名(时间线归属) */
    fromLabel?: string
  }): Promise<WorkspaceTask> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel || !channel.leadAgentId) {
      throw new AppError(400, 'NO_LEAD_AGENT', `channel ${input.channelId} 无 lead,请先创建 lead`)
    }
    if (channel.enabled !== 1) {
      throw new AppError(403, 'CHANNEL_DISABLED', `channel ${input.channelId} 已禁用`)
    }
    this.ensureChannelActive(input.channelId)
    // 入口幂等(数据状态驱动):同 channel 同标题且**非终态**的任务已存在 → 409。
    // 挡住 HITL 双击/客户端重试造成的重复执行;前一轮已 COMPLETED 的 loop 重放
    // (LoopController → 本方法)不受影响 —— 终态不参与判定
    const duplicate = this.getTaskEngine().list(input.channelId).find(t =>
      t.title === input.title
      && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
    if (duplicate) {
      throw new AppError(409, 'TASK_DUPLICATE', `同标题任务已在途:「${input.title}」(${duplicate.id.slice(0, 8)},${duplicate.state}),请等待其完成或取消后再提交`)
    }
    // HITL 直发目标校验 + 容错寻址(id/名字/唯一前缀;人类输入名字即可直发)
    let assigneeId = channel.leadAgentId
    if (input.assigneeId && input.assigneeId !== channel.leadAgentId) {
      assigneeId = this.resolveMemberRef(input.channelId, input.assigneeId).id
    }
    const description = input.mode
      ? encodeTaskMode(input.mode, input.modeConfig ?? {}, input.description ?? '')
      : input.description
    let task = this.getTaskEngine().create({
      channelId: input.channelId,
      creatorId: '',
      assigneeId,
      title: input.title,
      description,
      parts: input.parts,
    })
    // 直发 worker:补 ASSIGNED 迁移(与 dispatchTask 独立任务同构,worker 消费循环按 assign 起回合)
    if (assigneeId !== channel.leadAgentId) {
      task = this.getTaskEngine().transition(task.id, 'ASSIGNED', 'system')
    }
    const messageMetadata: Record<string, unknown> = {
      'x-aw-task-kind': 'assign',
      'x-aw-task-id': task.id,
    }
    if (input.fromLabel) messageMetadata['x-aw-from-label'] = input.fromLabel
    const message = buildMessage(input.channelId, 'ROLE_USER', input.parts ?? [], messageMetadata)
    message.taskId = task.id
    const delivered = this.route(input.channelId, message)
    if (!delivered.includes(assigneeId)) {
      // 投递失败补偿:任务回收终态(不留幽灵任务,用户重试不再累积重复任务)
      this.getTaskEngine().transition(task.id, 'CANCELED', 'system')
      throw new AppError(502, 'DELIVERY_FAILED', `任务指派未能投递到 ${assigneeId.slice(0, 8)} 的信箱,请重试`)
    }
    if (assigneeId !== channel.leadAgentId) this.wakeAgent(input.channelId, assigneeId)
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
      routeReason?: string
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
      // 防重复派发守卫(确定性,不依赖 LLM 纪律):同父任务下同标题子任务
      //  - 在途(非终态)→ 拒绝,告知等待现有执行(省 token 不重跑)
      //  - 已完成且有交付 → 拒绝,直接附上既有成果预览(lead 可引用,不必重做)
      const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
      const siblings = this.getTaskEngine().list(channelId).filter(t => t.parentId === input.parentTaskId)
      const dupTitle = (t: WorkspaceTask): boolean => norm(t.title) === norm(input.title)
      const inFlight = siblings.find(t => dupTitle(t) && !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state))
      if (inFlight) {
        throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已在执行中(状态 ${inFlight.state},指派 ${inFlight.assigneeId?.slice(0, 8) ?? '?'})。不要重复派发——等待其完成;若内容有差异请换一个能区分意图的标题。`)
      }
      const done = siblings.find(t => dupTitle(t) && t.state === 'COMPLETED' && t.artifacts.length > 0)
      if (done) {
        const preview = done.artifacts[0]?.parts
          ?.map(p => ('text' in p ? p.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) ?? ''
        throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已完成并交付(任务 ${done.id})。已有成果:${preview || '(见任务详情)'}。直接引用该成果即可,不要重复派发相同工作。`)
      }
      task = this.getTaskEngine().dispatch(parent, {
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
        routeReason: input.routeReason,
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
      const delivered = this.route(channelId, message)
      if (!delivered.includes(input.assigneeId)) {
        // 投递失败补偿:子任务回收终态(父任务等全部子任务终态后由调度器重新决策)
        this.getTaskEngine().transition(task.id, 'CANCELED', callerAgentId)
        throw new AppError(502, 'DELIVERY_FAILED', `子任务指派未能投递到 ${input.assigneeId.slice(0, 8)} 的信箱,请重试或改派`)
      }
    }
    return task
  }

  /**
   * 任务拒绝(assignee 认为任务超出自己能力/作业范畴时主动退回):
   *  - 任务置 FAILED(调度器将按重试规则改派他人,而非本 Agent 硬扛或静默搁置);
   *  - 回执拒绝通知:优先发任务创建者(本 channel 成员),否则 channel lead ——
   *    有发送人就必须让对方知道"为什么被拒",防止错发任务石沉大海。
   */
  async refuseTask(
    channelId: string,
    refuserId: string,
    taskId: string,
    reason: string,
  ): Promise<{ task: WorkspaceTask, notifiedTo: string | null }> {
    this.requireMember(channelId, refuserId)
    const engine = this.getTaskEngine()
    const task = engine.get(taskId)
    if (!task || task.channelId !== channelId) {
      throw new AppError(404, 'NOT_FOUND', `任务不存在或不在本 channel: ${taskId}`)
    }
    if (task.assigneeId !== refuserId) {
      throw new AppError(403, 'SCOPE_VIOLATION', `只能拒绝指派给自己的任务(assignee=${task.assigneeId.slice(0, 8)})`)
    }
    if (task.state === 'WAITING') {
      throw new AppError(400, 'INVALID_TRANSITION', 'WAITING 父任务(有子任务/阶段在执行)不可整体拒绝;请拒绝对应的子任务,父任务会按子任务结果汇总')
    }
    const trimmedReason = reason.trim()
    if (!trimmedReason) throw new AppError(400, 'BAD_REQUEST', '拒绝必须说明原因(reason)')

    let current = task
    if (!TERMINAL_TASK_STATES[current.state]) {
      // 状态机需经 WORKING 到 FAILED(SUBMITTED/ASSIGNED 直达 FAILED 非法)
      if (current.state === 'SUBMITTED' || current.state === 'ASSIGNED') {
        current = engine.transition(taskId, 'WORKING', refuserId)
      }
      if (current.state !== 'FAILED') {
        current = engine.transition(taskId, 'FAILED', refuserId)
      }
      // 拒绝理由进任务历史(审计留痕)
      this.deps.repos.tasks.update(taskId, {
        history: [...current.history, {
          messageId: randomUUID(),
          contextId: channelId,
          role: 'ROLE_AGENT' as const,
          parts: [{ text: `[任务拒绝] ${refuserId.slice(0, 8)}:${trimmedReason}` }],
        }],
      })
    }

    // 回执对象:任务创建者(仍为本 channel 在册成员)优先,fallback channel lead
    const members = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.enabled === 1)
    const notifyTo = members.find(m => m.id === task.creatorId)?.id
      ?? members.find(m => m.role === 'lead')?.id
      ?? null
    if (notifyTo && notifyTo !== refuserId) {
      const message = buildMessage(channelId, 'ROLE_AGENT', [{
        text: `【任务拒绝回执】任务「${task.title}」(${taskId.slice(0, 8)}) 已被 ${refuserId.slice(0, 8)} 拒绝。原因:${trimmedReason}。请改派给能力匹配的成员,或取消该任务。`,
      }], {
        'x-aw-target-agent': notifyTo,
        'x-aw-from-agent': refuserId,
        'x-aw-msg-priority': 'immediate',
      })
      const delivered = this.route(channelId, message)
      return { task: engine.get(taskId) ?? current, notifiedTo: delivered.includes(notifyTo) ? notifyTo : null }
    }
    return { task: engine.get(taskId) ?? current, notifiedTo: null }
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
    // 终态设防:进度/交付物/历史是任务活性信号,终态任务(COMPLETED/FAILED/CANCELED)
    // 不得再写 —— 否则状态数据被污染(如 cancel 后迟到回合继续长出"新进度"),
    // 破坏"所有执行都标记 state"的数据状态驱动不变量
    if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELED') {
      return task
    }
    const patch: TaskPatch = {}
    if (input.progress !== undefined) patch.progress = input.progress
    if (input.artifact) patch.artifacts = [...task.artifacts, input.artifact]
    if (input.message) {
      patch.history = [
        ...task.history,
        { messageId: randomUUID(), contextId: task.channelId, role: 'ROLE_AGENT' as const, parts: [{ text: input.message }] },
      ].slice(-200)
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
    // 终态幂等:已完成 → 原样返回(重复 complete 不炸);
    // 已取消/失败 → 语义化错误(非裸状态机异常),调用方可据此引导继续下一项
    if (task.state === 'COMPLETED') return task
    if (task.state === 'CANCELED' || task.state === 'FAILED') {
      throw new AppError(409, 'TASK_TERMINAL', `任务 ${input.taskId.slice(0, 8)} 已被平台${task.state === 'CANCELED' ? '取消' : '判定失败'},不能再标记完成;请继续处理队列下一项`)
    }
    const completed = this.getTaskEngine().complete(input.taskId, input.artifacts)
    // goal 保底合成产物广播(goal 模式父任务且 lead 未自带总结时,taskEngine 追加了
    // 平台合成的 goal-summary;以 goal-summary 语义 + artifactId 差集识别,幂等不重复广播)
    const knownIds = new Set([
      ...task.artifacts.map(a => a.artifactId),
      ...(input.artifacts ?? []).map(a => a.artifactId),
    ])
    for (const artifact of completed.artifacts) {
      if (isGoalSummaryArtifact(artifact) && !knownIds.has(artifact.artifactId)) {
        this.runtimeOf(channelId, callerAgentId)?.emitExternal({ kind: 'artifact', artifact }, callerAgentId)
      }
    }
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

  /**
   * HITL:前端独立中断指定成员运行时(worker 或 lead)。
   *  - worker:强制 stop + detach(中断当前 run/杀子进程),成员行保留 enabled=1,
   *    后续任务投递按需重新装配(interrupt 语义,不删成员)。
   *  - lead:stopAndDetach 内部同时停 SchedulerLoop;channel 恢复活跃由
   *    下次任务提交(ensureChannelActive)自动重装配 lead + 调度器。
   * 变更经 AEP agent.member(op=updated) 广播回流前端。
   */
  async stopAgentRuntime(channelId: string, agentId: string, by = 'user'): Promise<{ agentId: string, stopped: boolean }> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
    await this.stopAndDetach(channelId, agentId)
    this.notifyMember(channelId, {
      op: 'updated',
      agentId,
      name: m.name,
      role: m.role as 'lead' | 'worker',
      harness: m.harness,
      enabled: m.enabled,
      by,
      reason: 'HITL stop',
    })
    return { agentId, stopped: true }
  }

  /**
   * HITL:用户重试 FAILED 任务(lead/worker 任务均可)。
   * 优先原 assignee(仍在本 channel 且启用),否则选队列最短的空闲 worker;
   * 无可用承接者 → 400 NO_WORKER。重试后经调度循环重新投递执行。
   */
  async retryTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, taskId)
    if (task.state !== 'FAILED') {
      throw new AppError(400, 'INVALID_STATE', `仅 FAILED 任务可重试(当前 ${task.state})`)
    }
    let target = this.deps.repos.channelAgents.findByChannelAgent(channelId, task.assigneeId)
    if (!target || target.enabled !== 1) {
      const receiver = this.pickReceiverWorker(channelId, '')
      if (!receiver) throw new AppError(400, 'NO_WORKER', '无可用 worker 承接重试任务')
      target = this.deps.repos.channelAgents.findByChannelAgent(channelId, receiver)!
    }
    const updated = this.getTaskEngine().reassign(taskId, target.id)
    this.wakeAgent(channelId, target.id)
    return updated
  }

  async listTasks(channelId: string, callerAgentId: string): Promise<WorkspaceTask[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.tasks.listByChannel(channelId).map(rowToTask)
  }

  async getTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    return this.requireTaskInScope(channelId, callerAgentId, taskId)
  }

  /** 自己的任务队列视图(待执行 FIFO / 执行中 / 已完成)——每个 agent 的任务管理系统入口 */
  async myQueue(channelId: string, callerAgentId: string): Promise<AgentTaskQueueView> {
    this.requireMember(channelId, callerAgentId)
    return this.getTaskEngine().queueViewOf(channelId, callerAgentId)
  }

  /** 全员实时状态 + 队列总览(lead 统一调度/最优调配的观察面) */
  async queueOverview(channelId: string, callerAgentId: string): Promise<AgentStatusView[]> {
    this.requireMember(channelId, callerAgentId)
    const cr = this.channels.get(channelId)
    const wired = new Map((cr?.getAgents() ?? []).map(a => [a.agentId, a]))
    return this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.enabled === 1)
      .map((m) => {
        const runtime = wired.get(m.id)
        if (runtime) return runtime.getStatus()
        // 未装配(懒加载)成员:状态按 idle,队列视图仍来自 tasks 表
        const view = this.getTaskEngine().queueViewOf(channelId, m.id)
        return {
          agentId: m.id,
          channelId,
          role: m.role as 'lead' | 'worker',
          name: m.name,
          state: 'idle' as const,
          currentTaskId: view.current?.id ?? null,
          currentTaskTitle: view.current?.title ?? null,
          currentTaskProgress: view.current?.progress != null ? view.current.progress : null,
          queuedCount: view.queued.length,
          completedCount: view.completed.length,
        }
      })
  }

  /** 修改待执行任务(lead 对 worker 队列的"改";仅待执行态可改)+ 唤醒 assignee 消费新投递 */
  async updateTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    patch: { title?: string, description?: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, taskId)
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead' && task.creatorId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead/创建者可修改任务')
    }
    const updated = this.getTaskEngine().updateTask(taskId, patch, callerAgentId)
    this.wakeAgent(channelId, updated.assigneeId)
    return updated
  }

  /** 重新指派(lead 的"调配":待执行/失败任务迁移到其他 worker)+ 唤醒新 assignee */
  async reassignTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    toAgentId: string,
  ): Promise<WorkspaceTask> {
    this.requireTaskInScope(channelId, callerAgentId, taskId) // 校验任务在调用方作用域内
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可调配任务')
    }
    const target = this.resolveMemberRef(channelId, toAgentId)
    const updated = this.getTaskEngine().reassign(taskId, target.id)
    this.wakeAgent(channelId, target.id)
    return updated
  }

  async sendA2A(
    channelId: string,
    callerAgentId: string,
    input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> },
  ): Promise<A2AMessage> {
    this.requireMember(channelId, callerAgentId)
    // 容错寻址:id/模板 id/名字/唯一前缀;失败错误携带当前名册(LLM 自我纠正)
    const target = this.resolveMemberRef(channelId, input.toAgentId)
    const message = buildMessage(channelId, 'ROLE_AGENT', input.parts, {
      ...(input.metadata ?? {}),
      'x-aw-target-agent': target.id,
      'x-aw-from-agent': callerAgentId,
    })
    // 真送达契约:route 回执必须包含目标(落库 enqueue 同步完成),否则向上抛错 ——
    // 消息绝不允许"报告已发送"却没进对方信箱
    const delivered = this.route(channelId, message)
    if (!delivered.includes(target.id)) {
      throw new AppError(502, 'DELIVERY_FAILED', `消息未能投递到 ${target.name} 的信箱(成员装配失败),请重试或改投其他成员`)
    }
    return message
  }

  /**
   * 实时消息(外部/系统注入):priority=immediate → busy 时 steer 注入运行中的 omp 会话。
   * 触发器 requireReply=true → 接收方须回执(执行结果+所需内容,in_reply_to 关联)。
   */
  async sendImmediateMessage(input: {
    channelId: string
    fromAgentId?: string
    toAgentId: string
    parts: Part[]
    requireReply?: boolean
    /** 人类发送者显示名(REST 注入时的时间线归属;进入 x-aw-from-label 元数据) */
    fromLabel?: string
  }): Promise<A2AMessage> {
    // 无主消息拦截:发送方必须可追溯(agent 成员或人类显示名),否则拒绝发送
    const hasFromAgent = !!input.fromAgentId && this.deps.repos.channelAgents.findByChannelAgent(input.channelId, input.fromAgentId) != null
    if (!hasFromAgent && !input.fromLabel) {
      throw new AppError(400, 'NO_SENDER', '消息缺少可追溯发送人(fromAgentId 须为本 channel 成员,或提供 fromLabel 人类显示名)')
    }
    const metadata: Record<string, unknown> = {
      'x-aw-target-agent': input.toAgentId,
      'x-aw-msg-priority': 'immediate',
    }
    if (hasFromAgent) metadata['x-aw-from-agent'] = input.fromAgentId
    if (input.fromLabel) metadata['x-aw-from-label'] = input.fromLabel
    if (input.requireReply) metadata['x-aw-require-reply'] = 'true'
    const message = buildMessage(input.channelId, 'ROLE_AGENT', input.parts, metadata)
    const delivered = this.route(input.channelId, message)
    if (!delivered.includes(input.toAgentId)) {
      throw new AppError(502, 'DELIVERY_FAILED', `消息未能投递到 ${input.toAgentId} 的信箱,请重试`)
    }
    return message
  }

  /**
   * 跨 Channel 点对点通信(仅 lead):把消息直投目标 channel 的 lead mailbox。
   * 沿用既有 mailbox/route 机制(投递/唤醒/消费/回执全复用),仅新增跨 channel 路由:
   *  - 权限:发送方必须是本 channel 启用成员中的 lead(worker/系统拒绝);
   *  - 同主约束:两个 channel 必须属于同一 owner(用户级隔离不破);
   *  - 守卫通行:x-aw-cross-channel 标记由服务端在发送时盖章(REST/工具入参不可伪造),
   *    目标 channel 信箱守卫据此放行非成员发送方的跨 channel 消息;
   *  - 回执:目标 lead 经同一机制回信(其 send_message_to_agent / 本方法均可,
   *    in_reply_to 关联触发实时推送)。
   */
  async sendCrossChannelMessage(
    fromChannelId: string,
    fromAgentId: string,
    input: { toChannelId: string, parts: Part[], requireReply?: boolean, inReplyTo?: string },
  ): Promise<{ messageId: string, toChannelId: string, toChannelName: string, toLeadAgentId: string }> {
    // 权限闸:发送方 = 本 channel 启用成员中的 lead
    const sender = this.deps.repos.channelAgents.findByChannelAgent(fromChannelId, fromAgentId)
    if (!sender || sender.enabled !== 1) {
      throw new AppError(403, 'SCOPE_VIOLATION', '跨 Channel 通信的发送方必须是本 channel 的启用成员')
    }
    if (sender.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', `跨 Channel 通信仅限 Leader 发起(${sender.name} 是 ${sender.role})`)
    }

    // 目标 channel 解析(id 精确 > 名字精确 > 名字唯一包含);禁自指/禁停用/须有 lead
    const needle = input.toChannelId.trim().toLowerCase()
    const rows = this.deps.repos.channels.list()
    const target = rows.find(c => c.id === input.toChannelId)
      ?? rows.find(c => c.name.toLowerCase() === needle)
      ?? (() => {
        const partial = rows.filter(c => c.name.toLowerCase().includes(needle))
        return partial.length === 1 ? partial[0] : undefined
      })()
    if (!target || target.id === fromChannelId) {
      throw new AppError(404, 'CHANNEL_NOT_FOUND', `目标 channel 未命中(且不可为本 channel): ${input.toChannelId}`)
    }
    if (target.enabled !== 1) throw new AppError(400, 'CHANNEL_DISABLED', `目标 channel 已停用: ${target.name}`)
    if (!target.leadAgentId) throw new AppError(400, 'NO_LEAD', `目标 channel 没有 lead,无法接收跨 Channel 消息: ${target.name}`)

    // 同主约束:跨团队协作不越用户边界
    const sourceChannel = this.deps.repos.channels.findById(fromChannelId)
    if (sourceChannel && target.ownerUserId !== null && sourceChannel.ownerUserId !== null
      && sourceChannel.ownerUserId !== target.ownerUserId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '跨 Channel 通信仅限同一用户的 channel 之间')
    }

    // 目标 lead 必须是目标 channel 的启用成员(防悬空 leadAgentId)
    const targetLead = this.deps.repos.channelAgents.findByChannelAgent(target.id, target.leadAgentId)
    if (!targetLead || targetLead.enabled !== 1) {
      throw new AppError(400, 'NO_LEAD', `目标 channel 的 lead 成员缺失或已停用: ${target.name}`)
    }

    const message = buildMessage(target.id, 'ROLE_AGENT', input.parts, {
      'x-aw-target-agent': targetLead.id,
      'x-aw-from-agent': fromAgentId,
      'x-aw-from-channel': fromChannelId,
      'x-aw-cross-channel': 'true',
      'x-aw-from-label': `跨Channel:${sourceChannel?.name ?? fromChannelId} / ${sender.name}`,
      ...(input.requireReply ? { 'x-aw-require-reply': 'true' } : {}),
      // in_reply_to 关联:channel-runtime 将其视为 realtime,回复即时推送对端
      ...(input.inReplyTo ? { 'x-aw-in-reply-to': input.inReplyTo } : {}),
    })
    const delivered = this.route(target.id, message)
    if (!delivered.includes(targetLead.id)) {
      throw new AppError(502, 'DELIVERY_FAILED', `跨 Channel 消息未能投递到「${target.name}」的 lead 信箱,请重试`)
    }
    return {
      messageId: message.messageId,
      toChannelId: target.id,
      toChannelName: target.name,
      toLeadAgentId: targetLead.id,
    }
  }

  /**
   * 跨团队可见性(仅 lead):其他 channel 的场景任务概览(同主、启用)。
   * 协同工作流的第一步——先看别的团队在做什么/做过什么,再决定是否发信请求协作。
   */
  listOtherTeamsOverview(channelId: string, agentId: string): Array<{
    channelId: string
    name: string
    description: string
    leadName: string | null
    activeTasks: Array<{ id: string, title: string, state: string }>
    recentCompleted: Array<{ title: string }>
  }> {
    this.requireMember(channelId, agentId)
    const sender = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!sender || sender.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', `团队任务概览仅限 Leader(${sender?.name ?? agentId} 是 ${sender?.role ?? '非成员'})`)
    }
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED'])
    return this.otherSameOwnerChannels(channelId).map((c) => {
      const tasks = this.deps.repos.tasks.listByChannel(c.id)
      const leadRow = c.leadAgentId ? this.deps.repos.channelAgents.findById(c.leadAgentId) : undefined
      return {
        channelId: c.id,
        name: c.name,
        description: c.description ?? '',
        leadName: leadRow?.name ?? null,
        /** 团队共享域知识量:>0 说明该队有可检索的作业结论(search_other_teams_memory) */
        sharedMemories: this.deps.repos.memories.countTeamShared(c.id),
        activeTasks: tasks
          .filter(t => !terminal.has(t.state))
          .map(t => ({ id: t.id, title: t.title, state: t.state })),
        recentCompleted: tasks
          .filter(t => t.state === 'COMPLETED')
          .slice(0, 3)
          .map(t => ({ title: t.title })),
      }
    })
  }

  /**
   * 跨团队共享记忆检索(lead/worker 皆可,只读):其他 channel 的 __team__ 公共域。
   * 全员可见——worker 由此知道别的团队做过什么;发现相关经验/结论可直接复用,
   * 无需跨 channel 发信;查无所得而有协作必要时,再由 lead 发起跨 channel 通信。
   */
  recallOtherTeamsMemory(channelId: string, agentId: string, input: { query: string, limit?: number }): Array<{
    channelId: string
    channelName: string
    title: string
    content: string
    importance: number
    createdAt: string
  }> {
    this.requireMember(channelId, agentId)
    const q = input.query.trim()
    if (!q) return []
    const others = this.otherSameOwnerChannels(channelId)
    if (others.length === 0) return []
    const matchQuery = segmentCJK(q).split(/\s+/).filter(Boolean).join(' OR ')
    const rows = this.deps.repos.memories.searchTeamSharedAcross(
      matchQuery,
      others.map(c => c.id),
      Math.min(Math.max(input.limit ?? 5, 1), 20),
    )
    // 触摸命中行(access_count/last_accessed_at):与 recallRows 同信号,强化后续召回排序
    for (const r of rows) this.deps.repos.memories.touch(r.id)
    return rows.map(r => ({
      channelId: r.channelId,
      channelName: others.find(c => c.id === r.channelId)?.name ?? r.channelId,
      title: r.title,
      content: unsegmentCJK(r.content).slice(0, 400),
      importance: r.importance,
      createdAt: r.createdAt,
    }))
  }

  /** 同主且启用的其他 channel 列表(跨团队可见性的作用域) */
  private otherSameOwnerChannels(channelId: string): ChannelRow[] {
    const self = this.deps.repos.channels.findById(channelId)
    return this.deps.repos.channels.list().filter(c =>
      c.id !== channelId
      && c.enabled === 1
      && (self?.ownerUserId == null || c.ownerUserId == null || c.ownerUserId === self.ownerUserId))
  }

  /**
   * 工具桥(协作工具族):按 agentId 定位 channel 并调用其 workspace 方法。
   * 与工业工具桥同一服务层,供 REST 直调(测试/运维/控制台)。
   */
  invokeAgentWorkspaceTool(agentId: string, tool: string, args: Record<string, unknown> = {}): { text: string, isError?: boolean } {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${agentId}`)
    const ws = this.ensureAgentRuntime(row.channelId, agentId)?.workspace
    if (!ws) throw new AppError(400, 'AGENT_NOT_READY', `agent 运行时未装配: ${agentId}`)
    switch (tool) {
      case 'list_other_teams': {
        const teams = ws.listOtherTeams()
        if (teams.length === 0) return { text: '当前没有其他团队(或均未启用)。' }
        const text = teams.map((t) => {
          const active = t.activeTasks.length > 0
            ? t.activeTasks.map(x => `「${x.title}」(${x.state})`).join('、')
            : '无进行中任务'
          const done = t.recentCompleted.length > 0
            ? t.recentCompleted.map(x => `「${x.title}」`).join('、')
            : '无'
          const mem = t.sharedMemories > 0 ? `共享记忆 ${t.sharedMemories} 条(可检索)` : '暂无共享记忆'
          return `- ${t.name}${t.description ? `(${t.description})` : ''} · lead=${t.leadName ?? '?'} · ${mem}\n  进行中: ${active}\n  近期完成: ${done}\n  channel_id: ${t.channelId}`
        }).join('\n')
        return { text: `其他团队概览:\n${text}\n(需要协作时用 send_cross_channel_message 向对应团队 Leader 发信;查具体知识用 search_other_teams_memory)` }
      }
      case 'search_other_teams_memory': {
        const query = String(args.query ?? '')
        if (!query) return { text: '缺少 query', isError: true }
        const rows = ws.searchOtherTeamsMemory({ query, limit: Number(args.limit ?? 5) })
        if (rows.length === 0) return { text: `其他团队的共享记忆中没有命中「${query}」的内容。` }
        const text = rows.map(r =>
          `- [${r.channelName}] 「${r.title}」(${r.createdAt.slice(0, 10)}): ${r.content}`).join('\n')
        return { text: `其他团队共享记忆命中 ${rows.length} 条:\n${text}` }
      }
      case 'send_cross_channel_message': {
        if (!args.to_channel_id || !args.message) return { text: '缺少 to_channel_id 或 message', isError: true }
        const r = ws.sendCrossChannelMessage({
          toChannelId: String(args.to_channel_id),
          parts: [{ text: String(args.message) }],
          requireReply: args.require_reply === true,
          inReplyTo: typeof args.in_reply_to === 'string' ? args.in_reply_to : undefined,
        })
        return { text: `跨 Channel 消息已送达「${r.toChannelName}」的 Leader(channel=${r.toChannelId}, lead=${r.toLeadAgentId.slice(0, 8)}),消息 id=${r.messageId.slice(0, 8)}。` }
      }
      default:
        throw new AppError(400, 'BAD_REQUEST', `工具桥不支持该协作工具: ${tool}`)
    }
  }

  /**
   * harness 无关全量工具直调(agent token 鉴权;stdio MCP 桥回程的唯一入口)。
   * impl.dispatchHostTool(全引擎共享 host-tool-bridge)优先;未实现回退协作工具族。
   */
  async invokeHostTool(input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }): Promise<{ text: string, isError?: boolean }> {
    const row = this.deps.repos.channelAgents.findById(input.agentId)
    if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${input.agentId}`)
    // token 鉴权(MCP 桥路径必带;缺省视为服务端内部调用,走 REST 已有用户鉴权)
    if (input.token !== undefined && input.token !== row.token) {
      throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败')
    }
    const runtime = this.ensureAgentRuntime(row.channelId, input.agentId)
    if (runtime) {
      const viaImpl = await runtime.dispatchHostTool(input.tool, input.args ?? {})
      if (viaImpl) return viaImpl
    }
    // 回退:impl 未实现工具面(如 mock)→ 协作工具族直调
    return this.invokeAgentWorkspaceTool(input.agentId, input.tool, input.args ?? {})
  }

  /** 按 token 解析 agent(桥侧只需 token 的自证路径;未命中返回 null) */
  resolveAgentByToken(token: string): { agentId: string, channelId: string } | null {
    if (!token) return null
    const row = this.deps.repos.channelAgents.findByToken(token)
    if (!row || row.enabled !== 1) return null
    return { agentId: row.id, channelId: row.channelId }
  }

  /** 工具面 schema(MCP 桥 tools/list):按 agent 角色装配,与 omp 注入面同源 */
  hostToolDefsFor(agentId: string): Array<{ name: string, label?: string, description: string, parameters: Record<string, unknown> }> {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
    return hostToolsForRole(row.role === 'lead' ? 'lead' : 'worker')
  }

  /**
   * HITL 应答传导(codex/opencode/dsh 审批;omp-dialog 走 terminal 通道不经此)。
   * 找不到运行时或 impl 未实现 → 409(条目不可应答)。
   */
  async respondHarnessHitl(agentId: string, kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
    const runtime = this.ensureAgentRuntime(row.channelId, agentId)
    if (!runtime) throw new AppError(409, 'NOT_RESPONDABLE', 'agent 运行时未装配,无法应答')
    const ok = await runtime.respondHitl(kind, id, outcome)
    if (!ok) throw new AppError(409, 'NOT_RESPONDABLE', '该 harness 不支持程序化应答')
  }

  /** 阻塞长轮询(poll_messages):到信即时唤醒,250ms 兜底重查 */
  async waitMailbox(channelId: string, callerAgentId: string, limit: number, waitMs: number): Promise<A2AMessage[]> {
    this.requireMember(channelId, callerAgentId)
    const runtime = this.ensureAgentRuntime(channelId, callerAgentId)
    if (runtime) return runtime.waitPending(limit, waitMs)
    // 运行时未装配(极端时序):退化为一次性快照查询
    return this.pollMailbox(channelId, callerAgentId, limit)
  }

  async pollMailbox(channelId: string, callerAgentId: string, limit = 100): Promise<A2AMessage[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.messages
      .listPendingByChannelAgent(channelId, callerAgentId)
      .slice(0, limit)
      .map(rowToMessage)
  }

  /** 确认消费自己 mailbox 的协作消息(读即取;id 须属于 caller 的 pending 集) */
  ackMailbox(channelId: string, callerAgentId: string, messageIds: string[]): void {
    this.requireMember(channelId, callerAgentId)
    const pending = new Set(
      this.deps.repos.messages
        .listPendingByChannelAgent(channelId, callerAgentId)
        .map(r => r.id),
    )
    for (const id of messageIds) {
      // claim 守卫:与 steer 注入原子竞争(peek 与 ack 之间消息可能被认领),
      // 认领成功才标记消费——失败说明 steer 已注入运行中会话,不再重复投递
      if (pending.has(id) && this.deps.repos.messages.claim(id)) {
        this.deps.repos.messages.markConsumed(id)
      }
    }
  }

  /**
   * (仅 lead)Channel 邮件全览:全部 agent 间消息(含已消费/任务投递),按时间倒序。
   * lead 调度观察面——worker 间的点对点通信(含结果回执)对 lead 可见,
   * 供派发前判断"该结果是否已由某 worker 经 mail 产出",避免重复派发浪费资源。
   * 可选 agentId 过滤参与方(from 或 to)。
   */
  async listChannelMail(
    channelId: string,
    callerAgentId: string,
    opts: { limit?: number, agentId?: string } = {},
  ): Promise<ChannelMail[]> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可查看 Channel 全部邮件')
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200))
    const mails = this.deps.repos.messages
      .listRecentByChannel(channelId, limit)
      .map(rowToChannelMail)
    if (opts.agentId) {
      return mails.filter(m => m.fromAgentId === opts.agentId || m.toAgentId === opts.agentId)
    }
    return mails
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
    const activeChannelIds = new Set(nonTerminal.map(t => t.channelId))
    for (const channelId of activeChannelIds) {
      const channel = this.deps.repos.channels.findById(channelId)
      if (!channel || channel.enabled !== 1) continue
      this.ensureChannelActive(channelId)
    }
    // 断线重连:ASSIGNED/WORKING 的叶子任务(无子任务)若无 pending assign 投递
    // (消息已被消费但任务未完成——进程内 run 抛错、或崩溃落在消费后),
    // 无人会重新驱动它(调度循环只 dispatch lead 名下任务;停滞检测要 stallMs×2 才 cancel)。
    // 重投 assign + 唤醒 assignee,由 processMessage 的终态检查保证幂等(执行从头重放)。
    // 父任务(WAITING/有子任务)不重投:由调度循环按子任务进度汇总推进。
    // 父任务集合按 channel 全量任务计算(含已完成子任务):
    // 「子任务全部完成、父任务 WAITING 待汇总」的父任务不能误判为叶子而重投。
    const parentIds = new Set<string>()
    for (const channelId of activeChannelIds) {
      for (const t of this.deps.repos.tasks.listByChannel(channelId)) {
        if (t.parentId) parentIds.add(t.parentId)
      }
    }
    for (const task of nonTerminal) {
      if (task.state !== 'ASSIGNED' && task.state !== 'WORKING') continue
      if (parentIds.has(task.id)) continue
      if (this.deps.repos.messages.hasPendingAssign(task.id)) continue
      this.getTaskEngine().redeliverAssign(task.id)
    }
    // 唤醒有未消费消息的 agent:重启前 consuming 的 assign 消息已被 resetConsuming 重投为 pending,
    // 若无人唤醒,worker 的运行时(懒加载)不会装配,重投消息滞留 pending,任务永远无法恢复。
    // 任务状态保持原样(不重置为 ASSIGNED):调度循环按 SUBMITTED/WORKING 重新驱动 lead 任务,
    // worker 经消息重放从 ASSIGNED/WORKING 恢复执行;WAITING 父任务等子任务完成后正常汇总。
    for (const { channelId, toAgentId } of this.deps.repos.messages.listPendingTargets()) {
      this.wakeAgent(channelId, toAgentId)
    }
  }

  // ===== 内部辅助 =====

  private route(channelId: string, message: A2AMessage): string[] {
    // 总线通知(a2a.message)由 ChannelRuntime 构造时注入的 onRouted 回调统一发出
    // (见 ensureChannelRuntime):调度器直呼 runtime.route 的消息同样可见
    return this.ensureChannelRuntime(channelId).route(message)
  }

  private wakeAgent(channelId: string, agentId: string): void {
    this.ensureAgentRuntime(channelId, agentId)?.wakeMailbox()
  }

  /**
   * 成员寻址(A2A 身份命中率的核心):接受 id(实例/模板)、名字、唯一名字前缀。
   * 多智能体对话中 LLM 常以名字称呼同事,名册缓存也可能滞后于成员重建 ——
   * 精确 id 未命中时按名字/前缀解析,让"想发给谁"总能落到"谁"的实例上;
   * 解析失败时把当前名册(id | 名字)放进错误信息,LLM 下一轮即可自我纠正。
   */
  private resolveMemberRef(channelId: string, ref: string): ChannelAgentRow {
    const trimmed = ref.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', '缺少目标成员引用(to_agent_id/assignee_id)')
    const members = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.enabled === 1)
    // ① 精确实例 id
    const byId = members.find(m => m.id === trimmed)
    if (byId) return byId
    // ② 模板 id(名册/记忆中的旧实例 id 复用同一模板 → 按模板命中当前实例)
    const byTemplate = members.find(m => m.templateId === trimmed)
    if (byTemplate) return byTemplate
    // ③ 名字精确(大小写不敏感;含"← 你"等标记已剥离)
    const lower = trimmed.toLowerCase()
    const byName = members.find(m => m.name.toLowerCase() === lower)
    if (byName) return byName
    // ④ 唯一名字前缀/包含(多候选 → 拒绝,防止误投)
    const partial = members.filter(m => m.name.toLowerCase().includes(lower))
    if (partial.length === 1) return partial[0]!
    const roster = members.map(m => `${m.id} | ${m.name}(${m.role})`).join('; ')
    throw new AppError(404, 'MEMBER_NOT_FOUND',
      `目标成员未命中: "${trimmed}"。当前 Channel 名册(用其中 id 或名字寻址): ${roster}`)
  }

  /** 成员寻址(公开包装:REST/工具桥共用;语义同 resolveMemberRef) */
  resolveChannelMember(channelId: string, ref: string): { id: string, name: string, role: string } {
    const m = this.resolveMemberRef(channelId, ref)
    return { id: m.id, name: m.name, role: m.role }
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
