/**
 * POST /api/workshop/dcw/controller —— 网关总控:{ action: 'start' | 'stop' }。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  const body = await readBody<{ action?: 'start' | 'stop' }>(event) ?? {}
  if (body.action === 'stop') return { controller: ctrl.stopAll() }
  return { controller: ctrl.startAll() }
})
