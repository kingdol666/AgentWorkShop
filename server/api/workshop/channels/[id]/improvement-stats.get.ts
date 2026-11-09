/**
 * GET /api/workshop/channels/:id/improvement-stats —— RSI 元层成效看板(WP-C3,只读)。
 *
 * 返回本 channel 按 action_kind 聚合的成功率(accepted+promoted 视为成功)。
 * 无动作时 `stats` 为空数组(不报错)。
 * 鉴权:频道 owner/admin(与 /memories 面同口径)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../caller'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  return manager.improvementOverview(channelId)
})
