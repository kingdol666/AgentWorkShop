/**
 * Workshop API 类型化封装(P0 面:channels/agents/tasks/messages/memories/queue/runtime)。
 * 统一走 $http(Bearer cookie 注入 + envelope 解包);错误由拦截器统一 toast。
 */
import type { AepSnapshot } from '#shared/workshop-protocol'

export interface ChannelDto {
  id: string
  name: string
  description?: string
  leadAgentId: string | null
  workspace?: string
  enabled: number
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
    createChannel: (body: { name: string, description?: string, leadAgent?: { name: string, harness: string, config?: Record<string, unknown> } }) =>
      http.post<{ data: { channelId: string, leadAgentId?: string, workspace: string } }>('/workshop/channels', body),
    deleteChannel: (id: string) => http.delete<{ data: unknown }>(`/workshop/channels/${id}`),
    // channel agents
    listChannelAgents: (id: string) => http.get<{ data: AgentInfoDto[] }>(`/workshop/channels/${id}/agents`),
    addChannelAgent: (id: string, body: { agentId?: string, name?: string, harness?: string, role?: 'lead' | 'worker', config?: Record<string, unknown> }) =>
      http.post<{ data: AgentInfoDto }>(`/workshop/channels/${id}/agents`, body),
    removeChannelAgent: (id: string, agentId: string) => http.delete<{ data: unknown }>(`/workshop/channels/${id}/agents/${agentId}`),
    // tasks
    listTasks: (id: string) => http.get<{ data: TaskDto[] }>(`/workshop/channels/${id}/tasks`),
    submitTask: (id: string, body: { title: string, description?: string, mode?: 'goal' | 'loop' | 'pipeline', modeConfig?: Record<string, unknown> }) =>
      http.post<{ data: TaskDto }>(`/workshop/channels/${id}/tasks`, body),
    // messages(注入即时消息/队列消息)
    injectMessage: (id: string, body: { toAgentId: string, text: string, priority?: 'immediate' | 'task', requireReply?: boolean }) =>
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
    // teams(P1 页面用;先备好)
    listTeams: () => http.get<{ data: Array<{ id: string, name: string, description?: string, members: Array<{ templateId: string, name: string, harness: string, role: string }> }> }>('/workshop/teams'),
    deployTeam: (teamId: string, channelId: string) => http.post<{ data: unknown }>(`/workshop/teams/${teamId}/deploy`, { channelId }),
  }
}

/** AepSnapshot 的轻量 REST 对齐(WS 未连时兜底刷新;实际从 WS channel.snapshot 取) */
export type { AepSnapshot }
