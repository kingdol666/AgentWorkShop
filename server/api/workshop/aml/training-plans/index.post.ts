/**
 * POST /api/workshop/aml/training-plans —— 创建建模任务。
 * body: { name, lineId, productId, recipeId, sceneId?, sceneVersion?, objectiveId?,
 *         purpose?, strategy?, datasetSpec(AmlDatasetSpec), trainingSpec?(PhysicsSpec),
 *         modelNamePrefix?, params?, seed?, minIntervalSec? }
 * strategy=auto 需已固化 trainingSpec 才会在新批次时自动修正训练;manual 仅界面/工具触发。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createTrainingPlan } from '@/server/services/workshop/aml/twin/training-plans'
import { parseDatasetSpec } from '@/server/services/workshop/aml/spec'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

const schema = z.object({
  name: z.string().min(1).max(120),
  lineId: z.string().min(1),
  productId: z.string().min(1),
  recipeId: z.string().min(1),
  sceneId: z.string().min(1).optional(),
  sceneVersion: z.string().min(1).optional(),
  objectiveId: z.string().min(1).optional(),
  purpose: z.enum(['mpc_surrogate', 'quality_predict']).optional(),
  strategy: z.enum(['auto', 'manual']).optional(),
  datasetSpec: z.record(z.string(), z.unknown()),
  trainingSpec: z.record(z.string(), z.unknown()).optional(),
  modelNamePrefix: z.string().max(80).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  seed: z.number().int().optional(),
  minIntervalSec: z.number().int().min(60).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  if (user.role !== 'admin' && user.role !== 'editor') throw new AppError(403, 'FORBIDDEN', '建模任务创建需 admin/editor。')
  const plan = createTrainingPlan({ ...body, datasetSpec: parseDatasetSpec(body.datasetSpec), createdBy: user.id })
  broadcastSceneEvent('aml.plan', { action: 'created', planId: plan.id, name: plan.name, status: plan.lastStatus })
  return { plan }
})
