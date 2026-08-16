/**
 * Agent Event Protocol(AEP)v1 — Workshop 前后端统一事件协议。
 * 权威定义;前端经 `#shared/workshop-protocol` 引用,服务端 WS hub 按此装配信封。
 *
 * 信封:{ v, type, seq, at, channelId, agentId?, taskId?, payload }
 *  - seq:channel 内单调递增;断线续传游标(sub 时带 lastSeq 重放)
 *  - 兼容:字段 type/payload 与旧 hub 帧一致(api-live-e2e 等消费方不破坏)
 *
 * 事件目录:
 *  channel.snapshot    初始对齐{ channel, agents, tasks, queue, messages[50] }
 *  agent.status        { agentId, state, currentTaskId?, queued?, completed? }
 *  agent.message       A2AMessage(harness message 事件;LLM 产出气泡)
 *  agent.status.message{ text }(工具标记 🔧 / 中间状态文本)
 *  task.status         { taskId, state, assigneeId?, agentId? }
 *  task.progress       { taskId, progress, agentId? }
 *  a2a.artifact        { taskId?, artifact }(任务交付物/工件)
 *  a2a.message         A2AMessage(channel 内新消息投递:assign/peer/inject)
 *  memory.saved        { agentId, scope, title, dedupKey }
 *  error               { code, message }
 *  pong                { t }
 *
 * 上行:{ type:'ping' } → pong;{ type:'sub', channelId, lastSeq? };{ type:'unsub', channelId }
 */
import type { A2AArtifact, A2AMessage } from '../server/services/workshop/types/a2a'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

export const AEP_VERSION = 1

/** channel.snapshot payload(agents 含队列上下文) */
export interface AepSnapshot {
  channelId: string
  channel: {
    id: string
    name: string
    description?: string
    leadAgentId: string | null
    workspace?: string
    enabled: number
  }
  agents: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    harness: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    queued?: number
    completed?: number
  }>
  tasks: WorkspaceTask[]
  queue: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId: string | null
    queuedCount: number
    completedCount: number
  }>
  messages: A2AMessage[]
}

export type AepEvent
  = | { type: 'channel.snapshot', payload: AepSnapshot }
    | { type: 'agent.status', payload: { agentId: string, state: 'idle' | 'busy' | 'stopped', currentTaskId?: string | null, queued?: number, completed?: number } }
    | { type: 'agent.message', payload: A2AMessage }
    | { type: 'agent.status.message', payload: { text: string } }
    | { type: 'task.status', payload: { taskId: string, state: string, assigneeId?: string, agentId?: string } }
    | { type: 'task.progress', payload: { taskId: string, progress: number, agentId?: string } }
    | { type: 'a2a.artifact', payload: { taskId?: string, artifact: A2AArtifact } }
    | { type: 'a2a.message', payload: A2AMessage }
    | { type: 'memory.saved', payload: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string } }
    | { type: 'error', payload: { code: string, message: string } }
    | { type: 'pong', payload: { t: number } }

/** AEP 下行信封 */
export interface AepEnvelope<T = AepEvent['payload']> {
  v: number
  type: AepEvent['type'] | string
  seq: number
  at: string
  channelId: string
  agentId?: string
  taskId?: string
  payload: T
}

/** 上行帧 */
export type AepUplink
  = | { type: 'ping' }
    | { type: 'sub', channelId: string, lastSeq?: number }
    | { type: 'unsub', channelId: string }

/** 事件类型的展示分组(前端过滤条用) */
export const AEP_GROUPS: Record<string, string[]> = {
  all: [],
  messages: ['agent.message', 'agent.status.message', 'a2a.message'],
  tools: ['agent.status.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  errors: ['error'],
}
