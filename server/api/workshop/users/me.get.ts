/**
 * GET /api/workshop/users/me —— 当前用户信息(Bearer 用户 token)。
 * 附带资源统计(owned channels/templates/teams/workspaces)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../caller'

export default defineApiHandler(async (event) => {
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channels = manager.listChannelsForUser(user.id)
  return {
    id: user.id,
    name: user.name,
    createdAt: user.createdAt,
    stats: {
      ownedChannels: channels.filter(c => c.ownerUserId === user.id).length,
      legacyChannels: channels.filter(c => c.ownerUserId === null).length,
      workspaces: manager.listWorkspaces(user.id).length,
    },
  }
})
