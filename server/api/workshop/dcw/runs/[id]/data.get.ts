/**
 * GET /api/workshop/dcw/runs/:id/data —— 批次数据视图(数采汇总 + 写历史,窗口隔离)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // 产线权限:批次数据需对所属产线「仅查看」及以上
  const run = getDcwRecipeRepo().runById(id)
  requireLineMode(user, run?.lineId, 'readonly')
  return await getDcwController().runData(id)
})
