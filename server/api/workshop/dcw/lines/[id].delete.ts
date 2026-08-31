/**
 * DELETE /api/workshop/dcw/lines/:id —— 删除产线。
 * 自动停止运行窗口;?purge=1 连同旗下节点(含 Agent 绑定级联)/产品/配方一并删除,
 * 否则仅解除挂载(lineId=''),历史数据保留。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  const q = getQuery(event).purge
  const purge = q === '1' || q === 'true'
  await getDcwController().removeLine(id, { purge })
  return { ok: true, purged: purge }
})
