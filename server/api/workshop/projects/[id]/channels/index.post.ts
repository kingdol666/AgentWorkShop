/**
 * POST /api/workshop/projects/:id/channels —— 用户绑定已有 Channel。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { zValidator } from '../../../../../utils/validate'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

const schema = z.object({
  channelId: z.string().min(1),
  charter: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().bindChannel(getRouterParam(event, 'id')!, body.channelId, user, body.charter ?? '')
})
