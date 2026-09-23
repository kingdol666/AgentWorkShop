/**
 * POST /api/workshop/channels/:id/members/leave —— 退出群聊。
 *
 * owner **不能**退出(409 OWNER_CANNOT_LEAVE):只能转移 owner 或删除 Channel(§13.7)。
 * 退出后立即失去:读、发言、审批、通知补拉;名下 pending 投递进入 cancelled。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const row = manager.groupChat.members.findOne(channelId, user.id)
  const result = manager.leaveChannel(channelId, user)
  if (row) manager.publishChatMember(channelId, { ...row, status: 'left' }, 'left', user.id)
  return result
})
