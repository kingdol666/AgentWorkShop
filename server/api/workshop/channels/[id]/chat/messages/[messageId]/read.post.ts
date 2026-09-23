/**
 * POST /api/workshop/channels/:id/chat/messages/:messageId/read —— 标记该消息相关的
 * 定向通知为已读(被 @ 的用户点开群聊即视为已读)。
 *
 * 鉴权:requireChannelMember;只能标记**自己**的通知(不接受 body 里的 userId)。
 * 幂等:重复调用返回 count=0,不报错。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const messageId = getRouterParam(event, 'messageId')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.requireChannelMember(channelId, user)
  // 按频道范围收敛未读:该用户在该 Channel 的定向通知(mention/agent_reply)即视为已读
  const result = manager.markNotificationsRead(user.id, { channelId })
  return { ok: true, channelId, messageId, ...result }
})
