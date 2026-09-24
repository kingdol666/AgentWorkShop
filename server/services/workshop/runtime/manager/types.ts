/**
 * Manager 的依赖类型与对外 DTO(原 manager.ts 顶部模块级类型声明)。纯类型,无运行时代码。
 * 由 index.ts 原样再导出,外部 `from ".../runtime/manager"` 的 import 路径不变。
 */
import type { AgentInfo, AgentInterface } from '../../agents/agent-interface'
import type { AgentRepo } from '../../db/agent.repo'
import type { ChannelAgentRepo } from '../../db/channel-agent.repo'
import type { ChannelEventRepo } from '../../db/channel-event.repo'
import type { ChannelMemberRepo } from '../../db/channel-member.repo'
import type { ChannelRepo } from '../../db/channel.repo'
import type { ChannelTemplateMember, ChannelTemplateRepo } from '../../db/channel-template.repo'
import type { ChatMessageRepo } from '../../db/chat-message.repo'
import type { DatabaseSync } from 'node:sqlite'
import type { HitlRequestRepo } from '../../db/hitl-request.repo'
import type { MemoryRepo } from '../../db/memory.repo'
import type { MessageRepo } from '../../db/message.repo'
import type { NotificationRepo } from '../../db/notification.repo'
import type { OutboxRepo } from '../../db/outbox.repo'
import type { ScheduledTaskRepo } from '../../db/scheduled-task.repo'
import type { SubscriptionRepo } from '../../db/subscription.repo'
import type { TaskEngine } from '../agent-runtime'
import type { HarnessContinuityView, SupervisionAttemptView } from '../../types/task'
import type { TaskRepo } from '../../db/task.repo'
import type { TeamMemberRepo } from '../../db/team-member.repo'
import type { TeamRepo } from '../../db/team.repo'
import type { UserRepo } from '../../db/user.repo'

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
  /** v16 定时任务(旧测试脚本构造的 repos 缺省该成员;相关路径已做守卫) */
  schedules: ScheduledTaskRepo
  /** v17 群成员(旧测试脚手架缺省时由 withGroupChatRepos 补齐) */
  channelMembers?: ChannelMemberRepo
  /** v17 群聊事实表 + 投递台账 */
  chatMessages?: ChatMessageRepo
  /** v17 用户级通知 */
  notifications?: NotificationRepo
  /** v17 事务内待发布事件 */
  outbox?: OutboxRepo
  /** v17 HITL 持久化事实源 */
  hitlRequests?: HitlRequestRepo
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
  /** 监督尝试状态(§2.3;watchdog/最后决策的可观测面) */
  supervision?: SupervisionAttemptView
  /** Harness 连续性租约(§2.4;continuity mode / pid / session / reuse / 重启原因) */
  continuity?: HarnessContinuityView
  /** 本 channel 的根任务队列深度(§11 root_queue_depth) */
  rootQueueDepth?: number
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
  /** §11 AgentTeam 观测指标(缺省 = 旧调用方/测试脚手架未提供) */
  agentTeam?: {
    rootQueueDepth: number
    queuedRoots: number
    activeRoots: number
    maxRootWaitMs: number
    supervisionWatchdogCount: number
    supervisionAttemptAgeMs: number
    harnessReuseCount: number
    harnessRestartCountByReason: Record<string, number>
    activeExecutionLeases: number
    memoryOutboxPending: number
    memoryOutboxFailed: number
    memoryOutboxPublished: number
  }
}

/** 定时计划视图(附 channel 名与忙等实况;前端列表呈现) */
export interface ScheduleView {
  id: string
  channelId: string
  channelName: string
  name: string
  title: string
  description: string
  mode: 'interval' | 'daily'
  intervalMs: number
  dailyTime: string
  enabled: number
  /** idle|waiting|running|disabled|failed */
  state: string
  lastRunAt: string | null
  nextRunAt: string | null
  lastTaskId: string | null
  runCount: number
  failCount: number
  consecutiveFailures: number
  maxConsecutiveFailures: number
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}
