/**
 * GET /api/workshop/projects/:id/trace/:traceId —— 按 trace 聚合 decisions/events/tasks（plan §7.1）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().traceLookup(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'traceId')!,
    user,
  )
})
