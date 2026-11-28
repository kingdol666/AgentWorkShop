/** POST /api/workshop/channels/:id/memory-graph/edges/:edgeId/restore —— 恢复关系。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  return service.restoreEdge(channelId, getRouterParam(event, 'edgeId')!, actor)
})
