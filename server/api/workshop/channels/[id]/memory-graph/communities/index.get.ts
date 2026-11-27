/** GET /api/workshop/channels/:id/memory-graph/communities —— 社区列表。 */
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return { items: service.communities(channelId) }
})
