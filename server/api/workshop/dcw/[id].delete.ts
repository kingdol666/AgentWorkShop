/**
 * DELETE /api/workshop/dcw/:id —— 删除写控制节点。
 * R3:admin/editor 才可执行;approvalGate 开启时走双人复核(同 apply 口径)。
 */
import { getRouterParam, readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // DELETE 语义下 body 常为空:approvalId 亦接受查询参数(?approvalId=…)
  const body = await readBody<{ approvalId?: string }>(event).catch(() => ({})) ?? {}
  const q = getQuery(event)
  const approvalId = body.approvalId ?? (typeof q.approvalId === 'string' ? q.approvalId : undefined)
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'dcw.delete', targetId: id, summary: `删除写控制节点 ${id}` }, approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  getDcwController().remove(id)
  // R1:删除写控制节点留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'dcw.delete', targetKind: 'dcw-node', targetId: id })
  return { deleted: true }
})
