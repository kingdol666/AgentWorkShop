/**
 * EDA 看板仓储(plan1 M3)—— eda_dashboards + eda_dashboard_charts。
 * 可见性同 chart(B4):private→owner/admin;line→产线可读。
 * 布局 = 12 栅格 gridPos(Grafana 模式);详情对内嵌 chart 逐个走 canReadChart,
 * 不可见图在响应中标 inaccessible: true(不静默丢弃 —— 旁路防护的可见化)。
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'
import { chartById, canReadChart, type EdaChartRow } from './chart-repo'

export interface BoardGridPos { chartId: string, x: number, y: number, w: number, h: number }

export interface EdaDashboardRow {
  id: string
  title: string
  filters: { window?: string, agg?: string }
  layout: BoardGridPos[]
  ownerUserId: string
  lineId: string | null
  visibility: 'private' | 'line'
  version: number
  createdAt: string
  updatedAt: string
}

function rowOf(r: Record<string, unknown>): EdaDashboardRow {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    filters: safeObj(r.filters_json) as EdaDashboardRow['filters'],
    layout: safeArr(r.layout_json) as BoardGridPos[],
    ownerUserId: String(r.owner_user_id ?? ''),
    lineId: r.line_id == null ? null : String(r.line_id),
    visibility: String(r.visibility ?? 'private') as EdaDashboardRow['visibility'],
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

function canReadBoard(user: ResolvedUser, row: EdaDashboardRow): boolean {
  if (row.ownerUserId === user.id || user.role === 'admin') return true
  if (row.visibility === 'line' && row.lineId) return lineMode(user, row.lineId) !== 'none'
  return false
}

function writeOk(user: ResolvedUser, row: EdaDashboardRow): boolean {
  return row.ownerUserId === user.id || user.role === 'admin'
}

export function listDashboards(user: ResolvedUser, opts: { mine?: boolean } = {}): EdaDashboardRow[] {
  const rows = edaDb().prepare('SELECT * FROM eda_dashboards ORDER BY updated_at DESC LIMIT 200').all() as Array<Record<string, unknown>>
  return rows.map(rowOf)
    .filter(b => canReadBoard(user, b))
    .filter(b => (opts.mine ? b.ownerUserId === user.id : true))
}

function boardByIdRaw(id: string): EdaDashboardRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_dashboards WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? rowOf(r) : null
}

export function dashboardById(user: ResolvedUser, id: string): {
  dashboard: EdaDashboardRow
  charts: Array<{ chart: EdaChartRow | null, gridPos: BoardGridPos | null, inaccessible: boolean }>
} | null {
  const row = boardByIdRaw(id)
  if (!row || !canReadBoard(user, row)) return null
  const charts = row.layout.map((pos) => {
    const chart = chartById(user, pos.chartId)
    return { chart, gridPos: pos, inaccessible: !chart || !canReadChart(user, chart) }
  })
  return { dashboard: row, charts }
}

function sanitizeLayout(layout: unknown): BoardGridPos[] {
  if (!Array.isArray(layout)) return []
  return layout
    .filter((p): p is BoardGridPos => {
      const x = p as BoardGridPos
      return typeof x?.chartId === 'string' && Number.isInteger(x.x) && Number.isInteger(x.y)
    })
    .map(p => ({
      chartId: p.chartId,
      x: Math.min(Math.max(Math.round(p.x), 0), 11),
      y: Math.max(Math.round(p.y), 0),
      w: Math.min(Math.max(Math.round(p.w) || 4, 1), 12),
      h: Math.min(Math.max(Math.round(p.h) || 3, 1), 12),
    }))
}

export function createDashboard(user: ResolvedUser, input: {
  title: string
  filters?: Record<string, unknown>
  layout?: unknown
  lineId?: string | null
  visibility?: string
}): EdaDashboardRow {
  const vis = input.visibility ?? 'private'
  if (!['private', 'line'].includes(vis)) throw new Error('visibility 只支持 private/line。')
  if (vis === 'line' && !input.lineId) throw new Error('visibility=line 必须携带 line_id。')
  const id = `edb-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_dashboards (id, title, filters_json, layout_json, owner_user_id, line_id, visibility, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, input.title.slice(0, 200), JSON.stringify(input.filters ?? {}), JSON.stringify(sanitizeLayout(input.layout)), user.id, input.lineId ?? null, vis, now, now)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'dashboard.save', kind: 'system', targetKind: 'eda-dashboard', targetId: id,
    summary: `创建看板「${input.title}」(${vis})`,
  })
  return boardByIdRaw(id)!
}

export function updateDashboard(user: ResolvedUser, id: string, patch: {
  title?: string
  filters?: Record<string, unknown>
  layout?: unknown
  visibility?: string
  lineId?: string | null
}): EdaDashboardRow {
  const row = boardByIdRaw(id)
  if (!row) throw new Error(`看板不存在: ${id}`)
  if (!writeOk(user, row)) throw new Error('仅 owner 或 admin 可修改看板。')
  const vis = patch.visibility ?? row.visibility
  const lineId = patch.lineId !== undefined ? patch.lineId : row.lineId
  if (!['private', 'line'].includes(vis)) throw new Error('visibility 只支持 private/line。')
  if (vis === 'line' && !lineId) throw new Error('visibility=line 必须携带 line_id。')
  edaDb().prepare(`UPDATE eda_dashboards SET title = ?, filters_json = ?, layout_json = ?, line_id = ?, visibility = ?, version = version + 1, updated_at = ? WHERE id = ?`)
    .run(patch.title ?? row.title, JSON.stringify(patch.filters ?? row.filters), JSON.stringify(sanitizeLayout(patch.layout ?? row.layout)), lineId ?? null, vis, new Date().toISOString(), id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'dashboard.save', kind: 'system', targetKind: 'eda-dashboard', targetId: id,
    summary: `更新看板「${patch.title ?? row.title}」(v${row.version + 1})`,
    detail: { keys: Object.keys(patch) },
  })
  return boardByIdRaw(id)!
}

export function deleteDashboard(user: ResolvedUser, id: string): boolean {
  const row = boardByIdRaw(id)
  if (!row) return false
  if (!writeOk(user, row)) throw new Error('仅 owner 或 admin 可删除看板。')
  edaDb().prepare('DELETE FROM eda_dashboard_charts WHERE dashboard_id = ?').run(id)
  edaDb().prepare('DELETE FROM eda_dashboards WHERE id = ?').run(id)
  return true
}
