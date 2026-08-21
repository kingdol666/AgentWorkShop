/**
 * Workshop API 类型化封装(P0 面:channels/agents/tasks/messages/memories/queue/runtime)。
 * 统一走 $http(Bearer cookie 注入 + envelope 解包);错误由拦截器统一 toast。
 */
import type { AepSnapshot } from '#shared/workshop-protocol'

export interface ChannelDto {
  id: string
  name: string
  description?: string
  /** channel 级作业场景 prompt(设置弹窗可编辑) */
  scenarioPrompt?: string
  leadAgentId: string | null
  workspace?: string
  enabled: number
  /** 归属用户(null = 遗留公共) */
  ownerUserId?: string | null
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
    patchChannel: (id: string, body: { name?: string, description?: string, scenarioPrompt?: string, workspace?: string, enabled?: number }) =>
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
    submitTask: (id: string, body: { title: string, description?: string, mode?: 'goal' | 'loop' | 'pipeline', modeConfig?: Record<string, unknown> }) =>
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
    // tasks detail / lifecycle(P1 抽屉)
    getTask: (taskId: string) => http.get<{ data: TaskDto }>(`/workshop/tasks/${taskId}`),
    cancelTask: (taskId: string) => http.post<{ data: TaskDto }>(`/workshop/tasks/${taskId}/cancel`, {}),
    /** HITL:重试 FAILED 任务(优先原 assignee,否则队列最短空闲 worker) */
    retryTask: (taskId: string) => http.post<{ data: TaskDto }>(`/workshop/tasks/${taskId}/retry`, {}),
    // agent 模板库(P1;v10 用户隔离:private 仅本人,public 全员可用,内置只读)
    listTemplates: () => http.get<{ data: AgentTemplateDto[] }>('/workshop/agents'),
    createTemplate: (body: { name: string, harness: string, config?: Record<string, unknown>, visibility?: 'private' | 'public' }) =>
      http.post<{ data: AgentTemplateDto }>('/workshop/agents', body),
    updateTemplate: (id: string, body: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, visibility?: 'private' | 'public' }) =>
      http.request<{ data: AgentTemplateDto }>({ method: 'PATCH', url: `/workshop/agents/${id}`, data: body }),
    deleteTemplate: (id: string) => http.delete<{ data: unknown }>(`/workshop/agents/${id}`),
    // teams(P1 编组库;v10 可见性)
    listTeams: () => http.get<{ data: TeamDto[] }>('/workshop/teams'),
    createTeam: (body: { name: string, description?: string, visibility?: 'private' | 'public' }) => http.post<{ data: TeamDto }>('/workshop/teams', body),
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
  }
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
