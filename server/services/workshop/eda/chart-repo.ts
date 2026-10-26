/**
 * eda_charts 仓储(plan1 M2,含 BLOCKER B4 修正):
 *
 * 读路径(B4 铁律):
 *  - private → 仅 owner / admin;
 *  - line    → owner / admin / 该产线 readonly 及以上(按 chart.lineId 判,不看请求参数);
 *  - public  → 首期不做;
 *  - 列表谓词 = owner==user OR 可见性判定(不能用裸 filterByLine——它会把 lineId=NULL
 *    的条目整条丢弃,owner 自己的私有无产线图表会从自己的列表里消失);
 *  - 看板包含 chart 时的读判定也必须走 canReadChart(防看板旁路,见 dashboard 侧)。
 * 写路径:owner / admin;visibility='line' 强制 line_id 非空。
 * 数据访问永不代理:普通图表只存查询参数快照,取数永远在客户端调 /daq/query 时按请求鉴权。
 * 唯一例外:pipeline 快照图表保存有界(≤2000 行)的转换后视图,供 Studio/Board 离线回放;
 * 快照必须钉在 line_id 上,读取仍走 canReadChart(owner/line 可见性),不接受无产线快照。
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'

export const CHART_VIZ_TYPES = ['trend', 'bar', 'scatter', 'table', 'kpi', 'histogram', 'pipeline'] as const
export type ChartVizType = typeof CHART_VIZ_TYPES[number]
const VISIBILITIES = ['private', 'line'] as const

export interface EdaChartRow {
  id: string
  title: string
  vizType: ChartVizType
  datasource: Record<string, unknown>
  encoding: Record<string, unknown>
  transform: Record<string, unknown>
  options: Record<string, unknown>
  annotations: unknown[]
  ownerUserId: string
  lineId: string | null
  visibility: 'private' | 'line'
  version: number
  createdAt: string
  updatedAt: string
}

function rowOf(r: Record<string, unknown>): EdaChartRow {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    vizType: String(r.viz_type ?? 'trend') as ChartVizType,
    datasource: safeObj(r.datasource_json),
    encoding: safeObj(r.encoding_json),
    transform: safeObj(r.transform_json),
    options: safeObj(r.options_json),
    annotations: safeArr(r.annotations_json),
    ownerUserId: String(r.owner_user_id ?? ''),
    lineId: r.line_id == null ? null : String(r.line_id),
    visibility: String(r.visibility ?? 'private') as EdaChartRow['visibility'],
    version: Number(r.version ?? 1),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}
function safeObj(text: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(text ?? '{}')) as Record<string, unknown>
  }
  catch {
    return {}
  }
}
function safeArr(text: unknown): unknown[] {
  try {
    return JSON.parse(String(text ?? '[]')) as unknown[]
  }
  catch {
    return []
  }
}

/** B4 读判定(单图;看板侧逐图复用) */
export function canReadChart(user: ResolvedUser, row: EdaChartRow): boolean {
  if (row.ownerUserId === user.id || user.role === 'admin') return true
  if (row.visibility === 'line' && row.lineId) return lineMode(user, row.lineId) !== 'none'
  return false
}

function canWriteChart(user: ResolvedUser, row: EdaChartRow): boolean {
  return row.ownerUserId === user.id || user.role === 'admin'
}

export function chartById(user: ResolvedUser, id: string): EdaChartRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_charts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  const row = rowOf(r)
  return canReadChart(user, row) ? row : null
}

export function listChartsFor(user: ResolvedUser, opts: { lineId?: string, mine?: boolean, limit?: number } = {}): EdaChartRow[] {
  const limit = Math.min(Math.max(Math.round(Number(opts.limit)) || 100, 1), 500)
  const rows = edaDb().prepare('SELECT * FROM eda_charts ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  return rows
    .map(rowOf)
    .filter(row => canReadChart(user, row))
    .filter(row => (opts.mine ? row.ownerUserId === user.id : true))
    .filter(row => (opts.lineId ? row.lineId === opts.lineId : true))
}

export interface ChartInput {
  title: string
  vizType: string
  datasource?: Record<string, unknown>
  encoding?: Record<string, unknown>
  transform?: Record<string, unknown>
  options?: Record<string, unknown>
  lineId?: string | null
  visibility?: string
}

function validateInput(input: ChartInput): void {
  if (!CHART_VIZ_TYPES.includes(input.vizType as ChartVizType)) {
    throw new Error(`viz_type 只支持 ${CHART_VIZ_TYPES.join('/')}(收到 ${input.vizType})`)
  }
  const vis = input.visibility ?? 'private'
  if (!VISIBILITIES.includes(vis as 'private' | 'line')) {
    throw new Error(`visibility 只支持 ${VISIBILITIES.join('/')}(public 首期不开放)`)
  }
  if (vis === 'line' && !input.lineId) {
    throw new Error('visibility=line 必须携带 line_id(B4:产线可见图必须钉在产线上)')
  }
  if (input.vizType === 'pipeline') {
    if (!input.lineId) throw new Error('pipeline 快照必须携带 line_id(B4 线域边界)')
    if (vis !== 'private') throw new Error('pipeline 快照仅支持 private(含客户端 rows,不做跨用户数据代理)')
    const dsLine = String((input.datasource as { line_id?: unknown } | undefined)?.line_id ?? '')
    if (!dsLine || dsLine !== input.lineId) throw new Error('pipeline 快照 datasource.line_id 必须与 line_id 一致')
    const rows = (input.options as { pipeline?: { rows?: unknown } } | undefined)?.pipeline?.rows
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('pipeline 快照缺少 rows')
    if (rows.length > 2000) throw new Error('pipeline 快照 rows 超过 2000 行上限')
  }
  else {
    // B4:普通图表只允许 template 这类配置引用,不得借 options 携带数据快照。
    const keys = Object.keys(input.options ?? {})
    const extra = keys.filter(key => key !== 'template')
    if (extra.length > 0) throw new Error(`非 pipeline 图表 options 不允许携带数据/扩展: ${extra.join(',')}`)
  }
}

export function createChart(user: ResolvedUser, input: ChartInput): EdaChartRow {
  validateInput(input)
  const id = `ec-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_charts (id, title, viz_type, datasource_json, encoding_json, transform_json, options_json, annotations_json, owner_user_id, line_id, visibility, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1, ?, ?)`)
    .run(id, input.title, input.vizType,
      JSON.stringify(input.datasource ?? {}), JSON.stringify(input.encoding ?? {}), JSON.stringify(input.transform ?? {}), JSON.stringify(input.options ?? {}),
      user.id, input.lineId ?? null, input.visibility ?? 'private', now, now)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'chart.save', kind: 'system', targetKind: 'eda-chart', targetId: id,
    summary: `保存图表「${input.title}」(${input.vizType},${input.visibility ?? 'private'})`,
    detail: { vizType: input.vizType, visibility: input.visibility ?? 'private' },
  })
  return chartById(user, id)!
}

export function updateChart(user: ResolvedUser, id: string, patch: Partial<ChartInput> & { annotations?: unknown[] }): EdaChartRow {
  const existing = edaDb().prepare('SELECT * FROM eda_charts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!existing) throw new Error(`图表不存在: ${id}`)
  const row = rowOf(existing)
  if (!canWriteChart(user, row)) throw new Error('仅 owner 或 admin 可修改该图表。')
  const merged: ChartInput = {
    title: patch.title ?? row.title,
    vizType: patch.vizType ?? row.vizType,
    datasource: patch.datasource ?? row.datasource,
    encoding: patch.encoding ?? row.encoding,
    transform: patch.transform ?? row.transform,
    options: patch.options ?? row.options,
    lineId: patch.lineId !== undefined ? patch.lineId : row.lineId,
    visibility: patch.visibility ?? row.visibility,
  }
  validateInput(merged)
  edaDb().prepare(`UPDATE eda_charts SET title = ?, viz_type = ?, datasource_json = ?, encoding_json = ?, transform_json = ?, options_json = ?, annotations_json = ?, line_id = ?, visibility = ?, version = version + 1, updated_at = ? WHERE id = ?`)
    .run(merged.title, merged.vizType,
      JSON.stringify(merged.datasource ?? {}), JSON.stringify(merged.encoding ?? {}), JSON.stringify(merged.transform ?? {}), JSON.stringify(merged.options ?? {}),
      JSON.stringify(patch.annotations ?? row.annotations),
      merged.lineId ?? null, merged.visibility ?? 'private', new Date().toISOString(), id)
  return chartById(user, id)!
}

export function deleteChart(user: ResolvedUser, id: string): boolean {
  const existing = edaDb().prepare('SELECT * FROM eda_charts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!existing) return false
  if (!canWriteChart(user, rowOf(existing))) throw new Error('仅 owner 或 admin 可删除该图表。')
  edaDb().prepare('DELETE FROM eda_dashboard_charts WHERE chart_id = ?').run(id)
  edaDb().prepare('DELETE FROM eda_charts WHERE id = ?').run(id)
  return true
}
