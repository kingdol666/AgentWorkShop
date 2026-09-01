/**
 * PATCH /api/workshop/daq/:id —— 单节点参数控制(名称/驱动/量程/预警带/周期/启停/场景落点)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController, type DaqPatchInput } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<DaqPatchInput>(event) ?? {}
  const node = getDaqController().patch(id, body)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.node.patch',
    kind: 'daq',
    targetKind: 'daq-node',
    targetId: id,
    summary: `修改数采节点「${node.name}」(${Object.keys(body).join('/') || '无变更'})`,
    lineId: node.lineId ?? '',
    detail: { keys: Object.keys(body) },
  })
  return { node: node.toView() }
})
