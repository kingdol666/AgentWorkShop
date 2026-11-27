/** GET /api/workshop/channels/:id/memory-graph/edges —— 关系列表/搜索。 */
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
  return service.listEdges(channelId, {
    q: String(q.q ?? '').trim() || undefined,
    relations: list(q.relations),
    statuses: list(q.statuses),
    limit: Number(q.limit ?? 200),
    offset: Number(q.offset ?? 0),
  })
})
