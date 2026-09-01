/**
 * POST /api/workshop/dcw/optimizations/:id/judge —— 对优化记录落判定(Agent/系统/用户三路)。
 * body: { verdict: 'keep'|'rollback'|'uncertain', reason: string, by?: 'user' }
 * 判定与执行分离:rollback 判定只入册,执行走 /rollback 接口或 Agent dcw_rollback。
 */
import { getRouterParam, readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { bindDcwBroadcast } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ verdict?: string, reason?: string }>(event) ?? {}
  const verdict = body.verdict as 'keep' | 'rollback' | 'uncertain'
  if (!verdict || !['keep', 'rollback', 'uncertain'].includes(verdict))
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'verdict 必须为 keep / rollback / uncertain')
  const record = getRecipeRollBackManager().judge(id, verdict, String(body.reason ?? ''), 'user', user.id)
  return { record }
})
