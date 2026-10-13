/**
 * GET /api/workshop/analysis/:id —— 分析报告详情(含完整正文;产线可见性校验)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { resolveUser } from '@/server/api/workshop/caller'
import { visibleLineIds, lineMode } from '@/server/services/workshop/permissions'
import { getAnalysisRepo } from '@/server/services/workshop/analysis/analysis.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const report = getAnalysisRepo().get(id)
  if (!report) throw new AppError(404, 'NOT_FOUND', `分析报告不存在: ${id}`)
  if (report.lineId) {
    const visible = visibleLineIds(user)
    if (visible && !visible.has(report.lineId)) {
      throw new AppError(403, 'LINE_FORBIDDEN', `无权查看产线「${report.lineName || report.lineId}」的分析报告`)
    }
  }
  // v27 编辑能力位(与列表端点同口径:admin 或产线 operate)
  const canEdit = user.role === 'admin' || (Boolean(report.lineId) && lineMode(user, report.lineId) === 'operate')
  return { report: { ...report, canEdit } }
})
