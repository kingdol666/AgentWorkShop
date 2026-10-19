/**
 * DELETE /api/workshop/dcw/:id —— 删除写控制节点。
 * R3:admin/editor 才可执行;approvalGate 开启时走双人复核(同 apply 口径)。
 */
import { getQuery, getRouterParam, readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // DELETE 语义下 body 常为空:approvalId 亦接受查询参数(?approvalId=…)
  // 「无 body」与「body 解析失败」都退化为同一个显式标注的空对象(运行时仍是普通 {} 字面量,
  // 只被读取、不会被修改),避免裸 {} 把 body.approvalId 的类型抹成 {}。
  const emptyBody: { approvalId?: string } = {}
  const body = await readBody<{ approvalId?: string }>(event).catch(() => emptyBody) ?? emptyBody
  const q = getQuery(event)
  const approvalId = body.approvalId ?? (typeof q.approvalId === 'string' ? q.approvalId : undefined)
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'dcw.delete', targetId: id, summary: `删除写控制节点 ${id}` }, approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  // 删除前取归属产线(remove 后节点不可读),产线日志才能归档到正确产线
  const node0 = getDcwController().byId(id)
  getDcwController().remove(id)
  // R1:删除写控制节点留痕
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'dcw.delete', kind: 'line', targetKind: 'dcw-node', targetId: id,
    lineId: node0?.lineId ?? '',
    summary: `删除数控节点「${node0?.name ?? id}」${node0?.lineId ? `(产线 ${node0.lineId})` : ''}`,
    detail: { name: node0?.name ?? '', lineId: node0?.lineId ?? '' },
  })
  return { deleted: true }
})
