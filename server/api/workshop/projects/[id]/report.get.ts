/**
 * GET /api/workshop/projects/:id/report —— 周报（一页纸数字，与库同源）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().projectWeeklyReport(getRouterParam(event, 'id')!, user)
})
