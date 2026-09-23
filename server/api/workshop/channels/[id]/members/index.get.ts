/**
 * GET /api/workshop/channels/:id/members —— 群成员列表(投影)。
 *
 * 返回:稳定 userId + 展示名 + role + status + joinedAt/leftAt。
 * **不返回** token、工作目录、Harness 凭据(§13.1)。
 * 鉴权:requireChannelMember(成员可见名册)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.requireChannelMember(channelId, user)
  return {
    channelId,
    members: manager.listChannelMembersProjected(channelId),
    permissions: manager.channelPermissionsOf(channelId, user),
  }
})
