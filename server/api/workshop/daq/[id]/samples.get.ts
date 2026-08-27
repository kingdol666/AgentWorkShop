/**
 * GET /api/workshop/daq/:id/samples —— 节点历史(时序库)。
 * query: from?/to?(epoch ms)、bucketMs?(降采样桶宽,给出返回桶聚合)、limit?(默认 500)
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
  const points = await getDaqController().samples(id, {
    fromMs: num('from'),
    toMs: num('to'),
    bucketMs: num('bucketMs'),
    limit: num('limit'),
  })
  return { points }
})
