/**
 * PUT /api/workshop/channels/:id/products - replace the channel's product set.
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getDcwProductRepo } from '@/server/services/workshop/dcw/dcw-product.repo'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { createChannelProductBindingRepo } from '@/server/services/workshop/db/channel-product-binding.repo'
import { AppError } from '@/server/utils/errors'

const schema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  productIds: z.array(z.string().trim().min(1)).max(100),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  const manager = getWorkshopManager()
  const channel = manager.requireChannelOwner(channelId, user, 'channel')

  const ids = [...new Set(body.productIds)]
  const products = ids.map((id) => {
    const product = getDcwProductRepo().byId(id)
    if (!product) throw new AppError(404, 'NOT_FOUND', `产品不存在: ${id}`)
    if (!product.lineId) throw new AppError(400, 'PRODUCT_LINE_REQUIRED', `产品 ${id} 未绑定产线,不能绑定到 Channel`)
    requireLineMode(user, product.lineId, 'readonly')
    return product
  })
  const lineIds = new Set(products.map(product => product.lineId))
  if (lineIds.size > 1) {
    throw new AppError(400, 'CHANNEL_PRODUCTS_LINE_MISMATCH', '一个 Channel 的产品必须属于同一条产线')
  }
  const selectedLineId = products[0]?.lineId
  if (selectedLineId && channel.lineId && selectedLineId !== channel.lineId) {
    throw new AppError(400, 'CHANNEL_PRODUCT_CHANNEL_LINE_MISMATCH', 'Channel 所绑定的兼容产线与产品产线不一致')
  }

  const repo = createChannelProductBindingRepo(manager.deps.db)
  const { revision } = repo.replaceForChannel(channelId, ids, body.expectedRevision)
  return { channelId, productIds: repo.listByChannel(channelId).map(binding => binding.productId), revision }
})
