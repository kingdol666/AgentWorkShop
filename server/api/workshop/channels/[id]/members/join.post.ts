/**
 * POST /api/workshop/channels/:id/members/join —— 加入群聊。
 *
 * 资格(requireCanJoinChannel):
 *  - Channel 必须已开启群聊(chat_enabled=1)→ 否则 409 CHAT_DISABLED
 *  - 遗留无归属 Channel(owner NULL)→ 403 FORBIDDEN_LEGACY(不可自行加入)
 *  - visibility=private → 403 CHANNEL_PRIVATE(需 owner 邀请)
 *  - visibility=public:
 *      joinPolicy=open          → 直接 active
 *      joinPolicy=owner_approve → pending(需 owner 调 approve)
 *
 * 幂等:已是 active 成员时重复调用返回 active(不降级、不重置 generation)。
 * 退出后重新加入 → generation+1(旧 HITL 审批资格不恢复,§13.7)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const result = manager.joinChannel(channelId, user)
  const row = manager.groupChat.members.findOne(channelId, user.id)
  if (row) {
    manager.publishChatMember(channelId, row, result.status === 'pending' ? 'joined' : 'approved', user.id)
  }
  return { ...result, permissions: manager.channelPermissionsOf(channelId, user) }
})
