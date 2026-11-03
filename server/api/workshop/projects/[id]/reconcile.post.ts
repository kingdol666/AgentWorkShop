/**
 * POST /api/workshop/projects/:id/reconcile —— 确定性对账（V1 手动/定时共用）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().reconcile(getRouterParam(event, 'id')!, user)
})
