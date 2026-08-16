/**
 * DELETE /api/workshop/workspaces/:id/channels/:channelId —— 移出 channel。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const workspaceId = getRouterParam(event, 'id')!
  const channelId = getRouterParam(event, 'channelId')!
  getWorkshopManager().unmountChannelFromWorkspace(user.id, workspaceId, channelId)
  return { ok: true, workspaceId, channelId }
})
