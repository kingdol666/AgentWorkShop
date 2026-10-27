/**
 * DELETE /api/workshop/dcw/products/:id —— 删除产品(运行中拒绝)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { requireLineMode } from '@/server/services/workshop/permissions'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const ctrl = getDcwController()
  const product = ctrl.listProducts().find(p => p.id === id)
  requireLineMode(user, product?.lineId ?? null, 'operate')
  ctrl.removeProduct(id)
  return { deleted: true }
})
