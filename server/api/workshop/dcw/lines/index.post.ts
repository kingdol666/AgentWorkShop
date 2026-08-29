/**
 * POST /api/workshop/dcw/lines —— 新建产线。
 * 缺省光晕色按创建序取色板(1号蓝 2号黄…);可显式指定 color。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import type { LineInput } from '#shared/dcw-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<LineInput>(event) ?? { name: '' }
  const line = getDcwController().createLine(body)
  broadcastSceneEvent('dcw.node.changed', { op: 'updated', node: null, lineId: line.id })
  return { line }
})
