/**
 * GET /api/workshop/dcw/optimizations —— Agent 优化记录查询(数采中心/产线详情共用)。
 * 查询参数:lineId / recipeId / nodeId / status / agentId / limit。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { filterRowsByLine, requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const limit = Number(q.limit ?? 100)
  const lineId = q.lineId ? String(q.lineId) : undefined
  if (lineId) requireLineForResource(user, lineId, '产线', 'readonly')
  const records = getRecipeRollBackManager().records({
    lineId,
    recipeId: q.recipeId ? String(q.recipeId) : undefined,
    nodeId: q.nodeId ? String(q.nodeId) : undefined,
    status: q.status ? String(q.status) : undefined,
    agentId: q.agentId ? String(q.agentId) : undefined,
    limit: Number.isFinite(limit) ? Math.min(limit, 500) : 100,
  })
  return { records: filterRowsByLine(user, records, r => r.lineId) }
})
