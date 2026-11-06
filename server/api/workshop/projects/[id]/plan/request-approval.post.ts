/**
 * POST /api/workshop/projects/:id/plan/request-approval
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { zValidator } from '../../../../../utils/validate'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

const schema = z.object({
  version: z.number().int().positive(),
  plan: z.record(z.string(), z.unknown()),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().requestPlanApproval(getRouterParam(event, 'id')!, user, body)
})
