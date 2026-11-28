/** PATCH /api/workshop/channels/:id/memory-graph/settings —— 开关自动整理（owner/admin）。 */
import { readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphSettingsSchema } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphSettingsSchema))
  return service.updateSettings(channelId, body as Record<string, unknown>, actor)
})
