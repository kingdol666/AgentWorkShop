/**
 * GET /api/workshop/channels/:id/memories/experience-stats —— RSI 经验看板(WP-A5,只读)。
 *
 * 返回本 channel 经验条目的生命周期/作用域/极性分布 + 最近 20 条摘要。
 * 鉴权:频道 owner/admin(与 /memories 面同口径)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  return manager.experienceOverview(channelId)
})
