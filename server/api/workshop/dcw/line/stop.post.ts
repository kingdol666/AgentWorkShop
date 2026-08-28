/**
 * POST /api/workshop/dcw/line/stop —— 停止产线数据采集(关闭打标窗口)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const run = getDcwController().lineStop()
  return { run, line: getDcwController().lineState() }
})
