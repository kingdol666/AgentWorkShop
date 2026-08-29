/**
 * GET /api/workshop/dcw/lines —— 产线列表 + 各产线运行状态。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  return { lines: ctrl.listLines(), states: ctrl.allLineStates() }
})
