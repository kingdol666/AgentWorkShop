/**
 * POST /api/workshop/channels/:id/members/:userId/approve —— owner 批准 pending 成员。
 *
 * 仅 owner(requireChannelOwner);仅对 joinPolicy=owner_approve 产生的 pending 生效。
 * 已是 active → 幂等返回。
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
  const row = manager.approveMember(channelId, user, userId)
  manager.publishChatMember(channelId, row, 'approved', user.id)
  return { ok: true, member: { userId: row.userId, role: row.role, status: row.status, generation: row.generation } }
})
