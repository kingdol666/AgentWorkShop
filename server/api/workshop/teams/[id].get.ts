/**
 * GET /api/workshop/teams/:id —— AgentTeam 详情(含成员模板快照)。
 * 可见性:属主 / public(含内置)/ admin;他人 private → 403。(修复:原无守卫)
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  const user = resolveUser(event)
  manager.requireTemplateReadable(team, user, 'AgentTeam')
  return team
})
