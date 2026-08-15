/**
 * DELETE /api/workshop/teams/:id —— 删除 AgentTeam(仅删编组关系;不动成员模板与其已部署实例)。
 * - 不存在 → 幂等成功(manager.removeTeam 不校验)
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  await getWorkshopManager().removeTeam(teamId)
  return { removed: true, teamId }
})
