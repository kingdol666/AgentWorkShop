/**
 * POST /api/workshop/dcw/:id/test —— 存量节点连接测试。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // 产线权限:连接测试触发真实驱动交互,需「可操控」
  requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')
  return { test: await getDcwController().testNode(id) }
})
