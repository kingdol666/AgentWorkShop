/**
 * POST /api/workshop/dcw/products —— 创建产品(body: { name, description? })。
 */
import { readBody } from 'h3'
import type { ProductInput } from '#shared/dcw-protocol'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<ProductInput>(event) ?? { name: '' }
  return { product: getDcwController().createProduct(body) }
})
