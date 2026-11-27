/** POST /api/workshop/channels/:id/memory-graph/entities/:entityId/restore —— 恢复软删实体。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  return service.restoreEntity(channelId, getRouterParam(event, 'entityId')!, actor)
})
