/** GET /api/workshop/channels/:id/memory-graph/merge-candidates —— 待合并候选。 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service } = graphContext(event, false)
  const status = String(getQuery(event).status ?? 'proposed')
  return { items: service.mergeCandidates(channelId, status) }
})
