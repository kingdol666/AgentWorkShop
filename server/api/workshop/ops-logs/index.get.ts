/**
 * GET /api/workshop/ops-logs —— 运维日志查询(全操作统一记录)。
 * 维度隔离:lineId / productId / recipeId + 来源 actorKind + 分类 kind + 关键词 q + 时间区间。
 * 返回 { logs: [...], count }。行结构 = audit_log 投影(id/actor/actorKind/kind/summary/detailJson…)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getOps } from '../../../services/workshop/ops/ops'
import { AppError } from '../../../utils/errors'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const repo = getOps()?.audit
  if (!repo)
    throw new AppError(503, 'UNAVAILABLE', '运维日志仓储未就绪')
  const q = getQuery(event) as Record<string, string | undefined>
  const logs = repo.query({
    lineId: q.lineId || undefined,
    productId: q.productId || undefined,
    recipeId: q.recipeId || undefined,
    actorKind: q.actorKind || undefined,
    kind: q.kind || undefined,
    q: q.q || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    limit: Math.min(500, Number(q.limit ?? 200) || 200),
  })
  return { logs, count: logs.length }
})
