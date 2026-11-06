/**
 * POST /api/workshop/projects/:id/results/:rid/review
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { zValidator } from '../../../../../../utils/validate'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

const schema = z.object({
  decision: z.enum(['reviewed', 'rejected']),
  reason: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().reviewResult(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'rid')!,
    user,
    body.decision,
    body.reason ?? '',
  )
})
