/**
 * GET /api/workshop/channels/:id/memory-blocks —— 核心块列表（批次 J）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { listBlocks, scopeIdOfChannel } from '../../../../../services/workshop/memory/blocks'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  return { items: listBlocks(getAmlRuntime().db, [scopeIdOfChannel(channelId)]) }
})
