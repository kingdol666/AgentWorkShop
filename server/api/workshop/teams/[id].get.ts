/**
 * GET /api/workshop/teams/:id —— AgentTeam 详情(含成员模板快照)。
 * - 不存在 → 404 NOT_FOUND
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const team = getWorkshopManager().getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  return team
})
