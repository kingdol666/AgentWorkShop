/**
 * GET /api/workshop/daq/:id/samples —— 节点历史(时序库)。
 * query: from?/to?(epoch ms)、bucketMs?(降采样桶宽;缺省 15000ms=15s,可调 1000~3600000)、limit?(默认 500)
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { daqRuntimeSettings } from '@/server/services/workshop/settings'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const num = (k: string): number | undefined => (q[k] != null && !Number.isNaN(Number(q[k])) ? Number(q[k]) : undefined)
  // 时间间隔参数(bucketMs):缺省与下限来自 daq.query.*(live 配置,热重载)
  const { defaultBucketMs, minBucketMs } = daqRuntimeSettings().query
  const rawBucket = num('bucketMs')
  const bucketMs = rawBucket == null ? defaultBucketMs : Math.max(minBucketMs, Math.min(3_600_000, Math.round(rawBucket)))
  const points = await getDaqController().samples(id, {
    fromMs: num('from'),
    toMs: num('to'),
    bucketMs,
    limit: num('limit'),
  })
  return { points, bucketMs }
})
