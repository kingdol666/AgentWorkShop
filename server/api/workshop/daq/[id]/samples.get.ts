/**
 * GET /api/workshop/daq/:id/samples —— 节点历史(时序库)。
 * query: from?/to?(epoch ms)、bucketMs?(降采样桶宽;缺省 15000ms=15s,可调 1000~3600000)、limit?(默认 500)
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const num = (k: string): number | undefined => (q[k] != null && !Number.isNaN(Number(q[k])) ? Number(q[k]) : undefined)
  // 时间间隔参数(bucketMs):缺省 15s;可调,下限 1s(降采样桶聚合;返回体携带实际生效间隔)
  const rawBucket = num('bucketMs')
  const bucketMs = rawBucket == null ? 15_000 : Math.max(1000, Math.min(3_600_000, Math.round(rawBucket)))
  const points = await getDaqController().samples(id, {
    fromMs: num('from'),
    toMs: num('to'),
    bucketMs,
    limit: num('limit'),
  })
  return { points, bucketMs }
})
