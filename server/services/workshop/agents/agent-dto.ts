/**
 * Agent 对外 DTO —— HTTP 响应不得回显 token 与敏感 config。
 *
 * 背景(2026-10-28 审计):`instanceToAgentInfo` 直出 `token` 与完整 `config`，
 * `/channels/:id/agents` 对"本 channel 任意成员(含 agent token)"放行 →
 * worker Agent 可读取 lead 的 token，再以 lead 身份调用 agent-tools/invoke，
 * 完整继承 lead 的工业绑定与 lead 专属权限。
 *
 * 约定:
 *  - token 永不进列表/详情；只在 rotate-token 一次性返回。
 *  - config 仅 channel 属主/admin 可见（UI 的成员编辑/专长展示需要），
 *    且剔除启动类敏感键（command/args/cwd/env）。
 *  - 其余调用方只拿 summary（id/name/role/harness/enabled/templateId）。
 */
import type { AgentInfo } from './agent-interface'

const SENSITIVE_CONFIG_KEYS = ['command', 'args', 'cwd', 'env'] as const

export interface ChannelAgentSummary {
  id: string
  channelId: string
  name: string
  harness: string
  role: string
  enabled: number
  templateId: string | null
  config?: Record<string, unknown>
}

function safeConfig(config: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {}
  const deny = new Set<string>(SENSITIVE_CONFIG_KEYS)
  return Object.fromEntries(Object.entries(config).filter(([k]) => !deny.has(k)))
}

/** 名册投影（token 永远不出现） */
export function channelAgentSummary(agent: AgentInfo, opts: { includeConfig?: boolean } = {}): ChannelAgentSummary {
  const summary: ChannelAgentSummary = {
    id: agent.id,
    channelId: agent.channelId,
    name: agent.name,
    harness: agent.harness,
    role: agent.role,
    enabled: agent.enabled ?? 1,
    templateId: agent.templateId ?? null,
  }
  if (opts.includeConfig) summary.config = safeConfig(agent.config)
  return summary
}

/** 批量投影 */
export function channelAgentSummaries(agents: AgentInfo[], opts: { includeConfig?: boolean } = {}): ChannelAgentSummary[] {
  return agents.map(a => channelAgentSummary(a, opts))
}
