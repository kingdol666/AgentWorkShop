/**
 * POST /api/workshop/projects/:id/complete —— 创建项目完成审批（门禁通过后）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().requestProjectComplete(getRouterParam(event, 'id')!, user)
})
