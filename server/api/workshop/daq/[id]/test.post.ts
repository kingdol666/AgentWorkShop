/**
 * POST /api/workshop/daq/:id/test —— 存量节点连接测试(用节点已保存的驱动参数)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const test = await getDaqController().testNode(id)
  return { test }
})
