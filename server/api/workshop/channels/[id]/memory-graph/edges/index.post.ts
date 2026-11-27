/** POST /api/workshop/channels/:id/memory-graph/edges —— 人工新建关系。 */
import { readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphEdgeCreateSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphEdgeCreateSchema))
  return service.createEdge(channelId, body as Record<string, unknown>, actor)
})
