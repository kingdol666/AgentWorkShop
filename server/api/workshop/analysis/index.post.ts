/**
 * POST /api/workshop/analysis —— 人工/界面保存分析结果(管道页「保存为分析结果」)。
 * 此前 analysis_reports 只有 Agent 面(analysis_save)可写;本路由补齐用户面,
 * body: { line_id, title, category?, summary?, conclusions?, report?, metrics?, context? }
 */
import { randomUUID } from 'node:crypto'
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { resolveUser } from '@/server/api/workshop/caller'
import { getDcwLineRepo } from '@/server/services/workshop/dcw/dcw-line.repo'
import { getAnalysisRepo } from '@/server/services/workshop/analysis/analysis.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const lineId = String(body.line_id ?? '').trim()
  const title = String(body.title ?? '').trim()
  if (!lineId) throw new AppError(400, 'VALIDATION_ERROR' as never, 'line_id 必填。')
  if (!title) throw new AppError(400, 'VALIDATION_ERROR' as never, 'title 必填。')
  const repo = getAnalysisRepo()
  const id = `ar-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const context = (body.context ?? {}) as Record<string, unknown>
  repo.insert({
    id,
    lineId,
    lineName: getDcwLineRepo().byId(lineId)?.name ?? '',
    title: title.slice(0, 200),
    category: String(body.category ?? 'eda-pipeline').slice(0, 60),
    summary: String(body.summary ?? '').slice(0, 500),
    conclusions: Array.isArray(body.conclusions) ? (body.conclusions as unknown[]).map(c => String(c)) : [],
    report: String(body.report ?? ''),
    metrics: (body.metrics ?? {}) as Record<string, unknown>,
    recipeId: String(body.recipe_id ?? ''),
    recipeVersion: String(body.recipe_version ?? ''),
    windowFrom: body.window_from ? String(body.window_from) : null,
    windowTo: body.window_to ? String(body.window_to) : null,
    dataSources: String(body.data_sources ?? ''),
    context,
    channelId: '',
    channelName: '',
    actor: user.id,
    actorName: user.name,
    createdAt: now,
  })
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'analysis.save', kind: 'system', targetKind: 'analysis-report', targetId: id,
    summary: `保存分析结果「${title.slice(0, 60)}」`,
  })
  return { id, report: repo.get(id) ?? null }
})
