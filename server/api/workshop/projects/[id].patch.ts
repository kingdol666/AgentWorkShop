/**
 * PATCH /api/workshop/projects/:id —— 更新项目基本信息（owner-only）。
 * body: { name?, description?, objective?, mode?, autoDispatch? }
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
  // PR20 Route 派发闭环：项目级自动派发开关（owner-only，切换落 project.updated 审计）
  autoDispatch: z.boolean().optional(),
  // Router v3：Leader route gate（none/leader，与 mode=auto 组合才即时应用）
  routeGate: z.enum(['none', 'leader']).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().updateProject(getRouterParam(event, 'id')!, user, body)
})
