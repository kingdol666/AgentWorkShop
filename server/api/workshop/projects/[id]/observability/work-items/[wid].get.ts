/**
 * GET /api/workshop/projects/:id/observability/work-items/:wid
 * 单工作项执行链：attempts → root task → worker 子任务 → artifacts → results → reviews。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().projectWorkItemDetail(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
  )
})
