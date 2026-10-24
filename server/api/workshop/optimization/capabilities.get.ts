/**
 * GET /api/workshop/optimization/capabilities?agentInstanceId= —— 环境/求解器/绑定总览(只读)
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { toolOptimizerCapabilities } from '@/server/services/workshop/agents/industrial/optimizer-tools'
import { assertAgentAccess } from '@/server/services/workshop/optimization/rest-auth'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const q = getQuery(event)
  const agentInstanceId = String(q.agentInstanceId ?? '')
  if (!agentInstanceId) throw new AppError(422, 'AGENT_REQUIRED', 'agentInstanceId 必填')
  assertAgentAccess(user, agentInstanceId)
  const result = await toolOptimizerCapabilities(agentInstanceId)
  return { capabilities: JSON.parse(result.text) as unknown }
})
