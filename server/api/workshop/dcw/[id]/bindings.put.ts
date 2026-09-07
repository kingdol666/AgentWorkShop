/**
 * PUT /api/workshop/dcw/:id/bindings —— 整体设定数控节点的绑定设备列表(多对多)。
 * body: { deviceIds: string[] }(全量替换,去重,逐一校验设备存在;(节点,设备)对唯一)
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '../../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // 产线权限:设备孪生绑定=操控能力
  requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')
  const body = await readBody<{ deviceIds?: string[] }>(event) ?? {}
  const node = getDcwController().setDeviceBindings(id, Array.isArray(body.deviceIds) ? body.deviceIds : [])
  return { node: node.toView() }
})
