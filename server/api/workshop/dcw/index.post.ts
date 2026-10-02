/**
 * POST /api/workshop/dcw —— 创建写控制节点。
 * 权限模型 v3:仅 admin(直写物理设备的入口);lineId 提供时校验产线存在。
 */
import { readBody } from 'h3'
import type { DcwCreateInput } from '@/server/services/workshop/dcw/dcw-controller'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { audit } from '@/server/services/workshop/ops/ops'
import { getDcwLineRepo } from '@/server/services/workshop/dcw/dcw-line.repo'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<DcwCreateInput>(event) ?? {}
  if (body.lineId && !getDcwLineRepo().byId(body.lineId)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产线不存在: ${body.lineId}`)
  }
  const node = getDcwController().create(body)
  // R1:创建写控制节点(获得直写物理设备能力的入口)留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'dcw.create', targetKind: 'dcw-node', targetId: node.id, detail: { name: node.name } })
  return { node: node.toView() }
})
