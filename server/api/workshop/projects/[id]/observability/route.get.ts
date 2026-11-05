/**
 * GET /api/workshop/projects/:id/observability/route —— 路由读面（计划版本/派发日志/等待与阻塞）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().projectRouteView(getRouterParam(event, 'id')!, user)
})
