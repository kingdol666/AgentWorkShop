/** GET /api/workshop/channels/:id/memory-graph/communities/:communityId —— 社区详情。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return service.communityDetail(channelId, getRouterParam(event, 'communityId')!)
})
