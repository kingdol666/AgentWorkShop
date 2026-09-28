/** PATCH /api/workshop/aml/training-plans/:id —— 更新建模任务(固化训练 spec/策略/启停/目标) */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getTrainingPlan, updateTrainingPlan } from '@/server/services/workshop/aml/twin/training-plans'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  strategy: z.enum(['auto', 'manual']).optional(),
  trainingSpec: z.record(z.string(), z.unknown()).nullable().optional(),
  objectiveId: z.string().min(1).nullable().optional(),
  minIntervalSec: z.number().int().min(60).optional(),
  enabled: z.boolean().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readValidatedBody(event, zValidator(schema))
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'plan id 必填')
  if (!getTrainingPlan(id)) throw new AppError(404, 'AML_PLAN_MISSING', `建模任务 ${id} 不存在`)
  if (user.role !== 'admin' && user.role !== 'editor') throw new AppError(403, 'FORBIDDEN', '建模任务更新需 admin/editor。')
  const plan = updateTrainingPlan(id, body)
  broadcastSceneEvent('aml.plan', { action: 'updated', planId: plan.id, name: plan.name, status: plan.lastStatus })
  return { plan }
})
