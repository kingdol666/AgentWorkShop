/**
 * GET /api/workshop/eda/spc?line_id= —— 控制图清单(产线可读;注册走 index.post.ts)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listSpcCharts } from '@/server/services/workshop/eda/spc'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const charts = listSpcCharts(user, q.line_id ? String(q.line_id) : undefined)
  return { charts, count: charts.length }
})
