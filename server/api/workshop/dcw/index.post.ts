/**
 * POST /api/workshop/dcw —— 创建写控制节点。
 */
import { readBody } from 'h3'
import type { DcwCreateInput } from '@/server/services/workshop/dcw/dcw-controller'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<DcwCreateInput>(event) ?? {}
  const node = getDcwController().create(body)
  // R1:创建写控制节点(获得直写物理设备能力的入口)留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'dcw.create', targetKind: 'dcw-node', targetId: node.id, detail: { name: node.name } })
  return { node: node.toView() }
})
