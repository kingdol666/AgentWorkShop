/**
 * GET /api/workshop/eda/features —— 特征仓库查询(query: run_id?/node_id?/violated?/limit?)。
 * 无 run_id 时按产线可见性过滤(join eda_runs)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { listFeatures } from '@/server/services/workshop/eda/features'
import { edaRunById } from '@/server/services/workshop/eda/eda-run.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  let rows = listFeatures({
    runId: q.run_id ? String(q.run_id) : undefined,
    nodeId: q.node_id ? String(q.node_id) : undefined,
    violated: q.violated == null || q.violated === '' ? undefined : String(q.violated) === '1',
    limit: Number(q.limit) || 100,
  })
  if (!q.run_id) {
    rows = rows.filter((f) => {
      const run = edaRunById(f.runId)
      return run && lineMode(user, run.lineId) !== 'none'
    })
  }
  return { features: rows, count: rows.length }
})
