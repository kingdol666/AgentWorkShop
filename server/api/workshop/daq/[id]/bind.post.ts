/**
 * POST /api/workshop/daq/:id/bind —— 数采节点 ↔ 设备孪生绑定(端到端集成可视化)。
 * body: { deviceId: string | null }(null = 解绑;绑定后通道值实时回写设备 telemetry)
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // 产线权限:数采设备绑定=操控能力(绑定后通道值回写设备)
  requireLineMode(user, getDaqController().byId(id)?.lineId, 'operate')
  const body = await readBody<{ deviceId?: string | null }>(event) ?? {}
  const node = getDaqController().bind(id, body.deviceId ?? null)
  return { node: node.toView() }
})
