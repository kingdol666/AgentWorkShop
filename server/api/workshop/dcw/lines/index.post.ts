/**
 * POST /api/workshop/dcw/lines —— 新建产线。
 * 缺省光晕色按创建序取色板(1号蓝 2号黄…);可显式指定 color。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { recordOps } from '@/server/services/workshop/ops/ops'
import type { LineInput } from '#shared/dcw-protocol'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<LineInput>(event) ?? { name: '' }
  const line = getDcwController().createLine(body)
  broadcastSceneEvent('dcw.node.changed', { op: 'updated', node: null, lineId: line.id })
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'line.create',
    kind: 'line',
    targetKind: 'line',
    targetId: line.id,
    summary: `新建产线「${line.name}」`,
    lineId: line.id,
  })
  return { line }
})
