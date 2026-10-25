/**
 * POST /api/workshop/optimization/solve —— 用户路径求解(权限 = 产线 readonly + 绑定归属)。
 * body: { agentInstanceId, bindingId?, timeoutMs?, allowIneligible? }
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { solve } from '@/server/services/workshop/optimization/manager'
import { assertAgentAccess } from '@/server/services/workshop/optimization/rest-auth'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const agentInstanceId = String(body.agentInstanceId ?? '')
  if (!agentInstanceId) throw new AppError(422, 'AGENT_REQUIRED', 'agentInstanceId 必填(channel_agents.id)')
  assertAgentAccess(user, agentInstanceId)
  const outcome = await solve(agentInstanceId, {
    bindingId: typeof body.bindingId === 'string' ? body.bindingId : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
  })
  return outcome
})
