/**
 * POST /api/workshop/projects —— 创建 Project（自动创建 private 项目办公室频道 + project_leader）。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { resolveUser } from '../caller'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getProjectService } from '../../../services/workshop/projects/service'

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  objective: z.string().min(1),
  successCriteria: z.array(z.string()).optional(),
  mode: z.enum(['observe', 'supervised', 'auto']).optional(),
  leaderHarness: z.string().min(1).optional(),
  leaderConfig: z.record(z.string(), z.unknown()).optional(),
  // PR20 Route 派发闭环：计划批准后按 dependsOn 就绪顺序自动派发（缺省 false）
  autoDispatch: z.boolean().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().create(body, user)
})
