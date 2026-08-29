/**
 * POST /api/workshop/dcw/lines/:id/stop —— 停止该产线数据采集(关闭打标窗口;
 * 该产线数采节点置 offline)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  const run = getDcwController().lineStop(id)
  return { run, line: getDcwController().lineState(id) }
})
