/**
 * POST /api/workshop/dcw/products —— 创建产品(body: { name, description? })。
 */
import { readBody } from 'h3'
import type { ProductInput } from '#shared/dcw-protocol'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  // 权限模型 v3:挂到产线的产品 → 对该线要求 operate;未挂线的全局产品 → 仅 admin
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<ProductInput>(event) ?? { name: '' }
  if (body.lineId) requireLineMode(user, body.lineId, 'operate')
  else requireRole(event)
  return { product: getDcwController().createProduct(body) }
})
