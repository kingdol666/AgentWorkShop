/**
 * GET /api/workshop/agents/:id —— agent 详情(DB 行 + 运行时装配状态)。
 * - agent 不存在 → 404 NOT_FOUND
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const agent = manager.getAgent(agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `Agent 不存在: ${agentId}`)
  return agent
})
