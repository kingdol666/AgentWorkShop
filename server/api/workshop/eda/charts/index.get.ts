/**
 * GET /api/workshop/eda/charts —— 图表清单(B4 可见性:owner∪产线可读)。
 * query: line_id? mine?(1=只看我的) limit?
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listChartsFor } from '@/server/services/workshop/eda/chart-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const charts = listChartsFor(user, {
    lineId: q.line_id ? String(q.line_id) : undefined,
    mine: String(q.mine ?? '') === '1',
    limit: Number(q.limit) || 100,
  })
  return { charts, count: charts.length }
})
