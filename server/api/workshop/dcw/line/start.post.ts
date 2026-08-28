/**
 * POST /api/workshop/dcw/line/start —— 产线开跑(body: { recipeId })。
 * 门控:开跑必设配方(Recipe 挂产品且含工艺参数);激活窗口后数采逐样本打标。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<{ recipeId?: string }>(event) ?? {}
  const run = await getDcwController().lineStart(String(body.recipeId ?? ''))
  return { run, line: getDcwController().lineState() }
})
