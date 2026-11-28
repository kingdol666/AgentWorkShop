/** GET /api/workshop/channels/:id/memory-graph/settings —— 图谱自动整理设置。 */
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return service.settings(channelId)
})
