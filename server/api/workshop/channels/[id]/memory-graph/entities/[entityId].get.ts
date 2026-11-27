/** GET /api/workshop/channels/:id/memory-graph/entities/:entityId —— 实体详情。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return service.entityDetail(channelId, getRouterParam(event, 'entityId')!)
})
