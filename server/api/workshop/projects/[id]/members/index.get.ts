/**
 * GET /api/workshop/projects/:id/members —— 项目成员列表（owner/admin/成员可读）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().listMembers(getRouterParam(event, 'id')!, user)
})
