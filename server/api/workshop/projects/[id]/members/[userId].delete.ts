/**
 * DELETE /api/workshop/projects/:id/members/:userId —— 移除项目成员（owner-only）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  getProjectService().removeMember(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'userId')!,
    user,
  )
  return { ok: true }
})
