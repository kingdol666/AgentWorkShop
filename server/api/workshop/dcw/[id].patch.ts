/**
 * PATCH /api/workshop/dcw/:id —— 单节点参数(名称/驱动/保写周期/量程/启停/落点)。
 */
import { getRouterParam, readBody } from 'h3'
import type { DcwPatchInput } from '@/server/services/workshop/dcw/dcw-controller'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<DcwPatchInput>(event) ?? {}
  const node = getDcwController().patch(id, body)
  return { node: node.toView() }
})
