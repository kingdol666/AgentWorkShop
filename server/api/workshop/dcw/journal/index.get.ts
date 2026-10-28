/**
 * GET /api/workshop/dcw/journal —— 参数变更账本查询(在册历史;append-only)。
 * 查询参数:nodeId / lineId / source / limit。
 * 2026-10-28:显式 lineId 需只读授权;未指定时按调用者可见产线过滤。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { filterRowsByLine, requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const lineId = q.lineId ? String(q.lineId) : undefined
  if (lineId) requireLineForResource(user, lineId, '产线', 'readonly')
  const limit = Number(q.limit ?? 100)
  const anchors = getRecipeRollBackManager().journal({
    nodeId: q.nodeId ? String(q.nodeId) : undefined,
    lineId,
    source: q.source ? String(q.source) : undefined,
    limit: Number.isFinite(limit) ? Math.min(limit, 500) : 100,
  })
  return { anchors: filterRowsByLine(user, anchors, a => a.lineId) }
})
