/**
 * A2A(Agent-to-Agent)数据模型 — L1 数据层。
 * 定义 Channel 内 Agent 间通信消息、任务成果与错误的统一类型。
 * 仅类型定义,无运行时逻辑;供 workspace 内持久化层(db)、运行时层(runtime)与 impl 层共同消费。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块。
 */

/** A2A 消息内容片段:四种变体(text/data/url/raw),判别键分别为 text/data/url/raw */
export type Part
  = | { text: string, mediaType?: string, metadata?: Record<string, unknown> }
    | { data: unknown, mediaType?: string, metadata?: Record<string, unknown> }
    | { url: string, mediaType?: string, filename?: string, metadata?: Record<string, unknown> }
    | { raw: string, mediaType?: string, filename?: string, metadata?: Record<string, unknown> }

/** A2A 消息:Channel 内 Agent 点对点通信与平台任务投递的统一载体 */
export interface A2AMessage {
  messageId: string
  contextId: string
  taskId?: string
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

/**
 * 渠道邮件视图:带路由/投递元信息的 A2A 消息。
 * messages 表行的公开投影;lead 全览、调度快照与 REST/MCP 出口共用,
 * 携带 from/to/state/time(纯 A2AMessage 只承载 parts,路由信息在 metadata,不适合作观察面)。
 */
export interface ChannelMail {
  messageId: string
  /** 关联任务(assign/cancel 等任务消息才有) */
  taskId: string | null
  fromAgentId: string | null
  toAgentId: string | null
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: Part[]
  metadata: Record<string, unknown>
  /** 投递状态:pending=未消费 / consuming=消费中 / consumed=已消费 */
  state: 'pending' | 'consuming' | 'consumed' | 'dead'
  createdAt: string
  consumedAt: string | null
}

/**
 * 人类群聊投递消息(平台盖章 x-aw-source-chat-message-id;非 Agent 间协作)。
 *
 * 这类消息必须走消息回合(processMessage)收尾的 platformReply 才能把答复回写群聊;
 * poll_messages 的「读即取」一旦认领,poll 轮次内的文本不会触发 platformReply,
 * 用户就永远收不到回答(实测:15:15 提问被 lead 的 poll 取走,15:50 群聊仍无回复)。
 */
export function isHumanChatDelivery(m: { metadata?: Record<string, unknown> }): boolean {
  const meta = m.metadata ?? {}
  const from = meta['x-aw-from-agent']
  if (typeof from === 'string' && from.length > 0) return false
  const sourceChatId = meta['x-aw-source-chat-message-id']
  return typeof sourceChatId === 'string' && sourceChatId.length > 0
}

/** A2A 成果:任务作业产出的内容集合 */
export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
}

/** A2A 错误:统一错误语义(code + message + 可选附加数据) */
export interface A2AError {
  code: string
  message: string
  data?: unknown
}
