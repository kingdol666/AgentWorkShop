/**
 * DELETE /api/workshop/channels/:id/members/:userId —— owner 移除成员。
 *
 * 仅 owner(requireChannelOwner);不能移除 owner 自己(409)。
 * 移除后:该成员立即失去读/发言/审批/通知补拉;名下 pending 投递 → cancelled。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const row = manager.groupChat.members.findOne(channelId, userId)
  const result = manager.removeChannelMember(channelId, user, userId)
  if (row) manager.publishChatMember(channelId, { ...row, status: 'removed' }, 'removed', user.id)
  return result
})
