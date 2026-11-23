/**
 * GET /api/workshop/agents/:id —— agent 详情(DB 行 + 运行时装配状态)。
 * 可见性:属主 / public(含内置)/ admin;他人 private → 403。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  // 先验身份再查资源:未鉴权调用者不得借 404 探测 Agent 是否存在
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const agent = manager.getAgent(agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `Agent 不存在: ${agentId}`)
  manager.requireTemplateReadable(agent, user, 'Agent 模板')
  return agent
})
