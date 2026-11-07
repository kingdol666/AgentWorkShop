/**
 * POST /api/workshop/project-blueprints —— 命名保存/覆盖项目蓝图（P1-1 模板层）。
 * body: { name, blueprint }；同名同 owner 覆盖（admin 可覆盖任意）。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { resolveUser } from '../caller'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { createProjectBlueprintRepo } from '../../../services/workshop/projects/blueprints.repo'

const schema = z.object({
  name: z.string().min(1),
  blueprint: z.object({
    name: z.string().min(1),
    objective: z.string().min(1),
    description: z.string().optional(),
    routingPolicy: z.enum(['legacy', 'technical']).optional(),
    planApprovalRequired: z.boolean().optional(),
    autoDispatch: z.boolean().optional(),
    mode: z.enum(['observe', 'supervised', 'auto']).optional(),
    leaderHarness: z.string().optional(),
    leaderProvider: z.string().optional(),
    leaderModel: z.string().optional(),
    channels: z.array(z.object({
      key: z.string().min(1),
      name: z.string().optional(),
      charter: z.string().optional(),
      leadHarness: z.string().optional(),
      leadConfig: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(12),
    plan: z.object({
      deliverables: z.array(z.record(z.string(), z.unknown())).min(1),
      work_items: z.array(z.record(z.string(), z.unknown())),
    }),
  }),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  const repo = createProjectBlueprintRepo()
  const row = repo.save(body.name, user.id, body.blueprint as never, user.role)
  return { id: row.id, name: row.name, updatedAt: row.updatedAt }
})
