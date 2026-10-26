/**
 * EDA 图表配置模板 repo —— 用户把「图型 + 编码字段 + 后处理代码」存成命名模板,
 * 换一份数据选模板即可快速复绘(管道页 Step4)。owner 私有,CRUD 全走本模块。
 */
import { randomUUID } from 'node:crypto'
import { edaDb } from './eda-db'
import { AppError } from '@/server/utils/errors'
import { recordOps } from '../ops/ops'
import type { ResolvedUser } from '@/server/api/workshop/caller'

export interface ChartTemplateInput {
  name: string
  description?: string
  chartType: string
  config: Record<string, unknown>
}

export interface ChartTemplateRow {
  id: string
  name: string
  description: string
  chartType: string
  config: Record<string, unknown>
  ownerId: string
  createdAt: string
  updatedAt: string
}

export const CHART_TEMPLATE_TYPES = new Set(['line', 'bar', 'scatter', 'pie', 'histogram'])

function rowToTemplate(r: Record<string, unknown>): ChartTemplateRow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    chartType: String(r.chart_type),
    config: JSON.parse(String(r.config_json ?? '{}')) as Record<string, unknown>,
    ownerId: String(r.owner_user_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export function createTemplate(user: ResolvedUser, input: ChartTemplateInput): ChartTemplateRow {
  const name = input.name.trim()
  if (!name) throw new AppError(400, 'VALIDATION_ERROR' as never, '模板名必填。')
  if (!CHART_TEMPLATE_TYPES.has(input.chartType)) throw new AppError(400, 'VALIDATION_ERROR' as never, `不支持的图型: ${input.chartType}`)
  const id = `et-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_chart_templates (id, name, description, chart_type, config_json, owner_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name.slice(0, 120), (input.description ?? '').slice(0, 500), input.chartType,
      JSON.stringify(input.config ?? {}), user.id, now, now)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'eda.template.save', kind: 'system', targetKind: 'eda-chart-template', targetId: id,
    summary: `保存图表模板「${name}」(${input.chartType})`,
  })
  return templateById(user, id)!
}

export function templateById(user: ResolvedUser, id: string): ChartTemplateRow | undefined {
  const r = edaDb().prepare('SELECT * FROM eda_chart_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return undefined
  const row = rowToTemplate(r)
  if (row.ownerId !== user.id && user.role !== 'admin') throw new AppError(403, 'FORBIDDEN' as never, '仅 owner 或管理员可读取该模板。')
  return row
}

export function listTemplates(user: ResolvedUser): ChartTemplateRow[] {
  const rows = user.role === 'admin'
    ? edaDb().prepare('SELECT * FROM eda_chart_templates ORDER BY updated_at DESC').all() as Record<string, unknown>[]
    : edaDb().prepare('SELECT * FROM eda_chart_templates WHERE owner_user_id = ? ORDER BY updated_at DESC').all(user.id) as Record<string, unknown>[]
  return rows.map(rowToTemplate)
}

export function updateTemplate(user: ResolvedUser, id: string, patch: Partial<ChartTemplateInput>): ChartTemplateRow {
  const existing = templateById(user, id)
  if (!existing) throw new AppError(404, 'NOT_FOUND' as never, `模板不存在: ${id}`)
  if (existing.ownerId !== user.id && user.role !== 'admin') throw new AppError(403, 'FORBIDDEN' as never, '仅 owner 或管理员可修改该模板。')
  const name = (patch.name ?? existing.name).trim().slice(0, 120)
  if (!name) throw new AppError(400, 'VALIDATION_ERROR' as never, '模板名必填。')
  const chartType = patch.chartType ?? existing.chartType
  if (!CHART_TEMPLATE_TYPES.has(chartType)) throw new AppError(400, 'VALIDATION_ERROR' as never, `不支持的图型: ${chartType}`)
  edaDb().prepare(`UPDATE eda_chart_templates SET name = ?, description = ?, chart_type = ?, config_json = ?, updated_at = ? WHERE id = ?`)
    .run(name, (patch.description ?? existing.description).slice(0, 500), chartType,
      JSON.stringify(patch.config ?? existing.config), new Date().toISOString(), id)
  return templateById(user, id)!
}

export function deleteTemplate(user: ResolvedUser, id: string): void {
  const existing = templateById(user, id)
  if (!existing) throw new AppError(404, 'NOT_FOUND' as never, `模板不存在: ${id}`)
  if (existing.ownerId !== user.id && user.role !== 'admin') throw new AppError(403, 'FORBIDDEN' as never, '仅 owner 或管理员可删除该模板。')
  edaDb().prepare('DELETE FROM eda_chart_templates WHERE id = ?').run(id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'eda.template.delete', kind: 'system', targetKind: 'eda-chart-template', targetId: id,
    summary: `删除图表模板「${existing.name}」`,
  })
}
