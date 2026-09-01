/**
 * GET /api/workshop/dcw/optimizations/:id/series —— 优化记录窗口内的数采序列。
 * 查询参数:windowMs(可选;限制返回 setAt 起的窗口长度)。
 * 数据经 lineQuery(queryTagged 参数化接口)取逐通道序列。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const windowMs = q.windowMs ? Number(q.windowMs) : undefined
  const result = await getRecipeRollBackManager().series(id, Number.isFinite(windowMs) ? windowMs : undefined)
  return result
})
