/** PATCH /api/workshop/channels/:id/memory-graph/entities/:entityId —— 人工编辑（CAS）。 */
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphEntityUpdateSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphEntityUpdateSchema))
  return service.updateEntity(channelId, getRouterParam(event, 'entityId')!, body as Record<string, unknown>, actor)
})
