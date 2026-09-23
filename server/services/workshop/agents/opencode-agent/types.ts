/**
 * OpenCodeAgentImpl 的依赖类型与对外 DTO(原 server/services/workshop/agents/opencode-agent.ts 顶部模块级类型声明)。纯类型。
 */
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'

export interface OpenCodeAgentConfig {
  /** opencode 可执行文件(默认取 harness.opencode_command 设置) */
  command?: string
  cwd?: string
  /** 模型(provider/model,如 anthropic/claude-sonnet-4-5) */
  model?: string
  /** opencode agent 名(默认 build) */
  agent?: string
  /** provider 推理档位(variant;effort 为统一注入入口的别名) */
  variant?: string
  /** 思考 effort(统一注入面;等价 variant) */
  effort?: string
  /** 权限策略(session 级;缺省 edit/bash/webfetch 全 ask → HITL) */
  permission?: unknown
  /** 数据目录覆盖(XDG_DATA_HOME;实例隔离/绕开损坏的全局库) */
  dataDir?: string
  /** 配置目录覆盖(XDG_CONFIG_HOME;空目录 = 不加载用户全局 opencode 插件/配置) */
  configDir?: string
  /** 上下文窗口(usage 百分比计算;未知则 percent=null) */
  contextWindow?: number
  /** 压缩阈值(0-1,默认 0.7) */
  compactThreshold?: number
  /** 回合停滞超时(ms,默认 600000) */
  promptTimeoutMs?: number
  /** supervise 超时(ms,默认 150000) */
  superviseTimeoutMs?: number
  systemPromptPrefix?: string
  scenarioPrompt?: string
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
  /** 平台自证 token(MCP 桥回程鉴权;factory 注入) */
  token?: string
  /** 平台 HTTP 基址(桥回程;默认 AW_BASE_URL 或 127.0.0.1:PORT) */
  baseUrl?: string
  /** MCP 桥脚本路径(默认 <packageRoot>/server/harness/aw-mcp-bridge.mjs) */
  mcpBridgePath?: string
}

export interface PendingHitl {
  kind: 'opencode-permission'
  id: string
  type: 'permission' | 'question'
  sessionId: string
  timer: ReturnType<typeof setTimeout> | null
  /** question 型:全量问题(逐题 POST /question/{id}/reply);permission 型为空 */
  questions: AepHitlQuestion[]
}
