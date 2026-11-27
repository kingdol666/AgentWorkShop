/** GET /api/workshop/channels/:id/memory-graph/edges/:edgeId —— 关系详情 + 证据/claim。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return service.edgeDetail(channelId, getRouterParam(event, 'edgeId')!)
})
