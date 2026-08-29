/**
 * DELETE /api/workshop/dcw/lines/:id —— 删除产线。
 * 自动停止运行窗口;旗下节点/产品/配方解除挂载(lineId=''),历史数据保留。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  await getDcwController().removeLine(id)
  return { ok: true }
})
