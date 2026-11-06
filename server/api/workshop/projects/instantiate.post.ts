/**
 * POST /api/workshop/projects/instantiate —— 蓝图一键实例化为全新 project（P1-1「新开会话」）。
 * body: { template?: 模板名, blueprint?: 蓝图文档, nameOverride? } —— 二选一（template 命中当前用户可见的命名模板）。
 * 计划免批蓝图（planApprovalRequired=false）→ 直接激活返回 active；否则返回 pending_plan_approval + planApprovalId。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { resolveUser } from '../caller'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { getProjectService } from '../../../services/workshop/projects/service'
import { createProjectBlueprintRepo } from '../../../services/workshop/projects/blueprints.repo'

const blueprintSchema = z.object({
  name: z.string().min(1),
  objective: z.string().min(1),
  description: z.string().optional(),
  routingPolicy: z.enum(['legacy', 'technical']).optional(),
  planApprovalRequired: z.boolean().optional(),
  autoDispatch: z.boolean().optional(),
  mode: z.enum(['observe', 'supervised', 'auto']).optional(),
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
})

const schema = z.object({
  template: z.string().optional(),
  blueprint: blueprintSchema.optional(),
  nameOverride: z.string().optional(),
}).refine(v => v.blueprint || v.template, { message: 'blueprint 与 template 二选一' })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  let blueprint = body.blueprint
  if (!blueprint && body.template) {
    const row = createProjectBlueprintRepo().findByName(body.template, user.id, user.role)
    if (!row) throw new AppError(404, 'NOT_FOUND', `蓝图模板不存在: ${body.template}`)
    blueprint = row.blueprint
  }
  if (!blueprint) throw new AppError(400, 'BAD_REQUEST', '缺少 blueprint/template')
  const svc = getProjectService()
  const result = await svc.instantiateBlueprint(user, { blueprint, nameOverride: body.nameOverride })
  return result
})
