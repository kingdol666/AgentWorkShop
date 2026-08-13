/**
 * GET /api/workshop/a2a/:agentId.card —— A2A AgentCard(设计文档 §6.3,规范 §7)。
 * 由 AgentConfig 动态生成:camelCase 字段,supportedInterfaces.protocolBinding='JSONRPC',
 * capabilities.streaming=true,skills 由 config.skills 声明(缺省 [])。
 * 按 A2A 规范直接返回 card 文档(不走 ApiEnvelope 信封);Agent 不存在 → 404。
 */
import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import type { AgentChannelManager, ManagerDeps } from '../../../../../services/workshop/runtime/manager'
import type { AgentInfo } from '../../../../../services/workshop/agents/agent-interface'
import { parseJson } from '../../../../../services/workshop/db/database'

/** A2A AgentCard(1.0 子集,与 rpc agent/getCard 同一结构) */
export interface AgentCard {
  name: string
  description: string
  supportedInterfaces: {
    url: string
    protocolBinding: 'JSONRPC'
    protocolVersion: '1.0'
  }[]
  capabilities: { streaming: boolean, pushNotifications: boolean }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: unknown[]
}

/** 按 agentId 查找 Agent(公开 API 无 findAgent;经 deps.repos 只读查询) */
export function findAgent(manager: AgentChannelManager, agentId: string): AgentInfo | undefined {
  const repos = (manager as unknown as { deps: ManagerDeps }).deps.repos
  const row = repos.agents.findById(agentId)
  if (!row) return undefined
  return {
    id: row.id,
    channelId: row.channelId,
    name: row.name,
    harness: row.harness,
    role: row.role as 'lead' | 'worker',
    config: parseJson<Record<string, unknown>>(row.configJson, {}),
  }
}

/** 生成 AgentCard(由 AgentConfig 动态生成;description/skills 可经 config 声明) */
export function buildAgentCard(agent: AgentInfo): AgentCard {
  const config = agent.config ?? {}
  return {
    name: agent.name,
    description:
      typeof config.description === 'string'
        ? config.description
        : `AgentWorkShop ${agent.role} Agent(${agent.harness})`,
    supportedInterfaces: [
      {
        url: `/api/workshop/a2a/${agent.id}/rpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: Array.isArray(config.skills) ? config.skills : [],
  }
}

export default defineEventHandler((event) => {
  const agentId = getRouterParam(event, 'agentId')!
  const agent = findAgent(getWorkshopManager(), agentId)
  if (!agent) {
    setResponseStatus(event, 404)
    return { error: { code: 'NOT_FOUND', message: `Agent 不存在: ${agentId}` } }
  }
  return buildAgentCard(agent)
})
