/**
 * POST /api/workshop/projects/:id/results/:rid/submit
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { zValidator } from '../../../../../../utils/validate'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

const schema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  method: z.string().optional(),
  dataWindow: z.record(z.string(), z.unknown()).optional(),
  sampleCount: z.number().int().nonnegative().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  validityScope: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(z.record(z.string(), z.unknown())).optional(),
  changeSummary: z.string().optional(),
  openQuestions: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().submitResult(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'rid')!,
    user,
    body,
  )
})
