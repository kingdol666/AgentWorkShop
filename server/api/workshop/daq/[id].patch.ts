/**
 * PATCH /api/workshop/daq/:id —— 单节点参数控制(名称/驱动/量程/预警带/周期/启停/场景落点)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqBroadcast, getDaqController, type DaqPatchInput } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<DaqPatchInput>(event) ?? {}
  const node = getDaqController().patch(id, body)
  return { node: node.toView() }
})
