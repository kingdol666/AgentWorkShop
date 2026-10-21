/**
 * GET /api/workshop/eda/runs —— run 台账(EDA-enterprise E1 用户面)。
 * query: line_id? recipe_id? outcome?(open|good|bad|scrapped) from? to?(ISO) limit? offset?
 * 可见性 = 产线可读(readonly+;admin 全量)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { listEdaRuns } from '@/server/services/workshop/eda/eda-run.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event) as Record<string, string | undefined>
  const lineId = q.line_id?.trim() || undefined
  if (lineId && lineMode(user, lineId) === 'none') {
    return { runs: [], total: 0 }
  }
  const { runs, total } = listEdaRuns({
    lineId,
    recipeId: q.recipe_id?.trim() || undefined,
    outcome: q.outcome?.trim() || undefined,
    from: q.from?.trim() || undefined,
    to: q.to?.trim() || undefined,
    label: q.label?.trim() || undefined,
    limit: Number(q.limit) || 50,
    offset: Number(q.offset) || 0,
  })
  const filtered = lineId ? runs : runs.filter(r => lineMode(user, r.lineId) !== 'none')
  return { runs: filtered, total: lineId ? total : filtered.length }
})
