/**
 * GET /api/workshop/agent-tools/bindings?agentId= —— Agent 工业节点绑定列表。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const agentId = typeof q.agentId === 'string' ? q.agentId : ''
  return { bindings: agentId ? getAgentNodeBindingRepo().byAgent(agentId) : getAgentNodeBindingRepo().all() }
})
