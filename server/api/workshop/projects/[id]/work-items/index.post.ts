/**
 * POST /api/workshop/projects/:id/work-items
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { zValidator } from '../../../../../utils/validate'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

const schema = z.object({
  deliverableId: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().optional(),
  priority: z.number().optional(),
  weight: z.number().positive().optional(),
  dependsOn: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  resultKey: z.string().optional(),
  execBudgetMinutes: z.number().int().positive().max(24 * 60).optional(),
  dedupeKey: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().createWorkItem(getRouterParam(event, 'id')!, user, body)
})
