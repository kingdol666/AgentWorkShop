/**
 * E1 run 台账仓储 —— dcw-runs.json(RUNS_CAP=200 环形滚丢)的持久 SQL 镜像。
 *
 * dcw-recipe.repo 的 createRun/closeRun 是全系统唯一的批次开/关账咽喉点,经
 * 动态 import 调用本 repo 落镜像(JSON 仓储保持零 SQL 依赖;EDA 台账不可用只
 * 降级不阻断批次主链)。sample_count 在关账后按节点逐个经 tsdb 计数回填
 * (tsdb 与 workshop.sqlite 是两个库,端口不暴露 COUNT,逐节点 sum 是既定折衷;
 * 特征仓库上线后此列由特征行数直接可得)。
 */
import { randomUUID } from 'node:crypto'
import { edaDb } from './eda-db'

export type EdaRunOutcome = 'open' | 'good' | 'bad' | 'scrapped'

export interface EdaRunRow {
  id: string
  lineId: string
  productId: string
  recipeId: string
  recipeName: string
  recipeVersion: number | null
  startedAt: string
  endedAt: string | null
  sampleCount: number | null
  outcome: EdaRunOutcome
  labels: Record<string, unknown>
  createdAt: string
}

interface RunMirrorInput {
  id: string
  lineId: string
  productId: string
  recipeId: string
  recipeName: string
  /** 建批时冻结的配方版本(0/缺省 = 历史未知;不再恒写 NULL) */
  recipeVersion?: number
  startedAt: string
  endedAt: string | null
}

function rowOf(r: Record<string, unknown>): EdaRunRow {
  return {
    id: String(r.id),
    lineId: String(r.line_id ?? ''),
    productId: String(r.product_id ?? ''),
    recipeId: String(r.recipe_id ?? ''),
    recipeName: String(r.recipe_name ?? ''),
    recipeVersion: r.recipe_version == null ? null : Number(r.recipe_version),
    startedAt: String(r.started_at ?? ''),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
    sampleCount: r.sample_count == null ? null : Number(r.sample_count),
    outcome: String(r.outcome ?? 'open') as EdaRunOutcome,
    labels: safeJson(r.labels_json, {}),
    createdAt: String(r.created_at ?? ''),
  }
}

function safeJson<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text ?? '')) as T
  }
  catch {
    return fallback
  }
}

/** 开账镜像(run 创建即落;幂等,重复触发不覆盖) */
export function mirrorRunCreated(run: RunMirrorInput): void {
  edaDb().prepare(`INSERT INTO eda_runs (id, line_id, product_id, recipe_id, recipe_name, recipe_version, started_at, ended_at, outcome, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(id) DO NOTHING`).run(
    run.id, run.lineId, run.productId, run.recipeId, run.recipeName, run.recipeVersion ?? null, run.startedAt, run.endedAt, new Date().toISOString(),
  )
}

/** 关账镜像:UPSERT(开账镜像若因动态 import 尚未落行,此处兜底建行);sample_count 异步回填 */
export function mirrorRunClosed(run: RunMirrorInput): void {
  const now = new Date().toISOString()
  const ended = run.endedAt ?? now
  edaDb().prepare(`INSERT INTO eda_runs (id, line_id, product_id, recipe_id, recipe_name, recipe_version, started_at, ended_at, outcome, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(id) DO UPDATE SET ended_at = COALESCE(eda_runs.ended_at, excluded.ended_at), recipe_name = excluded.recipe_name,
      recipe_version = COALESCE(eda_runs.recipe_version, excluded.recipe_version)`)
    .run(run.id, run.lineId, run.productId, run.recipeId, run.recipeName, run.recipeVersion ?? null, run.startedAt, ended, now)
  edaDb().prepare('UPDATE eda_runs SET ended_at = ? WHERE id = ? AND (ended_at IS NULL OR ended_at = \'\')').run(ended, run.id)
  void backfillSampleCount(run.id, run.lineId, run.startedAt, ended)
  // E3 联动:关账即入特征提取队列(FDC 主链;失败不阻断关账)
  void (async () => {
    try {
      const { enqueueRunFeatures } = await import('./features')
      enqueueRunFeatures(run.id)
    }
    catch { /* 特征服务不可用 */ }
  })()
}

/** 关账窗口样本计数:逐节点 queryTagged 求和(nodeIds 单节点时 limit 全局≡每节点,语义正确) */
async function backfillSampleCount(runId: string, lineId: string, startedAt: string, endedAt: string | null): Promise<void> {
  try {
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    await tsdbReady
    const { getDaqNodeRepo } = await import('../daq/daq-node.repo')
    const nodes = getDaqNodeRepo().all().filter(n => n.lineId === lineId)
    if (nodes.length === 0) return
    const tsdb = getTsdb()
    const fromMs = Date.parse(startedAt)
    const toMs = endedAt ? Date.parse(endedAt) : Date.now()
    if (!Number.isFinite(fromMs)) return
    let total = 0
    for (const n of nodes) {
      const series = await tsdb.queryTagged({ runId, nodeIds: [n.id], fromMs, toMs, limit: 1_000_000 })
      const pts = series.get(n.id)
      if (pts?.length) total += pts.length
    }
    edaDb().prepare('UPDATE eda_runs SET sample_count = ? WHERE id = ?').run(total, runId)
  }
  catch { /* tsdb 未就绪/节点仓储异常:样本计数留空,不阻断关账 */ }
}

export function setRunOutcome(runId: string, outcome: EdaRunOutcome): void {
  edaDb().prepare('UPDATE eda_runs SET outcome = ? WHERE id = ?').run(outcome, runId)
}

export function setRunLabels(runId: string, labels: Record<string, unknown>): void {
  edaDb().prepare('UPDATE eda_runs SET labels_json = ? WHERE id = ?').run(JSON.stringify(labels ?? {}), runId)
}

export function edaRunById(id: string): EdaRunRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? rowOf(r) : null
}

export interface EdaRunQuery {
  lineId?: string
  recipeId?: string
  outcome?: string
  from?: string
  to?: string
  /** labels_json 键值过滤(E8③):形如 "lot_id:LOT-9",按 `"key":"value"` 子串匹配 */
  label?: string
  limit?: number
  offset?: number
}

/** run 清单(新→旧);from/to 按 started_at 文本比较(全库本地 ISO 同形态,入库前归一) */
export function listEdaRuns(q: EdaRunQuery = {}): { runs: EdaRunRow[], total: number } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (q.lineId) {
    where.push('line_id = ?')
    params.push(q.lineId)
  }
  if (q.recipeId) {
    where.push('recipe_id = ?')
    params.push(q.recipeId)
  }
  if (q.outcome) {
    where.push('outcome = ?')
    params.push(q.outcome)
  }
  if (q.from) {
    where.push('started_at >= ?')
    params.push(q.from)
  }
  if (q.to) {
    where.push('started_at <= ?')
    params.push(q.to)
  }
  if (q.label) {
    const idx = q.label.indexOf(':')
    if (idx > 0) {
      // 键值进入绑定参数(LIKE 模式是数据,非拼接),E8③ labels 检索面
      where.push('labels_json LIKE ?')
      params.push(`%"${q.label.slice(0, idx)}":"${q.label.slice(idx + 1)}"%`)
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number((edaDb().prepare(`SELECT COUNT(*) AS c FROM eda_runs ${whereSql}`).get(...params) as { c: number }).c)
  const limit = Math.min(Math.max(Math.round(Number(q.limit)) || 50, 1), 500)
  const offset = Math.max(Math.round(Number(q.offset)) || 0, 0)
  const rows = edaDb().prepare(`SELECT * FROM eda_runs ${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>
  return { runs: rows.map(rowOf), total }
}

/** 供 Phase C 使用:某配方最近的 good run 清单(参考带/黄金轨迹的候选源) */
export function recentRunsByOutcome(recipeId: string, outcome: EdaRunOutcome, limit = 20): EdaRunRow[] {
  const rows = edaDb().prepare(`SELECT * FROM eda_runs WHERE recipe_id = ? AND outcome = ? AND ended_at IS NOT NULL
    ORDER BY started_at DESC LIMIT ?`).all(recipeId, outcome, Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(rowOf)
}

/** 测试辅助:清空 run 台账(仅 AGENTWORKSHOP_TEST 生效) */
export function edaRunsResetForTest(): void {
  if (!process.env.AGENTWORKSHOP_TEST) throw new Error('edaRunsResetForTest 仅限测试')
  edaDb().prepare('DELETE FROM eda_runs').run()
}

/** 未使用的 randomUUID 引用守卫(导出面将来生成 job id 用;此处预留避免顶部重复 import) */
export const newEdaId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
