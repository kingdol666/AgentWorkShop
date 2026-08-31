/**
 * GET /api/workshop/audit —— 审计日志查询(R1)。
 * admin 可查全部(可按 action/targetId 过滤);其他角色仅限本人条目(行为透明,越权不可见他人)。
 */
import { getQuery } from 'h3'
import { resolveUser, isAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const repo = getOps()?.audit
  if (!repo) return { entries: [] }
  const q = getQuery(event)
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
  const rows = repo.query({
    actor: isAdmin(user) ? undefined : user.id,
    action: typeof q.action === 'string' && q.action ? q.action : undefined,
    targetId: typeof q.targetId === 'string' && q.targetId ? q.targetId : undefined,
    limit,
  })
  const entries = rows.map((r) => {
    let detail: unknown
    try {
      detail = JSON.parse(String(r.detailJson ?? '{}'))
    }
    catch {
      detail = {}
    }
    return {
      id: r.id,
      actor: r.actor,
      actorName: r.actorName,
      actorKind: r.actorKind,
      action: r.action,
      targetKind: r.targetKind,
      targetId: r.targetId,
      detail,
      at: r.at,
    }
  })
  return { entries }
})
