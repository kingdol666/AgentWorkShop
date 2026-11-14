/**
 * GET /api/workshop/channels/:id/products - list products bound to a channel.
 * Channel visibility is enforced before exposing the binding set.
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { createChannelProductBindingRepo } from '@/server/services/workshop/db/channel-product-binding.repo'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)

  const repo = createChannelProductBindingRepo(manager.deps.db)
  return {
    channelId,
    productIds: repo.listByChannel(channelId).map(binding => binding.productId),
    revision: repo.getRevision(channelId),
  }
})
