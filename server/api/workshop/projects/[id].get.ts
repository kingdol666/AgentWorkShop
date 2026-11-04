/**
 * GET /api/workshop/projects/:id —— 项目详情（owner/admin）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getProjectService } from '../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().get(getRouterParam(event, 'id')!, user)
})
