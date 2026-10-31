/**
 * GET /api/workshop/a2a/:agentId.card —— A2A AgentCard(设计文档 §6.3,规范 §7)。
 * 由 AgentConfig 动态生成:camelCase 字段,supportedInterfaces.protocolBinding='JSONRPC',
 * capabilities.streaming=true,skills 由 config.skills 声明(缺省 [])。
 * 按 A2A 规范直接返回 card 文档(不走 ApiEnvelope 信封);Agent 不存在 → 404。
 */
import { defineEventHandler, getRequestHeader, getRouterParam, setResponseStatus } from 'h3'
import { settingOf } from '../../../../../services/workshop/settings'
import { resolveUserByToken } from '../../../../../services/user.service'
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

/** 按实例 id 查找 Channel 实例(公开 API 无 findAgent;经 deps.repos 只读查询) */
export function findAgent(manager: AgentChannelManager, agentId: string): AgentInfo | undefined {
  const repos = (manager as unknown as { deps: ManagerDeps }).deps.repos
  const m = repos.channelAgents.findById(agentId)
  if (!m) return undefined
  return {
    id: m.id,
    channelId: m.channelId,
    name: m.name,
    harness: m.harness,
    role: m.role as 'lead' | 'worker',
    config: parseJson<Record<string, unknown>>(m.configJson, {}),
    token: m.token,
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
  // A2A 规范里 AgentCard 是公开发现面(不含任何 token/凭据);但在内网/敏感部署下
  // 实例与技能清单本身也是情报 → 提供开关,关闭时要求认证。
  if (settingOf('security.a2aCardPublic') === false) {
    const token = getRequestHeader(event, 'authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (!token || !resolveUserByToken(token)) {
      setResponseStatus(event, 401)
      return { error: { code: 'UNAUTHORIZED', message: 'AgentCard 未公开:需有效用户 token' } }
    }
  }
  const agentId = getRouterParam(event, 'agentId')!
  const agent = findAgent(getWorkshopManager(), agentId)
  if (!agent) {
    setResponseStatus(event, 404)
    return { error: { code: 'NOT_FOUND', message: `Agent 不存在: ${agentId}` } }
  }
  return buildAgentCard(agent)
})
