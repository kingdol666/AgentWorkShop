/** POST /api/workshop/channels/:id/memory-graph/merge-candidates/:candidateId/accept */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  return service.acceptCandidate(channelId, getRouterParam(event, 'candidateId')!, actor)
})
