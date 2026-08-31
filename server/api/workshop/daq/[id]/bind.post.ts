/**
 * POST /api/workshop/daq/:id/bind —— 数采节点 ↔ 设备孪生绑定(端到端集成可视化)。
 * body: { deviceId: string | null }(null = 解绑;绑定后通道值实时回写设备 telemetry)
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ deviceId?: string | null }>(event) ?? {}
  const node = getDaqController().bind(id, body.deviceId ?? null)
  return { node: node.toView() }
})
