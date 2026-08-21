/**
 * DELETE /api/workshop/teams/:id/members/:agentId —— 从 AgentTeam 移除 Agent 模板。
 * - 仅删编组关系;不动模板本身与其已部署实例
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  manager.requireWritable(team.ownerUserId, user, 'AgentTeam')
  return manager.removeTemplateFromTeam(teamId, agentId)
})
