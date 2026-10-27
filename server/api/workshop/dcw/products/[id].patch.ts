/**
 * PATCH /api/workshop/dcw/products/:id —— 编辑产品。
 */
import { getRouterParam, readBody } from 'h3'
import type { ProductInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { requireLineMode } from '@/server/services/workshop/permissions'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Partial<ProductInput>>(event) ?? {}
  const ctrl = getDcwController()
  const prev = ctrl.listProducts().find(p => p.id === id)
  // 产品参数限界是四层写的联锁之一:改产品=改该线所有配方的写约束,须持 operate
  requireLineMode(user, prev?.lineId ?? null, 'operate')
  if (body.lineId) requireLineMode(user, String(body.lineId), 'operate')
  return { product: ctrl.updateProduct(id, body) }
})
