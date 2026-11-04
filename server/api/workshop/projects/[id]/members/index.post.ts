/**
 * POST /api/workshop/projects/:id/members —— 添加/更新项目成员（owner-only）。
 * body: { userId, role?: 'viewer' | 'approver' }
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ userId?: string, role?: string }>(event) ?? {}
  return getProjectService().addMember(getRouterParam(event, 'id')!, user, {
    userId: String(body.userId ?? ''),
    role: body.role,
  })
})
