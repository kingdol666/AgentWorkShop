/**
 * GET /api/workshop/teams —— 全部 AgentTeam(含成员模板快照)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async () => {
  return getWorkshopManager().listTeams()
})
