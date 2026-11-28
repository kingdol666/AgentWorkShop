/** POST /api/workshop/channels/:id/memory-graph/edges/:edgeId/reject —— 人工否证（失效不删除）。 */
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphRejectSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphRejectSchema))
  return service.rejectEdge(channelId, getRouterParam(event, 'edgeId')!, body as Record<string, unknown>, actor)
})
