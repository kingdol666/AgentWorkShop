/**
 * DELETE /api/workshop/projects/:id/channels/:channelId —— 用户解绑（只解绑，不删 Channel）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  getProjectService().unbindChannel(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'channelId')!,
    user,
  )
  return { ok: true }
})
