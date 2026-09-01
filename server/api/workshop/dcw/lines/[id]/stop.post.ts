/**
 * POST /api/workshop/dcw/lines/:id/stop —— 停止该产线数据采集(关闭打标窗口;
 * 该产线数采节点置 offline)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getActiveLineRun } from '@/server/services/workshop/dcw/line-run'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  const active = getActiveLineRun(id)
  const run = getDcwController().lineStop(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'line.stop',
    kind: 'line',
    targetKind: 'line',
    targetId: id,
    summary: `产线停止采集:批次 ${active?.runId ?? run?.id ?? ''} 窗口关闭,样本不再打标`,
    lineId: id,
    productId: active?.productId ?? '',
    recipeId: active?.recipeId ?? '',
    detail: { runId: active?.runId ?? '' },
  })
  return { run, line: getDcwController().lineState(id) }
})
