/**
 * DELETE /api/workshop/daq/:id —— 删除数采节点(广播 removed;绑定设备不受影响)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  getDaqController().remove(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.node.delete',
    kind: 'daq',
    targetKind: 'daq-node',
    targetId: id,
    summary: `删除数采节点「${node?.name ?? id}」`,
    lineId: node?.lineId ?? '',
  })
  return { id }
})
