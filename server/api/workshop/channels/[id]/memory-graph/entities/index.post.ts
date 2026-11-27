/** POST /api/workshop/channels/:id/memory-graph/entities —— 人工新建实体。 */
import { readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphEntityCreateSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphEntityCreateSchema))
  return service.createEntity(channelId, body as Record<string, unknown>, actor)
})
