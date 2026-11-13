/**
 * PATCH /api/workshop/projects/:id/work-items/:wid —— 编辑工作项（owner-only，DRAFT 态契约锁定前）。
 * body: { title?, brief?, execBudgetMinutes?, dependsOn?, contract?, resultKey?, priority? }
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { zValidator } from '../../../../../../utils/validate'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

const schema = z.object({
  title: z.string().min(1).optional(),
  brief: z.string().optional(),
  execBudgetMinutes: z.number().min(1).max(1440).optional(),
  dependsOn: z.array(z.string()).optional(),
  contract: z.record(z.unknown()).nullable().optional(),
  resultKey: z.string().min(1).optional(),
  priority: z.number().int().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().updateWorkItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
    body,
  )
})
