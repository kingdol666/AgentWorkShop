/**
 * GET /api/workshop/dcw/optimizations/:id/series —— 优化记录窗口内的数采序列。
 * 查询参数:windowMs(可选;限制返回 setAt 起的窗口长度)。
 * 数据经 lineQuery(queryTagged 参数化接口)取逐通道序列。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const record = getRecipeRollBackManager().recordById(id)
  if (!record) throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${id}`)
  requireLineForResource(user, record.lineId, '优化记录', 'readonly')
  const q = getQuery(event)
  const windowMs = q.windowMs ? Number(q.windowMs) : undefined
  const result = await getRecipeRollBackManager().series(id, Number.isFinite(windowMs) ? windowMs : undefined)
  return result
})
