/**
 * Workshop API 类型化封装(P0 面:channels/agents/tasks/messages/memories/queue/runtime)。
 * 统一走 $http(Bearer cookie 注入 + envelope 解包);错误由拦截器统一 toast。
 */
import type { AepChannelChatSettings, AepChannelMember, AepChatMention, AepChatMessage, AepNotification, AepSnapshot } from '#shared/workshop-protocol'

export interface ChannelDto {
  id: string
  name: string
  description?: string
  /** channel 级默认 LLM JSON(透传 llmJson;前端解析) */
  llmJson?: string
  /** channel 级作业场景 prompt(设置弹窗可编辑) */
  scenarioPrompt?: string
  leadAgentId: string | null
  workspace?: string
  enabled: number
  /** 归属用户(null = 遗留公共) */
  ownerUserId?: string | null
  /** v16 定时标志:该 channel 启用的定时计划数(>0 前端显示「定时」标签) */
  scheduledCount?: number
  createdAt: string
  updatedAt: string
}

export interface AgentInfoDto {
  id: string
  channelId: string
  name: string
  harness: string
  role: 'lead' | 'worker'
  config: Record<string, unknown>
  token?: string
  /** 实例启停(1 启用 / 0 禁用) */
  enabled?: number
}

/** harness 注册表元信息(GET /workshop/harnesses;含环境可用性探测结果) */
export interface HarnessMetaDto {
  id: string
  label: string
  description: string
  /** 官网/安装入口(未安装态跳转) */
  homepage?: string
  capabilities: {
    steer: boolean
    supervise: boolean
    hitl: boolean
    terminal: boolean
    contextStats: boolean
    compact: boolean
  }
  /** 环境探测:引擎可立即使用(进程内引擎恒 true;进程型引擎 = CLI 在 PATH 中) */
  available?: boolean
  /** 进程内引擎(无外部 CLI) */
  inprocess?: boolean
  /** 进程型引擎声明将拉起的命令 */
  command?: string | null
  /** PATH 解析出的可执行文件绝对路径 */
  resolvedPath?: string | null
  /** 不可用原因(available=false 时的人话提示) */
  error?: string | null
}

export interface TaskDto {
  id: string
  channelId: string
  parentId?: string
  assigneeId: string
  title: string
  description?: string
  state: string
  progress: number
  /** 派发路由理由(lead 留痕的审计决策) */
  routeReason?: string
  artifacts: Array<{ artifactId: string, name?: string, parts: Array<{ text?: string }> }>
  createdAt: string
  updatedAt: string
}

export interface MemoryRowDto {
  id: string
  channelId: string
  agentId: string
  kind: string
  title: string
  content: string
  importance: number
  accessCount: number
  createdAt: string
}

export interface MemorySnippetDto {
  id: string
  kind: string
  title: string
  content: string
  importance: number
  createdAt: string
  score: number
  source: 'private' | 'shared'
}

export function useWorkshopApi() {
  const http = useHttp()

  return {
    // channels
    listChannels: () => http.get<{ data: ChannelDto[] }>('/workshop/channels'),
    createChannel: (body: { name: string, description?: string, scenarioPrompt?: string, workspace?: string, leadAgent?: { name: string, harness: string, config?: Record<string, unknown> } }) =>
      http.post<{ data: { channelId: string, leadAgentId?: string, workspace: string } }>('/workshop/channels', body),
    deleteChannel: (id: string) => http.delete<{ data: unknown }>(`/workshop/channels/${id}`),
    /** 修改 Channel 实例设置(场景 prompt / 工作目录热更新;成员运行时自动回收重装配) */
    patchChannel: (id: string, body: { name?: string, description?: string, scenarioPrompt?: string, workspace?: string, enabled?: number, llm?: { provider?: string, model?: string, effort?: string } | null }) =>
      http.request<{ data: ChannelDto }>({ method: 'PATCH', url: `/workshop/channels/${id}`, data: body }),
    // channel agents
    listChannelAgents: (id: string) => http.get<{ data: AgentInfoDto[] }>(`/workshop/channels/${id}/agents`),
    addChannelAgent: (id: string, body: { agentId?: string, name?: string, harness?: string, role?: 'lead' | 'worker', config?: Record<string, unknown> }) =>
      http.post<{ data: AgentInfoDto }>(`/workshop/channels/${id}/agents`, body),
    updateChannelAgent: (id: string, agentId: string, body: { name?: string, config?: Record<string, unknown>, enabled?: 0 | 1, reason?: string }) =>
      http.request<{ data: { agentId: string, name: string } }>({ method: 'PATCH', url: `/workshop/channels/${id}/agents/${agentId}`, data: body }),
    removeChannelAgent: (id: string, agentId: string) => http.delete<{ data: unknown }>(`/workshop/channels/${id}/agents/${agentId}`),
    /** HITL:独立中断指定成员运行时(worker/lead 均可;lead 停止同时停调度,下次任务提交自动重激活) */
    stopChannelAgent: (id: string, agentId: string) =>
      http.post<{ data: { agentId: string, stopped: boolean } }>(`/workshop/channels/${id}/agents/${agentId}/stop`, {}),
    // tasks
    listTasks: (id: string) => http.get<{ data: TaskDto[] }>(`/workshop/channels/${id}/tasks`),
    submitTask: (id: string, body: { title: string, description?: string, mode?: 'goal' | 'loop' | 'pipeline', modeConfig?: Record<string, unknown>, assigneeId?: string, fromLabel?: string, parts?: Array<{ text: string }> }) =>
      http.post<{ data: TaskDto }>(`/workshop/channels/${id}/tasks`, body),
    // messages(注入即时消息/队列消息;fromLabel = 人类发送者显示名)
    injectMessage: (id: string, body: { toAgentId: string, text: string, priority?: 'immediate' | 'task', requireReply?: boolean, fromLabel?: string }) =>
      http.post<{ data: unknown }>(`/workshop/channels/${id}/messages`, body),
    // memories
    listAgentMemories: (id: string, agentId: string) => http.get<{ data: MemoryRowDto[] }>(`/workshop/channels/${id}/agents/${agentId}/memories`),
    searchMemories: (id: string, agentId: string, body: { query: string, scope?: 'auto' | 'private' | 'shared', limit?: number }) =>
      http.post<{ data: MemorySnippetDto[] }>(`/workshop/channels/${id}/agents/${agentId}/memories/search`, body),
    saveMemory: (id: string, agentId: string, body: { title: string, content: string, importance?: number, dedupKey?: string, scope?: 'private' | 'shared' }) =>
      http.post<{ data: unknown }>(`/workshop/channels/${id}/agents/${agentId}/memories`, body),
    listTeamMemories: (id: string) => http.get<{ data: MemoryRowDto[] }>(`/workshop/channels/${id}/memories`),
    // queue / runtime
    queueOverview: (id: string) => http.get<{ data: Array<{ agentId: string, name: string, state: string, currentTaskId: string | null, queuedCount: number, completedCount: number }> }>(`/workshop/channels/${id}/queue`),
    runtimeStatus: () => http.get<{ data: { wiredAgents: string[], activeChannels: string[] } }>('/workshop/runtime'),
    // 定时任务(v16:绑定 Channel 的周期任务;interval 固定间隔 / daily 每日定点)
    listSchedules: () => http.get<{ data: ScheduleDto[] }>('/workshop/schedules'),
    createSchedule: (body: { channelId: string, name: string, title: string, description?: string, mode: 'interval' | 'daily', intervalMs?: number, dailyTime?: string, maxConsecutiveFailures?: number }) =>
      http.post<{ data: ScheduleDto }>('/workshop/schedules', body),
    updateSchedule: (id: string, body: { name?: string, title?: string, description?: string, mode?: 'interval' | 'daily', intervalMs?: number, dailyTime?: string, enabled?: 0 | 1, maxConsecutiveFailures?: number }) =>
      http.request<{ data: ScheduleDto }>({ method: 'PATCH', url: `/workshop/schedules/${id}`, data: body }),
    deleteSchedule: (id: string) => http.delete<{ data: unknown }>(`/workshop/schedules/${id}`),
    /** 手动立即执行(与 timer 同路径;Channel 忙 → 409) */
    runSchedule: (id: string) => http.post<{ data: { runId: string, taskId?: string } }>(`/workshop/schedules/${id}/run`, {}),
    listScheduleRuns: (id: string, limit = 50) => http.get<{ data: ScheduleRunDto[] }>(`/workshop/schedules/${id}/runs`, { params: { limit } }),
    /** harness 注册表(引擎下拉/能力徽标;与 factory/manager 校验同源) */
    listHarnesses: () => http.get<{ data: { harnesses: HarnessMetaDto[] } }>('/workshop/harnesses'),
    /** harness 已配置的 LLM provider/model 目录(引擎官方目录面,5 分钟缓存) */
    listHarnessProviders: (harness: string) =>
      http.get<{ data: { catalog: { providers: Array<{ id: string, models: Array<{ id: string, efforts: string[], defaultEffort?: string }> }>, effortMode: 'levels' | 'freetext' | 'unsupported', note?: string } } }>(`/workshop/harnesses/${harness}/providers`),
    // tasks detail / lifecycle(P1 抽屉)
    getTask: (taskId: string) => http.get<{ data: TaskDto }>(`/workshop/tasks/${taskId}`),
    cancelTask: (taskId: string) => http.post<{ data: TaskDto }>(`/workshop/tasks/${taskId}/cancel`, {}),
    /** HITL:重试 FAILED 任务(优先原 assignee,否则队列最短空闲 worker) */
    retryTask: (taskId: string) => http.post<{ data: TaskDto }>(`/workshop/tasks/${taskId}/retry`, {}),
    /** HITL:统一应答路由(omp-dialog/dcw-approval/codex-approval/opencode-permission/dsh-permission) */
    respondHitl: (body: { kind: string, id: string, confirmed?: boolean, cancelled?: boolean, value?: string, response?: string, comment?: string }) =>
      http.post<{ data: { ok: boolean, kind: string, id: string } }>('/workshop/hitl/respond', body),
    // ===== v17 群聊 / 成员 / 用户通知(主计划 §5)=====
    /** 群聊历史(新→旧;before = 上一页最旧消息 id 作为游标) */
    listChatMessages: (id: string, opts: { before?: string, limit?: number } = {}) =>
      http.get<{ data: { channelId: string, messages: AepChatMessage[], nextCursor: string | null, permissions: ChatPermissionsDto | null } }>(
        `/workshop/channels/${id}/chat/messages`,
        { before: opts.before, limit: opts.limit ?? 50 },
      ),
    /**
     * 群聊发言(唯一入站口)。mentions 只是意图提示:服务端会重新解析文本并逐个校验归属,
     * 未命中归属的目标记入 unresolvedMentions(不投递、不报错)。
     */
    sendChatMessage: (id: string, body: { text: string, mentions?: AepChatMention[], replyToId?: string | null, clientMessageId?: string }) =>
      http.post<{ data: ChatSendResultDto }>(`/workshop/channels/${id}/chat/messages`, body),
    /** 打开群聊即把该频道内我的定向通知收敛为已读 */
    markChatMessageRead: (id: string, messageId: string) =>
      http.post<{ data: { ok: boolean, channelId: string, messageId: string, count: number } }>(
        `/workshop/channels/${id}/chat/messages/${messageId}/read`,
        {},
      ),
    /** 能力视图(非成员也可调用:canJoin 等公开信息;按钮可用性唯一事实源) */
    getChatPermissions: (id: string) =>
      http.get<{ data: { channelId: string, channel: AepChannelChatSettings | null, permissions: ChatPermissionsDto | null } }>(
        `/workshop/channels/${id}/chat/permissions`,
      ),
    listChannelMembers: (id: string) =>
      http.get<{ data: { channelId: string, members: AepChannelMember[], permissions: ChatPermissionsDto | null } }>(
        `/workshop/channels/${id}/members`,
      ),
    joinChannel: (id: string) =>
      http.post<{ data: { channelId: string, status: 'active' | 'pending', generation: number, permissions: ChatPermissionsDto | null } }>(
        `/workshop/channels/${id}/members/join`,
        {},
      ),
    leaveChannel: (id: string) =>
      http.post<{ data: { ok: boolean, status: string } }>(`/workshop/channels/${id}/members/leave`, {}),
    /** owner-only:移除成员(owner 自身不可移除,服务端 409 OWNER_CANNOT_REMOVE) */
    removeChannelMember: (id: string, userId: string) =>
      http.delete<{ data: { ok: boolean, status: string } }>(`/workshop/channels/${id}/members/${encodeURIComponent(userId)}`),
    /** owner-only:批准 pending 成员 */
    approveChannelMember: (id: string, userId: string) =>
      http.post<{ data: { ok: boolean, member: { userId: string, role: string, status: string } } }>(
        `/workshop/channels/${id}/members/${encodeURIComponent(userId)}/approve`,
        {},
      ),
    /** 群聊设置(owner-only;version 乐观锁 → 409 VERSION_CONFLICT 需刷新后重试) */
    patchChannelChatSettings: (id: string, body: { visibility?: 'private' | 'public', joinPolicy?: 'open' | 'owner_approve', approvalPolicy?: 'owner_only' | 'any_member', chatEnabled?: 0 | 1, version?: number }) =>
      http.request<{ data: ChannelChatSettingsRowDto }>({ method: 'PATCH', url: `/workshop/channels/${id}`, data: body }),
    /** 本人用户通知(事实源;cursor = `${createdAt}|${id}` 时返回其后升序通知) */
    listNotifications: (opts: { limit?: number, unreadOnly?: boolean, cursor?: string } = {}) =>
      http.get<{ data: NotificationPageDto }>('/workshop/notifications', {
        limit: opts.limit ?? 50,
        unreadOnly: opts.unreadOnly ? 1 : undefined,
        cursor: opts.cursor,
      }),
    markNotificationsRead: (body: { id?: string, channelId?: string, all?: boolean }) =>
      http.post<{ data: { ok: boolean, count: number, unreadCount: number } }>('/workshop/notifications/read', body),
    // agent 模板库(P1;v10 用户隔离:private 仅本人,public 全员可用,内置只读)
    listTemplates: () => http.get<{ data: AgentTemplateDto[] }>('/workshop/agents'),
    createTemplate: (body: { name: string, harness: string, config?: Record<string, unknown>, visibility?: 'private' | 'public' }) =>
      http.post<{ data: AgentTemplateDto }>('/workshop/agents', body),
    updateTemplate: (id: string, body: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, visibility?: 'private' | 'public' }) =>
      http.request<{ data: AgentTemplateDto }>({ method: 'PATCH', url: `/workshop/agents/${id}`, data: body }),
    deleteTemplate: (id: string) => http.delete<{ data: unknown }>(`/workshop/agents/${id}`),
    // teams(P1 编组库;v10 可见性)
    listTeams: () => http.get<{ data: TeamDto[] }>('/workshop/teams'),
    createTeam: (body: { name: string, description?: string, visibility?: 'private' | 'public', plugins?: Array<{ name: string, enabled: boolean }> }) => http.post<{ data: TeamDto }>('/workshop/teams', body),
    updateTeam: (id: string, body: { name?: string, description?: string, visibility?: 'private' | 'public' }) =>
      http.request<{ data: TeamDto }>({ method: 'PATCH', url: `/workshop/teams/${id}`, data: body }),
    deleteTeam: (id: string) => http.delete<{ data: unknown }>(`/workshop/teams/${id}`),
    addTeamMember: (id: string, body: { agentId: string, role?: 'lead' | 'worker' }) =>
      http.post<{ data: TeamDto }>(`/workshop/teams/${id}/members`, body),
    removeTeamMember: (id: string, templateId: string) => http.delete<{ data: TeamDto }>(`/workshop/teams/${id}/members/${templateId}`),
    deployTeam: (teamId: string, channelId: string) => http.post<{ data: unknown }>(`/workshop/teams/${teamId}/deploy`, { channelId }),
    // channel 模板库(v10:场景 + 工作目录 + 成员组合;实例化一键建 channel)
    listChannelTemplates: () => http.get<{ data: ChannelTemplateDto[] }>('/workshop/channel-templates'),
    createChannelTemplate: (body: { name: string, description?: string, scenarioPrompt?: string, workspace?: string, lead?: ChannelTemplateDto['lead'], members?: ChannelTemplateMemberDto[], visibility?: 'private' | 'public' }) =>
      http.post<{ data: ChannelTemplateDto }>('/workshop/channel-templates', body),
    captureChannelTemplate: (body: { channelId: string, name: string, description?: string, visibility?: 'private' | 'public' }) =>
      http.post<{ data: ChannelTemplateDto }>('/workshop/channel-templates/from-channel', body),
    updateChannelTemplate: (id: string, body: { name?: string, description?: string, scenarioPrompt?: string, workspace?: string, visibility?: 'private' | 'public' }) =>
      http.request<{ data: ChannelTemplateDto }>({ method: 'PATCH', url: `/workshop/channel-templates/${id}`, data: body }),
    deleteChannelTemplate: (id: string) => http.delete<{ data: unknown }>(`/workshop/channel-templates/${id}`),
    instantiateChannelTemplate: (id: string, name?: string) =>
      http.post<{ data: { channelId: string, workspace: string, agentCount: number, leadAgentId?: string } }>(`/workshop/channel-templates/${id}/instantiate`, { name }),
    /** 从 Channel 模板实例化并挂载到 workspace(替代"挂载已有 Channel") */
    mountChannelTemplate: (wsId: string, tplId: string, name?: string) =>
      http.post<{ data: { channelId: string, workspace: string, agentCount: number, leadAgentId?: string } }>(`/workshop/workspaces/${wsId}/channel-templates/${tplId}`, { name }),
    // channel 成员的 harness 终端会话(rpc-ui 镜像;lanes 控制面板数据源)
    listChannelTerminals: (id: string) => http.get<{ data: TerminalSessionDto[] }>(`/workshop/channels/${id}/terminals`),
    // plugins(插件管理:清单为顶层 plugins key,非信封;启停 admin + 热重载;健康走插件自注册 /health)
    listPlugins: () => http.get<{ plugins?: WorkshopPluginDto[], data?: { plugins?: WorkshopPluginDto[] } }>('/workshop/plugins'),
    enablePlugin: (name: string) => http.post<{ data?: { ok?: boolean, enabled?: boolean } }>(`/workshop/plugins/${name}/enable`, {}),
    disablePlugin: (name: string) => http.post<{ data?: { ok?: boolean, enabled?: boolean } }>(`/workshop/plugins/${name}/disable`, {}),
    /** 插件健康检测(原始返回,非信封:rag-bridge 看 backend.ok && web.ok,diag-bridge 看 remote.status==='ok') */
    pluginHealth: (name: string) => http.get<Record<string, unknown>>(`/plugins/${name}/health`),
    // 团队(Channel)级插件开关(channel_plugins 表;source=default 表示未显式配置,默认全启用)
    listChannelPlugins: (id: string) =>
      http.get<{ data?: { plugins?: ChannelPluginStateDto[], source?: 'explicit' | 'default' } }>(`/workshop/channels/${id}/plugins`),
    putChannelPlugins: (id: string, body: { plugins: Array<{ name: string, enabled: boolean }> }) =>
      http.put<{ data?: { plugins?: ChannelPluginStateDto[], source?: 'explicit' | 'default' } }>(`/workshop/channels/${id}/plugins`, body),
    // AgentTeam 级插件开关(同表 team 作用域;部署 deploy 时传导到目标 channel)
    listTeamPlugins: (id: string) =>
      http.get<{ data?: { plugins?: ChannelPluginStateDto[], source?: 'explicit' | 'default' } }>(`/workshop/teams/${id}/plugins`),
    putTeamPlugins: (id: string, body: { plugins: Array<{ name: string, enabled: boolean }> }) =>
      http.put<{ data?: { plugins?: ChannelPluginStateDto[], source?: 'explicit' | 'default' } }>(`/workshop/teams/${id}/plugins`, body),
  }
}

/** 平台插件清单条目(GET /workshop/plugins;顶层 plugins key,兼容 {code,data} 信封) */
export interface WorkshopPluginDto {
  name: string
  version?: string
  description?: string
  scope?: string
  /** 内置插件(桥接插件) */
  builtin?: boolean
  enabled?: boolean
  hasClient?: boolean
  routes?: Array<{ method: string, path: string }>
  /** 装载失败原因 */
  error?: string | null
}

/** 团队(Channel)插件开关条目(GET/PUT /workshop/channels/:id/plugins) */
export interface ChannelPluginStateDto {
  name: string
  description?: string
  builtin?: boolean
  /** 该团队对此插件的开关 */
  enabled: boolean
}

/** harness 终端会话视图(GET /workshop/channels/:id/terminals) */
export interface TerminalSessionDto {
  pid: number
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  harness: string
  alive: boolean
  running: boolean
  streaming: boolean
  startedAt: number
}

/** Agent 模板详情(全局;instances = 已克隆实例去向;v10 用户隔离字段) */
export interface AgentTemplateDto {
  id: string
  name: string
  harness: string
  config: Record<string, unknown>
  enabled: number
  /** 可见性:'private' 仅本人 | 'public' 全员可读可用 */
  visibility: 'private' | 'public'
  /** 内置模板(公开只读,任何人不可修改删除) */
  isBuiltin: boolean
  /** 归属用户(null = 内置) */
  ownerUserId: string | null
  /** 归属用户名(列表接口附注;'system' = 内置) */
  ownerName?: string | null
  instances: Array<{ id: string, channelId: string, role: 'lead' | 'worker', token: string }>
  createdAt: string
  updatedAt: string
}

/** AgentTeam 详情(v10 用户隔离字段) */
export interface TeamDto {
  id: string
  name: string
  description?: string
  visibility: 'private' | 'public'
  isBuiltin: boolean
  ownerUserId: string | null
  ownerName?: string | null
  members: Array<{ templateId: string, name: string, harness: string, role: 'lead' | 'worker', addedAt: string }>
  createdAt: string
  updatedAt: string
}

/** Channel 模板成员条目(引用 Agent 模板或内联定义) */
export type ChannelTemplateMemberDto
  = | { templateId: string, role: 'lead' | 'worker' }
    | { inline: { name: string, harness: string, config?: Record<string, unknown> }, role: 'lead' | 'worker' }

/** Channel 模板详情(场景 + 工作目录 + 成员组合;v10) */
export interface ChannelTemplateDto {
  id: string
  name: string
  description: string
  scenarioPrompt: string
  workspace: string
  lead: { name: string, harness: string, config?: Record<string, unknown> } | null
  members: ChannelTemplateMemberDto[]
  visibility: 'private' | 'public'
  isBuiltin: boolean
  ownerUserId: string | null
  ownerName?: string | null
  createdAt: string
  updatedAt: string
}

/** AepSnapshot 的轻量 REST 对齐(WS 未连时兜底刷新;实际从 WS channel.snapshot 取) */
export type { AepSnapshot }

/** 调用者在某 Channel 的能力视图(manager.channelPermissionsOf;按钮可用性唯一事实源) */
export interface ChatPermissionsDto {
  isOwner: boolean
  isMember: boolean
  isAdmin: boolean
  status: string | null
  role: string | null
  canJoin: boolean
  canPost: boolean
  canInvokeAgent: boolean
  canApprove: boolean
  canManage: boolean
}

/** 群聊发送响应(deliveries = 每个 @Agent 一条投递台账) */
export interface ChatSendResultDto {
  message: AepChatMessage
  deliveries: Array<{ deliveryId: string, agentId: string, status: string }>
  /** true = 同 clientMessageId 重复提交,服务端返回原消息且未重复投递 */
  duplicates: boolean
  /** 文本里的 @目标不属于本 Channel(未投递,仅提示) */
  unresolvedMentions: string[]
  /** 服务端权威解析出的 mention(含从文本补解析的) */
  mentions: AepChatMention[]
}

/** PATCH /channels/:id 的返回(管理面 ChannelRow;群聊侧只消费下面几个字段) */
export interface ChannelChatSettingsRowDto {
  id: string
  name: string
  description?: string
  visibility: AepChannelChatSettings['visibility']
  joinPolicy: AepChannelChatSettings['joinPolicy']
  approvalPolicy: AepChannelChatSettings['approvalPolicy']
  chatEnabled: number
  version: number
  ownerUserId?: string | null
}

/** GET /notifications 分页响应 */
export interface NotificationPageDto {
  notifications: AepNotification[]
  unreadCount: number
  cursor: { createdAt: string, id: string } | null
  nextCursor: { createdAt: string, id: string } | null
}

/** 定时任务计划(v16;服务端 ScheduleView 投影) */
export interface ScheduleDto {
  id: string
  channelId: string
  channelName: string
  name: string
  title: string
  description: string
  /** 'interval' 固定间隔 | 'daily' 每日定点 */
  mode: 'interval' | 'daily'
  intervalMs: number
  /** 'HH:MM'(daily;本地时区) */
  dailyTime: string
  enabled: number
  /** idle 待命 | waiting 等 Channel 收口 | running 触发在途 | disabled 已停用 | failed 熔断 */
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

/** 定时任务运行历史行(v16) */
export interface ScheduleRunDto {
  id: string
  scheduleId: string
  /** 'timer' 周期触发 | 'manual' 手动执行 */
  triggerKind: string
  taskId: string | null
  /** RUNNING | COMPLETED | FAILED */
  state: string
  error: string
  startedAt: string
  endedAt: string | null
}
