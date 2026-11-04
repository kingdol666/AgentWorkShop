/**
 * POST /api/workshop/projects/:id/results/:rid/request-acceptance
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().requestAcceptance(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'rid')!,
    user,
  )
})
