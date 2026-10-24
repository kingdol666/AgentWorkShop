/**
 * POST /api/workshop/optimization/recommendations/:id/crosscheck —— 候选互校(SW4)。
 * 归属:建议所属运行的 binding agent 可见性(D16);先决失败给可定位错误码。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'
import { getRunRepo } from '@/server/services/workshop/optimization/run.repo'
import { runCrosscheck, getCrosscheckRepo, deriveDualState } from '@/server/services/workshop/optimization/crosscheck.service'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const rec = getRunRepo().getRecommendation(id)
  if (!rec) throw createError({ statusCode: 404, statusMessage: `建议 ${id} 不存在` })
  assertOptimizationAccess(user, 'crosscheck', { kind: 'recommendation', runId: rec.runId })
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>) ?? {}
  const row = await runCrosscheck(id)
  recordConfigAction(user, 'optimizer.crosscheck.run', { kind: 'optimizer_crosscheck', id: row.id },
    `候选互校 ${id}:${row.verdict}(maxDev=${row.maxDevDimensionless === null ? 'n/a' : row.maxDevDimensionless.toExponential(3)})`,
    { recommendationId: id, runId: rec.runId, verdict: row.verdict, rowHash: row.rowHash.slice(0, 16) })
  const dual = deriveDualState(id)
  return {
    crosscheck: row,
    dual,
    history: getCrosscheckRepo().listForRecommendation(id, Number(body.limit ?? 10)),
  }
})
