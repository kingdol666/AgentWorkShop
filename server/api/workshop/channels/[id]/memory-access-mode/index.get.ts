/**
 * GET /api/workshop/channels/:id/memory-access-mode —— 当前记忆访问策略（批次 I）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const row = manager.deps.db.prepare('SELECT memory_access_mode AS mode FROM channels WHERE id = ?').get(channelId) as { mode?: string } | undefined
  return { mode: row?.mode ?? 'inherit' }
})
