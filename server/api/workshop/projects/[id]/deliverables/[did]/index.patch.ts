/**
 * PATCH /api/workshop/projects/:id/deliverables/:did —— 编辑交付物（owner-only，planned/rejected 态）。
 * body: { name?, description?, required?, acceptanceCriteria?, dueAt? }
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { zValidator } from '../../../../../../utils/validate'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

const schema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  dueAt: z.string().nullable().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().updateDeliverableItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'did')!,
    user,
    body,
  )
})
