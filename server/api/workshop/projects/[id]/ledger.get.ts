/**
 * GET /api/workshop/projects/:id/ledger?limit= —— Progress Ledger 时间线（plan S5）。
 */
import { getRouterParam, getQuery } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const q = getQuery(event)
  const limit = Number.parseInt(String(q.limit ?? '50'), 10)
  return getProjectService().ledgerTail(id, user, Number.isFinite(limit) ? limit : 50)
})
