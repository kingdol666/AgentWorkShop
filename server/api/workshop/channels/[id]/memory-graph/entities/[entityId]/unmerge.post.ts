/** POST /api/workshop/channels/:id/memory-graph/entities/:entityId/unmerge —— 取消合并。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  return service.unmergeEntity(channelId, getRouterParam(event, 'entityId')!, actor)
})
