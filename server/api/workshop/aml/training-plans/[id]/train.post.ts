/** POST /api/workshop/aml/training-plans/:id/train —— 立即触发一次修正训练(界面按钮/训练 Channel 工具共用) */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { runPlanTraining, getTrainingPlan } from '@/server/services/workshop/aml/twin/training-plans'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'plan id 必填')
  const plan = getTrainingPlan(id)
  if (!plan) throw new AppError(404, 'AML_PLAN_MISSING', `建模任务 ${id} 不存在`)
  const r = await runPlanTraining(id, { id: user.id, kind: 'user' })
  broadcastSceneEvent('aml.plan', { action: 'training', planId: id, jobId: r.jobId, datasetId: r.datasetId, rowCount: r.rowCount })
  return r
})
