/** PATCH /api/workshop/channels/:id/memory-graph/edges/:edgeId —— 人工编辑（CAS）。 */
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphEdgeUpdateSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphEdgeUpdateSchema))
  return service.updateEdge(channelId, getRouterParam(event, 'edgeId')!, body as Record<string, unknown>, actor)
})
