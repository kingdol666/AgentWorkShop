/**
 * GET /api/workshop/agent-tools/list?agentId= —— 工具面 schema(stdio MCP 桥 tools/list 源)。
 * 按 agent 角色装配(host-tools.json + 插件工具),与 omp set_host_tools 注入面同源。
 * 鉴权:agent token(x-aw-agent-token)或仪表盘用户。
 */
import { getQuery, getHeader } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentToken = getHeader(event, 'x-aw-agent-token')
  if (!agentToken) resolveUser(event)
  const q = getQuery(event)
  const agentId = String(q.agentId ?? '')
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  if (agentToken) {
    const resolved = getWorkshopManager().resolveAgentByToken(String(agentToken))
    if (!resolved || resolved.agentId !== agentId) {
      throw createError({ statusCode: 401, statusMessage: 'agent token 校验失败' })
    }
  }
  const tools = getWorkshopManager().hostToolDefsFor(agentId)
  return { tools }
})
