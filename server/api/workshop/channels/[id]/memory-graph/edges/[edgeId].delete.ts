/** DELETE /api/workshop/channels/:id/memory-graph/edges/:edgeId —— 软删（可恢复）。 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const reason = String(getQuery(event).reason ?? '').slice(0, 300)
  service.deleteEdge(channelId, getRouterParam(event, 'edgeId')!, actor, reason)
  return { ok: true }
})
