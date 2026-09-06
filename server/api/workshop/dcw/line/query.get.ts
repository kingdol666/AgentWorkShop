/**
 * GET /api/workshop/dcw/line/query —— 产线数据查询(产品/配方/工艺参数/时间/间隔)。
 * qs: productId, recipeId, paramKey, from(epoch ms), to, bucketMs, limit
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { visibleLineIds } from '@/server/services/workshop/permissions'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const q = getQuery(event)
  // 产线权限:产线查询仅限可见产线(admin/editor 不限)
  const visible = visibleLineIds(user)
  if (visible && (!q.lineId || !visible.has(String(q.lineId)))) {
    throw new AppError(403, 'LINE_FORBIDDEN', '无该产线权限:查询目标产线不在授权范围内')
  }
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? n : undefined
  }
  const result = await getDcwController().lineQuery({
    lineId: q.lineId ? String(q.lineId) : undefined,
    productId: q.productId ? String(q.productId) : undefined,
    recipeId: q.recipeId ? String(q.recipeId) : undefined,
    paramKey: q.paramKey ? String(q.paramKey) : undefined,
    nodeId: q.nodeId ? String(q.nodeId) : undefined,
    fromMs: num(q.from),
    toMs: num(q.to),
    bucketMs: num(q.bucketMs),
    limit: num(q.limit),
  })
  return result
})
