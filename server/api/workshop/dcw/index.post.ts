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
import { recordOps } from '@/server/services/workshop/ops/ops'
import { getDcwLineRepo } from '@/server/services/workshop/dcw/dcw-line.repo'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<DcwCreateInput>(event) ?? {}
  if (body.lineId && !getDcwLineRepo().byId(body.lineId)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产线不存在: ${body.lineId}`)
  }
  // P0-2(2026-11-08 生产审计):绑线写控节点必须显式 driver —— 缺省 mock 会造成
  // 「写入成功 + journal 留痕 + 设备零触达」的假闭环(既往 skill 实测教训)。
  if (body.lineId && !body.driver) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
      '绑定产线的写控节点必须显式指定 driver(如 modbus-tcp/opcua/mqtt/http);缺省 mock 驱动会造成假写入,已拒绝。演示节点请显式传 driver="mock"。')
  }
  const node = getDcwController().create(body)
  // R1:创建写控制节点(获得直写物理设备能力的入口)留痕;归属产线随行,产线日志可检索
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'dcw.create', kind: 'line', targetKind: 'dcw-node', targetId: node.id,
    lineId: node.lineId ?? '',
    summary: `创建数控节点「${node.name}」${node.lineId ? `(产线 ${node.lineId})` : '(未分配产线)'}`,
    detail: { name: node.name, lineId: node.lineId ?? '' },
  })
  return { node: node.toView() }
})
