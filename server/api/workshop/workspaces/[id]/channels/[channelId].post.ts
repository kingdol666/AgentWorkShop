/**
 * POST /api/workshop/workspaces/:id/channels/:channelId —— 挂载 channel(须为本人的 channel)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const workspaceId = getRouterParam(event, 'id')!
  const channelId = getRouterParam(event, 'channelId')!
  getWorkshopManager().mountChannelToWorkspace(user.id, workspaceId, channelId)
  return { ok: true, workspaceId, channelId }
})
