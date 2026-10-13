/**
 * DELETE /api/workshop/analysis/:id —— 删除分析报告(仅 admin;台账 Agent 面无删,清污数据走此口)。
 */
import { getRouterParam } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAnalysisRepo } from '@/server/services/workshop/analysis/analysis.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  const id = getRouterParam(event, 'id')!
  const report = getAnalysisRepo().get(id)
  if (!report) throw new AppError(404, 'NOT_FOUND', `分析报告不存在: ${id}`)
  getAnalysisRepo().remove(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'analysis.delete',
    kind: 'analysis',
    targetKind: 'analysis',
    targetId: id,
    lineId: report.lineId,
    recipeId: report.recipeId,
    summary: `删除分析报告「${report.title}」(产线「${report.lineName || report.lineId || '-'}」)`,
  })
  return { ok: true }
})
