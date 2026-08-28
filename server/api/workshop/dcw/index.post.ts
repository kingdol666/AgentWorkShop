/**
 * POST /api/workshop/dcw —— 创建写控制节点。
 */
import { readBody } from 'h3'
import type { DcwCreateInput } from '@/server/services/workshop/dcw/dcw-controller'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<DcwCreateInput>(event) ?? {}
  const node = getDcwController().create(body)
  return { node: node.toView() }
})
