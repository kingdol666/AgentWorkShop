/** GET /api/workshop/channels/:id/memory-graph/entities —— 实体列表/搜索。 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  const q = getQuery(event)
  const list = (v: unknown): string[] | undefined => {
    const raw = String(v ?? '').trim()
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined
  }
  return service.listEntities(channelId, {
    q: String(q.q ?? '').trim() || undefined,
    types: list(q.types),
    statuses: list(q.statuses),
    scopeKinds: list(q.scopeKinds) as never,
    scopeKeys: list(q.scopeKeys),
    ownerUserId: String(q.ownerUserId ?? '').trim() || undefined,
    limit: Number(q.limit ?? 100),
    offset: Number(q.offset ?? 0),
  })
})
