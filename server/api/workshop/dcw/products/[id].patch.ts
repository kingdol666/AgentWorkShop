/**
 * PATCH /api/workshop/dcw/products/:id —— 编辑产品。
 */
import { getRouterParam, readBody } from 'h3'
import type { ProductInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Partial<ProductInput>>(event) ?? {}
  return { product: getDcwController().updateProduct(id, body) }
})
