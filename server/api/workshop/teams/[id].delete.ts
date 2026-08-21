/**
 * DELETE /api/workshop/teams/:id —— 删除 AgentTeam(仅删编组关系;不动成员模板与已部署实例)。
 * 权限:属主或 admin;内置编组任何人不可删除。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  manager.requireWritable(team.ownerUserId, user, 'AgentTeam')
  await manager.removeTeam(teamId)
  return { removed: true, teamId }
})
