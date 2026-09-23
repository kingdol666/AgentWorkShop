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

/** 会话态(impl 持有,桥读写):当前执行任务 + 待回执上下文 */
export interface HostToolSessionState {
  currentTaskId: string | null
  replyContext: { fromId: string, messageId: string } | null
}

/** 桥上下文:impl 注入身份与 workspace 取值器 */
export interface HostToolBridgeContext {
  identity: { agentId: string, channelId: string, role: 'lead' | 'worker', name: string }
  state: HostToolSessionState
  getWorkspace(): AgentWorkspace | null
}
