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
import { requireLineForResource } from '@/server/services/workshop/line-scope'

/** 报告正文/结构化上下文上限(防单条撑爆 SQLite 与列表渲染) */
const REPORT_MAX_CHARS = 1024 * 1024
const METRICS_MAX_BYTES = 256 * 1024
const clampJson = (v: unknown, maxBytes: number): Record<string, unknown> => {
  const obj = (v ?? {}) as Record<string, unknown>
  try {
    const text = JSON.stringify(obj)
    return text.length <= maxBytes ? obj : { truncated: true, bytes: text.length }
  }
  catch {
    return {}
  }
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const lineId = String(body.line_id ?? '').trim()
  const title = String(body.title ?? '').trim()
  if (!lineId) throw new AppError(400, 'VALIDATION_ERROR' as never, 'line_id 必填。')
  if (!title) throw new AppError(400, 'VALIDATION_ERROR' as never, 'title 必填。')
  // 写报告是产线维度操作:零授权用户不得向任意产线写入(污染审计轨)
  requireLineForResource(user, lineId, '分析报告', 'operate')
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
    report: String(body.report ?? '').slice(0, REPORT_MAX_CHARS),
    metrics: clampJson(body.metrics, METRICS_MAX_BYTES),
    recipeId: String(body.recipe_id ?? ''),
    recipeVersion: String(body.recipe_version ?? ''),
    windowFrom: body.window_from ? String(body.window_from) : null,
    windowTo: body.window_to ? String(body.window_to) : null,
    dataSources: String(body.data_sources ?? ''),
    context: clampJson(context, METRICS_MAX_BYTES),
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
