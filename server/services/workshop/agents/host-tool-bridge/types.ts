/**
 * HostToolBridge 的公开类型定义(原 server/services/workshop/agents/host-tool-bridge.ts 拆分为
 * 模块目录后的类型层;四个接口的名字/签名/导出形态与拆分前逐字一致,由 index.ts 原样再导出)。
 */
import type { AgentWorkspace } from '../agent-interface'

/** 工具调用请求(与引擎协议解耦的规范化形状) */
export interface HostToolCall {
  toolName: string
  arguments: Record<string, unknown>
}

export interface HostToolResult {
  text: string
  isError?: boolean
}

/** 会话态(impl 持有,桥读写):当前执行任务 + 当前 session + 待回执上下文 */
export interface HostToolSessionState {
  currentTaskId: string | null
  /** 当前回合的 session id(memory 工具的 session 作用域;平台注入,回合结束清空) */
  sessionId: string | null
  sourceChatMessageId: string | null
  sourceChatDeliveryId: string | null
  replyContext: { fromId: string, messageId: string } | null
}

/** 桥上下文:impl 注入身份与 workspace 取值器 */
export interface ChannelSessionExecutionScope {
  sessionId: string
  productId: string
  lineId: string
  bindingSnapshotHash: string
  bindingSnapshotRevision: number
  /** Recipes and frozen content hashes captured when this session was created. */
  recipes: Array<{ id: string, version: number, contentHash: string }>
}

export interface HostToolBridgeContext {
  identity: { agentId: string, channelId: string, role: 'lead' | 'worker', name: string, harness?: string }
  state: HostToolSessionState
  /** Trusted server-side scope; never populated from model/tool arguments. */
  channelSessionScope?: ChannelSessionExecutionScope | null
  /**
   * 通用(无工业快照)会话的可信会话身份:与 channelSessionScope.sessionId 同源
   * (wireMember 经 activeSessionOfMember 唯一命中派生),仅用于记忆戳/会话检索,
   * 不携带任何工业授权(空 recipes/无 hash)。两字段都缺 → 工具面无会话身份。
   */
  trustedSessionId?: string | null
  getWorkspace(): AgentWorkspace | null
}
