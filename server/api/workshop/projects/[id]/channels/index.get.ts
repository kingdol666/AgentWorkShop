/**
 * GET /api/workshop/projects/:id/channels —— 项目成员 Channel 列表。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().listChannels(getRouterParam(event, 'id')!, user)
})
