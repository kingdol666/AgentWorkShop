/**
 * GET /api/workshop/dcw/journal —— 参数变更账本查询(在册历史;append-only)。
 * 查询参数:nodeId / lineId / source / limit。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const limit = Number(q.limit ?? 100)
  const anchors = getRecipeRollBackManager().journal({
    nodeId: q.nodeId ? String(q.nodeId) : undefined,
    lineId: q.lineId ? String(q.lineId) : undefined,
    source: q.source ? String(q.source) : undefined,
    limit: Number.isFinite(limit) ? Math.min(limit, 500) : 100,
  })
  return { anchors }
})
