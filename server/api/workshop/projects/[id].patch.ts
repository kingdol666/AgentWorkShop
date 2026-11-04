/**
 * PATCH /api/workshop/projects/:id —— 更新项目基本信息（owner-only）。
 * body: { name?, description?, objective?, mode? }
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { zValidator } from '../../../utils/validate'
import { resolveUser } from '../caller'
import { getProjectService } from '../../../services/workshop/projects/service'

const schema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  objective: z.string().min(1).optional(),
  mode: z.enum(['observe', 'supervised', 'auto']).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().updateProject(getRouterParam(event, 'id')!, user, body)
})
