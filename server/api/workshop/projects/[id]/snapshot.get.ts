/**
 * GET /api/workshop/projects/:id/snapshot —— 项目只读聚合（plan §7.1）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().projectSnapshot(getRouterParam(event, 'id')!, user)
})
