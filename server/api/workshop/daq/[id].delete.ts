/**
 * DELETE /api/workshop/daq/:id —— 删除数采节点(广播 removed;绑定设备不受影响)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqBroadcast, getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'

export default defineApiHandler((event) => {
  resolveUser(event)
  bindDaqBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  getDaqController().remove(id)
  return { id }
})
