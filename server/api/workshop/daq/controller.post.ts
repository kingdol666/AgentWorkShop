/**
 * POST /api/workshop/daq/controller —— 采集总控:{ action: 'start'|'stop'|'config', defaultIntervalMs?, defaultPublishIntervalMs? }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqBroadcast, getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqBroadcast(broadcastSceneEvent)
  const ctrl = getDaqController()
  const body = await readBody<{ action?: 'start' | 'stop' | 'config', defaultIntervalMs?: number, defaultPublishIntervalMs?: number }>(event) ?? {}
  switch (body.action) {
    case 'start':
      return { controller: ctrl.startAll() }
    case 'stop':
      return { controller: ctrl.stopAll() }
    case 'config':
      return { controller: ctrl.configure({ defaultIntervalMs: body.defaultIntervalMs, defaultPublishIntervalMs: body.defaultPublishIntervalMs }) }
    default:
      return { controller: ctrl.controllerState() }
  }
})
