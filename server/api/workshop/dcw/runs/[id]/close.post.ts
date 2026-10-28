/**
 * POST /api/workshop/dcw/runs/:id/close —— 关闭批次(结束数据隔离窗口)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const run = getDcwRecipeRepo().runById(id)
  if (!run) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${id}`)
  requireLineForResource(user, run.lineId, '批次', 'operate')
  return { run: getDcwController().closeRun(id) }
})
