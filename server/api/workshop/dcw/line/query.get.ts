/**
 * GET /api/workshop/dcw/line/query —— 产线数据查询(产品/配方/工艺参数/时间/间隔)。
 * qs: productId, recipeId, paramKey, from(epoch ms), to, bucketMs, limit
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const q = getQuery(event)
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? n : undefined
  }
  const result = await getDcwController().lineQuery({
    productId: q.productId ? String(q.productId) : undefined,
    recipeId: q.recipeId ? String(q.recipeId) : undefined,
    paramKey: q.paramKey ? String(q.paramKey) : undefined,
    fromMs: num(q.from),
    toMs: num(q.to),
    bucketMs: num(q.bucketMs),
    limit: num(q.limit),
  })
  return result
})
