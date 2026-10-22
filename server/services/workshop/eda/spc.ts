/**
 * E4 SPC —— 控制图注册与判定(eda_spc_charts/eda_spc_points)。
 *
 * 数据源 = eda_run_features 的 mean 特征序列(per-run 等间隔,按 run started_at ASC);
 * 建限 ≥ n_points≥25 才 enabled(教科书惯例,冷启动期只积累不判定);
 * 判异 = Nelson 1-8(spc-math);联动:E3 特征任务完成后 appendSpcPointsForRun。
 * 与配方 daqWindows 的关系:并存不合并 —— daqWindows 是采样域实时单点硬限,
 * SPC 是批次特征序列上的统计带。
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'
import { buildLimits, cusum, ewma, nelsonHits } from './spc-math'

export const SPC_KINDS = ['i_mr', 'xbar_r', 'ewma', 'cusum'] as const
export type SpcKind = typeof SPC_KINDS[number]
const MIN_POINTS = 25
const WINDOW = 60

export interface SpcChartRow {
  id: string
  lineId: string
  nodeId: string
  metric: string
  kind: SpcKind
  params: Record<string, unknown>
  cl: number | null
  ucl: number | null
  lcl: number | null
  sigma: number | null
  nPoints: number
  enabled: boolean
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

function rowOf(r: Record<string, unknown>): SpcChartRow {
  return {
    id: String(r.id),
    lineId: String(r.line_id),
    nodeId: String(r.node_id),
    metric: String(r.metric ?? ''),
    kind: String(r.kind) as SpcKind,
    params: safeObj(r.params_json),
    cl: r.cl == null ? null : Number(r.cl),
    ucl: r.ucl == null ? null : Number(r.ucl),
    lcl: r.lcl == null ? null : Number(r.lcl),
    sigma: r.sigma == null ? null : Number(r.sigma),
    nPoints: Number(r.n_points ?? 0),
    enabled: Number(r.enabled ?? 0) === 1,
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
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

export function listSpcCharts(user: ResolvedUser, lineId?: string): SpcChartRow[] {
  const rows = lineId
    ? edaDb().prepare('SELECT * FROM eda_spc_charts WHERE line_id = ? ORDER BY created_at DESC').all(lineId) as Array<Record<string, unknown>>
    : edaDb().prepare('SELECT * FROM eda_spc_charts ORDER BY created_at DESC LIMIT 500').all() as Array<Record<string, unknown>>
  return (rows.map(rowOf)).filter(c => lineMode(user, c.lineId) !== 'none')
}

export function spcChartById(user: ResolvedUser, id: string): SpcChartRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_spc_charts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  const row = rowOf(r)
  return lineMode(user, row.lineId) === 'none' ? null : row
}

export async function createSpcChart(user: ResolvedUser, input: {
  lineId: string
  nodeId: string
  metric?: string
  kind: string
  params?: Record<string, unknown>
}): Promise<SpcChartRow> {
  if (!SPC_KINDS.includes(input.kind as SpcKind)) {
    throw new Error(`kind 只支持 ${SPC_KINDS.join('/')}(收到 ${input.kind})`)
  }
  if (lineMode(user, input.lineId) === 'none') {
    throw new Error('产线不在你的可读范围内。')
  }
  // metric 缺省 = 节点 templateRef(与特征行的 metric 同源;留空会查不到任何特征序列)
  let metric = input.metric ?? ''
  if (!metric) {
    try {
      const { getDaqNodeRepo } = await import('../daq/daq-node.repo')
      const n = getDaqNodeRepo().byId(input.nodeId)
      metric = n?.templateRef ?? ''
    }
    catch { /* 仓储不可用时保持空串,建限自然为 0 点 */ }
  }
  const id = `spc-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_spc_charts (id, line_id, node_id, metric, kind, params_json, n_points, enabled, owner_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    ON CONFLICT(line_id, node_id, metric, kind) DO UPDATE SET params_json = excluded.params_json, updated_at = excluded.updated_at`)
    .run(id, input.lineId, input.nodeId, metric, input.kind, JSON.stringify(input.params ?? {}), user.id, now, now)
  // 冲突路径更新的旧行 ≠ 新 id:按唯一键回查(否则返 null)
  const row = edaDb().prepare('SELECT * FROM eda_spc_charts WHERE line_id = ? AND node_id = ? AND metric = ? AND kind = ?')
    .get(input.lineId, input.nodeId, metric, input.kind) as Record<string, unknown>
  return rowOf(row)
}

export function deleteSpcChart(user: ResolvedUser, id: string): boolean {
  const row = spcChartById(user, id)
  if (!row) return false
  edaDb().prepare('DELETE FROM eda_spc_points WHERE chart_id = ?').run(id)
  edaDb().prepare('DELETE FROM eda_spc_charts WHERE id = ?').run(id)
  return true
}

/** 特征序列(run ASC):join eda_runs 取 started_at 排序,取末窗 WINDOW 点 */
function featureSeries(chart: SpcChartRow): Array<{ runId: string, value: number, at: string }> {
  const rows = edaDb().prepare(`
    SELECT f.run_id, f.mean, r.started_at FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
    WHERE r.line_id = ? AND f.node_id = ? AND f.metric = ? AND f.segment = '' AND f.mean IS NOT NULL
    ORDER BY r.started_at ASC
  `).all(chart.lineId, chart.nodeId, chart.metric) as Array<{ run_id: string, mean: number | null, started_at: string }>
  return rows.slice(-WINDOW).map(r => ({ runId: r.run_id, value: Number(r.mean), at: r.started_at }))
}

/** 重算控制限(n≥MIN_POINTS 才 enabled;每次重算覆盖旧限) */
export function recomputeSpcLimits(chartId: string): SpcChartRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_spc_charts WHERE id = ?').get(chartId) as Record<string, unknown> | undefined
  if (!r) return null
  const chart = rowOf(r)
  const series = featureSeries(chart)
  const limits = buildLimits(series.map(s => s.value))
  const n = series.length
  if (limits && n >= MIN_POINTS) {
    edaDb().prepare('UPDATE eda_spc_charts SET cl = ?, sigma = ?, ucl = ?, lcl = ?, n_points = ?, enabled = 1, updated_at = ? WHERE id = ?')
      .run(limits.cl, limits.sigma, limits.ucl, limits.lcl, n, new Date().toISOString(), chartId)
  }
  else {
    edaDb().prepare('UPDATE eda_spc_charts SET n_points = ?, updated_at = ? WHERE id = ?')
      .run(n, new Date().toISOString(), chartId)
  }
  const out = edaDb().prepare('SELECT * FROM eda_spc_charts WHERE id = ?').get(chartId) as Record<string, unknown>
  return rowOf(out)
}

/** 判定一个 run 的特征点(建限后;Nelson 判异 + kind 统计量) */
export function appendSpcPoint(chart: SpcChartRow, runId: string): { violated: boolean, ruleHits: string[] } | null {
  const series = featureSeries(chart)
  const values = series.map(s => s.value)
  const idx = series.findIndex(s => s.runId === runId)
  if (idx < 0 || chart.cl == null || chart.sigma == null) return null
  let stat: number | null = null
  if (chart.kind === 'ewma') {
    const lambda = Number(chart.params.lambda ?? 0.2)
    const { stats } = ewma(values, chart.cl, chart.sigma, lambda)
    stat = stats[idx] ?? null
  }
  else if (chart.kind === 'cusum') {
    const k = Number(chart.params.k ?? 0.5)
    const h = Number(chart.params.h ?? 4)
    const { cPlus, cMinus } = cusum(values, chart.cl, chart.sigma, k, h)
    stat = Math.max(cPlus[idx] ?? 0, cMinus[idx] ?? 0)
  }
  const hits = nelsonHits(values, chart.cl, chart.sigma)[idx] ?? []
  const violated = hits.length > 0
  edaDb().prepare(`INSERT INTO eda_spc_points (id, chart_id, run_id, value, stat, rule_hits, violated, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .run(`spcpt-${randomUUID().slice(0, 12)}`, chart.id, runId, values[idx] ?? null, stat, JSON.stringify(hits), violated ? 1 : 0, new Date().toISOString())
  return { violated, ruleHits: hits }
}

/** E3 联动入口:一次 run 的全部特征落库后,该线启用图逐个判定(建限不判) */
export async function appendSpcPointsForRun(run: { id: string, lineId: string, recipeId: string }): Promise<number> {
  const charts = edaDb().prepare('SELECT * FROM eda_spc_charts WHERE line_id = ? AND enabled = 1').all(run.lineId) as Array<Record<string, unknown>>
  let n = 0
  for (const r of charts) {
    const res = appendSpcPoint(rowOf(r), run.id)
    if (res) n += 1
    if (res?.violated) {
      try {
        recordOps({
          actor: 'system', actorName: 'EDA/SPC', actorKind: 'system',
          action: 'spc.violate', kind: 'alarm', level: 'warn',
          targetKind: 'daq', targetId: String(r.node_id),
          lineId: run.lineId, recipeId: run.recipeId, scope: 'line',
          summary: `SPC 判异:批次 ${run.id} 图 ${String(r.id)} 命中 Nelson 规则 ${res.ruleHits.join(',')}`,
          detail: { runId: run.id, chartId: r.id, ruleHits: res.ruleHits },
        })
      }
      catch { /* 审计失败不阻断 */ }
    }
  }
  return n
}

/** 判定点序列(渲染面) */
export function spcPoints(chartId: string, limit = 200): Array<{ runId: string, value: number | null, stat: number | null, ruleHits: string[], violated: boolean, at: string }> {
  const rows = edaDb().prepare('SELECT * FROM eda_spc_points WHERE chart_id = ? ORDER BY at DESC LIMIT ?').all(chartId, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>
  return rows.map(r => ({
    runId: String(r.run_id),
    value: r.value == null ? null : Number(r.value),
    stat: r.stat == null ? null : Number(r.stat),
    ruleHits: safeArr(r.rule_hits),
    violated: Number(r.violated ?? 0) === 1,
    at: String(r.at ?? ''),
  })).reverse()
}
function safeArr(text: unknown): string[] {
  try {
    return JSON.parse(String(text ?? '[]')) as string[]
  }
  catch {
    return []
  }
}
