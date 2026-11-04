/**
 * POST /api/workshop/projects/:id/work-items/:wid/dispatch
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().dispatchWorkItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
  )
})
