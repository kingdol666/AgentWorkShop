/**
 * PATCH /api/workshop/analysis/:id —— 人工修订分析报告(v27 编辑面)。
 * 权限:admin,或对该报告产线有「可操控」(operate)的用户;readonly/无授权 403。
 * 可编辑字段:title/category/summary/conclusions/report/metrics/recipe_id/recipe_version/
 * window_from/window_to/data_sources(缺省 = 保留原值);修订归因固化进 updated_*。
 * Agent 面仍无改删 —— 编辑是带审计的人类管理操作(recordOps analysis.update)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { lineMode } from '@/server/services/workshop/permissions'
import { getAnalysisRepo } from '@/server/services/workshop/analysis/analysis.repo'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const repo = getAnalysisRepo()
  const report = repo.get(id)
  if (!report) throw new AppError(404, 'NOT_FOUND', `分析报告不存在: ${id}`)

  // 编辑权限:admin 或产线 operate(readonly/无授权不可改)
  const isAdmin = user.role === 'admin'
  if (!isAdmin && (!report.lineId || lineMode(user, report.lineId) !== 'operate')) {
    throw new AppError(403, 'ANALYSIS_FORBIDDEN', `无权修订该分析报告:需要产线「可操控」权限或 admin(报告产线 ${report.lineName || report.lineId || '-'})`)
  }

  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const str = (k: string): string | undefined => (body[k] === undefined ? undefined : String(body[k] ?? '').trim())
  const title = str('title')
  const summary = str('summary')
  if (title !== undefined && !title) throw new AppError(400, 'VALIDATION_ERROR', 'title 不能为空')
  if (summary !== undefined && !summary) throw new AppError(400, 'VALIDATION_ERROR', 'summary 不能为空')

  // 配方校验(与保存面同口径:存在且归属该产线)
  const recipeId = str('recipe_id')
  if (recipeId) {
    const recipe = getDcwRecipeRepo().list().find(r => r.id === recipeId)
    if (!recipe) throw new AppError(404, 'NOT_FOUND', `配方不存在: ${recipeId}`)
    if (recipe.lineId && report.lineId && recipe.lineId !== report.lineId) {
      throw new AppError(400, 'VALIDATION_ERROR', `配方「${recipe.name}」不属于该报告的产线`)
    }
  }

  // 时间窗归一:列内为本地 ISO(平台 toISOString 补丁),外部 Z 格式/epoch ms 归一后入库
  const timeArg = (k: string): string | null | undefined => {
    if (body[k] === undefined) return undefined
    const raw = String(body[k] ?? '').trim()
    if (!raw) return null
    const ms = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw)
    if (!Number.isFinite(ms)) throw new AppError(400, 'VALIDATION_ERROR', `${k} 时间格式无效(ISO 8601 或 epoch ms)`)
    return new Date(ms).toISOString()
  }

  const conclusions = body.conclusions === undefined
    ? undefined
    : (Array.isArray(body.conclusions) ? body.conclusions : String(body.conclusions ?? '').split('\n'))
        .map((x: unknown) => String(x).replace(/^[-*\d.\s]+/, '').trim())
        .filter(Boolean)
  let metrics: Record<string, unknown> | undefined
  if (body.metrics !== undefined && body.metrics !== null && String(body.metrics).trim() !== '') {
    try {
      metrics = typeof body.metrics === 'object' && !Array.isArray(body.metrics)
        ? (body.metrics as Record<string, unknown>)
        : JSON.parse(String(body.metrics))
    }
    catch {
      throw new AppError(400, 'VALIDATION_ERROR', 'metrics 需为 JSON 对象(或留空保留原值)')
    }
  }

  const updated = repo.update(id, {
    title: title ?? undefined,
    category: str('category') ?? undefined,
    summary: summary ?? undefined,
    conclusions,
    report: body.report === undefined ? undefined : String(body.report ?? ''),
    metrics,
    recipeId,
    recipeVersion: str('recipe_version'),
    windowFrom: timeArg('window_from'),
    windowTo: timeArg('window_to'),
    dataSources: str('data_sources'),
  }, { id: user.id, name: user.name })
  if (!updated) throw new AppError(404, 'NOT_FOUND', `分析报告不存在: ${id}`)

  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'analysis.update', kind: 'analysis', targetKind: 'analysis', targetId: id,
      lineId: updated.lineId, recipeId: updated.recipeId,
      summary: `人工修订分析报告「${updated.title}」(产线「${updated.lineName || updated.lineId || '-'}」)`,
    })
  }
  catch { /* 审计失败不阻断 */ }

  return { report: updated }
})
