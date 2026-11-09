/**
 * GET /api/workshop/aml/training-plans/:id —— 单建模任务详情(主资源路径)。
 *
 * 对称性修复(2026-11-09):该路径此前只有 PATCH/DELETE 与 [id]/train,
 * 主资源路径可改不可读。授权口径与列表一致(登录可见)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { getTrainingPlan } from '@/server/services/workshop/aml/twin/training-plans'

export default defineApiHandler((event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const plan = getTrainingPlan(id)
  if (!plan) throw new AppError(404, 'TRAINING_PLAN_MISSING', `建模任务 ${id} 不存在`)
  return { plan }
})
