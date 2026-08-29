/**
 * POST /api/workshop/dcw/lines/:id/start —— 该产线开跑(body: { recipeId })。
 * 门控:配方必归属本产线的产品且含工艺参数;激活窗口后本产线数采逐样本打标。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ recipeId?: string }>(event) ?? {}
  const run = await getDcwController().lineStart(id, String(body.recipeId ?? ''))
  return { run, line: getDcwController().lineState(id) }
})
