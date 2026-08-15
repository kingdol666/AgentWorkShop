/**
 * DELETE /api/workshop/teams/:id/members/:agentId —— 从 AgentTeam 移除 Agent 模板。
 * - 仅删编组关系;不动模板本身与其已部署实例
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  return getWorkshopManager().removeTemplateFromTeam(teamId, agentId)
})
