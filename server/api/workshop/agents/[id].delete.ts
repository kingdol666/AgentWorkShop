/**
 * DELETE /api/workshop/agents/:id —— 删除 Agent 定义(级联移除其全部成员关系与订阅)。
 * 权限:属主或 admin;内置模板任何人不可删除(TEMPLATE_BUILTIN)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const agent = manager.getAgent(agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `Agent 不存在: ${agentId}`)
  const user = resolveUser(event)
  manager.requireWritable(agent.ownerUserId, user, 'Agent 模板')
  await manager.removeAgent(agentId)
  return { ok: true }
})
