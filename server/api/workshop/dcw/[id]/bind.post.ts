/**
 * POST /api/workshop/dcw/:id/bind —— 绑定/解绑设备孪生(body: { deviceId: string | null })。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ deviceId?: string | null }>(event) ?? {}
  const node = getDcwController().bind(id, body.deviceId ?? null)
  return { node: node.toView() }
})
