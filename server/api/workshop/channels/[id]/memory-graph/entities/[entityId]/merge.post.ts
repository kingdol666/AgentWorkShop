/** POST /api/workshop/channels/:id/memory-graph/entities/:entityId/merge —— 合并到目标实体。 */
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphMergeSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphMergeSchema))
  return service.mergeEntity(channelId, getRouterParam(event, 'entityId')!, body.targetId, actor)
})
