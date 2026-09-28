/** DELETE /api/workshop/aml/training-plans/:id —— 删除建模任务 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deleteTrainingPlan, getTrainingPlan } from '@/server/services/workshop/aml/twin/training-plans'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'plan id 必填')
  if (!getTrainingPlan(id)) throw new AppError(404, 'AML_PLAN_MISSING', `建模任务 ${id} 不存在`)
  if (user.role !== 'admin' && user.role !== 'editor') throw new AppError(403, 'FORBIDDEN', '建模任务删除需 admin/editor。')
  const ok = deleteTrainingPlan(id)
  broadcastSceneEvent('aml.plan', { action: 'deleted', planId: id })
  return { ok }
})
