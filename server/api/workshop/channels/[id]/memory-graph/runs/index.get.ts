/** GET /api/workshop/channels/:id/memory-graph/runs —— 整理运行台账。 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  return { items: service.runs(channelId, Number(getQuery(event).limit ?? 30)) }
})
