/**
 * GET /api/workshop/projects/:id/observability/activity?after=&limit=
 * 统一 activity 时间线（events + decisions，keyset cursor）。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  return getProjectService().projectActivity(getRouterParam(event, 'id')!, user, {
    after: typeof q.after === 'string' ? q.after : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  })
})
