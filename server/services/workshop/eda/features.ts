/**
 * E3 FDC —— per-run per-node 特征提取 + 参考带判定 + 特征仓库。
 *
 * 触发:run 关账钩子(eda-run.repo mirrorRunClosed → enqueueRunFeatures)入进程内
 * 并发=1 队列(mes_fetch_jobs/eda_export_jobs 同款账本;特征计算是确定性 TS,不烧
 * LLM token,不挂 scheduled_tasks —— 企业 EDA 评审 A-7)。
 *
 * 判定语义:参考带 = 同产线同节点同 metric 最近 N 个**未违例**批次的 mean 特征的
 * mean±k·std(快照固化进特征行,抗基线漂移);z=(mean-refMean)/refStd,|z|>k → violated。
 * 告警落点(与验收 ④ 的映射说明):run 级违例 ≠ 逐样本 daq 告警(alarm_events 是采样域
 * 实时面),这里以 **feature 行(violated=1,UNIQUE 幂等)+ recordOps 审计 +
 * notifyLineOperators 定向通知(eventId 幂等)** 三件套落地;alarm_events 桥接列后续项。
 */
import { randomUUID } from 'node:crypto'
import { edaDb } from './eda-db'
import { edaRunById } from './eda-run.repo'

export interface RunFeatureRow {
  id: string
  runId: string
  nodeId: string
  metric: string
  segment: string
  cnt: number | null
  mean: number | null
  std: number | null
  min: number | null
  max: number | null
  slope: number | null
  breachCnt: number
  refMean: number | null
  refStd: number | null
  k: number | null
  zScore: number | null
  violated: boolean
  createdAt: string
}

function rowOf(r: Record<string, unknown>): RunFeatureRow {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    nodeId: String(r.node_id),
    metric: String(r.metric ?? ''),
    segment: String(r.segment ?? ''),
    cnt: r.cnt == null ? null : Number(r.cnt),
    mean: r.mean == null ? null : Number(r.mean),
    std: r.std == null ? null : Number(r.std),
    min: r.min == null ? null : Number(r.min),
    max: r.max == null ? null : Number(r.max),
    slope: r.slope == null ? null : Number(r.slope),
    breachCnt: Number(r.breach_cnt ?? 0),
    refMean: r.ref_mean == null ? null : Number(r.ref_mean),
    refStd: r.ref_std == null ? null : Number(r.ref_std),
    k: r.k == null ? null : Number(r.k),
    zScore: r.z_score == null ? null : Number(r.z_score),
    violated: Number(r.violated ?? 0) === 1,
    createdAt: String(r.created_at ?? ''),
  }
}

/** 特征提取(纯函数;段=segment 定义,缺省整窗一段)——slope 为每小时工程量变化 */
export function extractFeatures(points: Array<{ at: number, v: number }>, opts: {
  warnLow?: number | null
  warnHigh?: number | null
  graceMs?: number
  segments?: Array<{ name: string, phaseFrom: number, phaseTo: number }>
} = {}): Array<{ segment: string, cnt: number, mean: number, std: number, min: number, max: number, slope: number, breachCnt: number }> {
  if (!points.length) return []
  const start = points[0]!.at
  const end = points[points.length - 1]!.at
  const span = Math.max(1, end - start)
  const grace = Math.max(0, Number(opts.graceMs) || 0)
  const segs = opts.segments?.length
    ? opts.segments
    : [{ name: '', phaseFrom: 0, phaseTo: 1 }]
  const out: Array<{ segment: string, cnt: number, mean: number, std: number, min: number, max: number, slope: number, breachCnt: number }> = []
  for (const seg of segs) {
    const from = start + seg.phaseFrom * span + (seg.phaseFrom === 0 ? grace : 0)
    const to = start + seg.phaseTo * span
    const inSeg = points.filter(p => p.at >= from && p.at <= to)
    if (!inSeg.length) continue
    const vals = inSeg.map(p => p.v)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
    // slope:最小二乘,时间归一到小时(量纲稳定,不随采样率漂移)
    const t0 = inSeg[0]!.at
    const xs = inSeg.map(p => (p.at - t0) / 3600_000)
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    let num = 0
    let den = 0
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (vals[i]! - mean)
      den += (xs[i]! - mx) ** 2
    }
    const slope = den > 0 ? num / den : 0
    let breachCnt = 0
    if (opts.warnLow != null || opts.warnHigh != null) {
      for (const v of vals) {
        if ((opts.warnLow != null && v < opts.warnLow) || (opts.warnHigh != null && v > opts.warnHigh)) breachCnt += 1
      }
    }
    out.push({
      segment: seg.name,
      cnt: vals.length,
      mean: Number(mean.toFixed(6)),
      std: Number(std.toFixed(6)),
      min: Number(Math.min(...vals).toFixed(6)),
      max: Number(Math.max(...vals).toFixed(6)),
      slope: Number(slope.toFixed(6)),
      breachCnt,
    })
  }
  return out
}

// ===== 特征 job 队列(并发=1) =====
let queue: Promise<void> = Promise.resolve()

export function featureQueueResetForTest(): void {
  queue = Promise.resolve()
}

export function enqueueRunFeatures(runId: string): Promise<void> {
  queue = queue.then(() => computeRunFeatures(runId)).then(() => undefined).catch(() => { /* 队列不因单 run 失败断裂 */ })
  return queue
}

function jobStart(runId: string): string {
  const id = `fjob-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_feature_jobs (id, run_id, status, features, created_at, updated_at) VALUES (?, ?, 'running', 0, ?, ?)`).run(id, runId, now, now)
  return id
}

function jobDone(id: string, features: number, error?: string): void {
  edaDb().prepare('UPDATE eda_feature_jobs SET status = ?, features = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(error ? 'failed' : 'done', features, error ?? null, new Date().toISOString(), id)
}

/** 参考带:同线同节点同 metric 最近 10 个未违例行(判定的参考带快照固化) */
function referenceBand(lineId: string, nodeId: string, metric: string, segment: string): { refMean: number, refStd: number } | null {
  const rows = edaDb().prepare(`
    SELECT f.mean FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
    WHERE r.line_id = ? AND f.node_id = ? AND f.metric = ? AND f.segment = ? AND f.violated = 0 AND f.mean IS NOT NULL
    ORDER BY f.created_at DESC LIMIT 10
  `).all(lineId, nodeId, metric, segment) as Array<{ mean: number | null }>
  if (rows.length < REF_MIN_RUNS) return null
  const means = rows.map(r => Number(r.mean)).filter(Number.isFinite)
  const m = means.reduce((a, b) => a + b, 0) / means.length
  const s = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / means.length)
  if (!Number.isFinite(m) || !Number.isFinite(s) || s < 1e-12) return null
  return { refMean: m, refStd: s }
}

const K = 3
/** 参考带最少历史批数(不足则不判定,只记录特征) */
const REF_MIN_RUNS = 3

/** 计算 single run 的全部特征并落库(UNIQUE(run,node,metric,segment) 幂等 upsert) */
export async function computeRunFeatures(runId: string, opts: { graceMs?: number } = {}): Promise<number> {
  const run = edaRunById(runId)
  if (!run) throw new Error(`批次不存在: ${runId}`)
  if (!run.endedAt) throw new Error('批次未关账,不能提特征')
  const jobId = jobStart(runId)
  try {
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    await tsdbReady
    const { getDaqNodeRepo } = await import('../daq/daq-node.repo')
    const { getDcwController } = await import('../dcw/dcw-controller')
    const startMs = Date.parse(run.startedAt)
    const endMs = Date.parse(run.endedAt)
    const nodes = getDaqNodeRepo().all().filter(n => n.enabled && n.lineId === run.lineId)
    // 配方监控窗口(breach 判定基线:活动配方的 daqWindows 优先,退回节点预警带)
    const recipe = getDcwController().listRecipes().find(r => r.id === run.recipeId)
    const winOf = (nodeId: string): { warnLow: number | null, warnHigh: number | null } => {
      const w = recipe?.daqWindows?.find(x => x.nodeId === nodeId)
      if (w) return { warnLow: w.min ?? null, warnHigh: w.max ?? null }
      const n = nodes.find(x => x.id === nodeId)
      return { warnLow: n?.warnLow ?? null, warnHigh: n?.warnHigh ?? null }
    }
    let count = 0
    const violatedRows: RunFeatureRow[] = []
    for (const n of nodes) {
      const series = await getTsdb().queryTagged({ runId, nodeIds: [n.id], fromMs: startMs, toMs: endMs, limit: 1_000_000 })
      const pts = (series.get(n.id) ?? []).map(p => ({ at: p.at, v: p.value ?? p.avg ?? 0 })).filter(p => Number.isFinite(p.v))
      if (!pts.length) continue
      const metric = n.templateRef ?? ''
      const win = winOf(n.id)
      // E8:配方定义了相位段(run_segments)时按段拆分特征(0-50%/50-100% 等)
      const segRows = edaDb().prepare('SELECT name, phase_from, phase_to FROM run_segments WHERE recipe_id = ? ORDER BY seq ASC')
        .all(run.recipeId) as Array<{ name: string, phase_from: number, phase_to: number }>
      const segments = segRows.length
        ? segRows.map(s => ({ name: s.name, phaseFrom: Number(s.phase_from), phaseTo: Number(s.phase_to) }))
        : undefined
      const feats = extractFeatures(pts, { ...win, graceMs: opts.graceMs, segments })
      for (const f of feats) {
        const band = referenceBand(run.lineId, n.id, metric, f.segment)
        const z = band && f.std != null ? (f.mean - band.refMean) / band.refStd : null
        const violated = z != null && Math.abs(z) > K
        const id = `feat-${randomUUID().slice(0, 12)}`
        edaDb().prepare(`INSERT INTO eda_run_features (id, run_id, node_id, metric, segment, cnt, mean, std, min, max, slope, breach_cnt, ref_mean, ref_std, k, z_score, violated, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, node_id, metric, segment) DO UPDATE SET
            cnt = excluded.cnt, mean = excluded.mean, std = excluded.std, min = excluded.min, max = excluded.max,
            slope = excluded.slope, breach_cnt = excluded.breach_cnt, ref_mean = excluded.ref_mean,
            ref_std = excluded.ref_std, k = excluded.k, z_score = excluded.z_score, violated = excluded.violated`)
          .run(id, runId, n.id, metric, f.segment, f.cnt, f.mean, f.std, f.min, f.max, f.slope,
            f.breachCnt, band?.refMean ?? null, band?.refStd ?? null, band ? K : null, z == null ? null : Number(z.toFixed(4)),
            violated ? 1 : 0, new Date().toISOString())
        count += 1
        if (violated) {
          violatedRows.push({ id, runId, nodeId: n.id, metric, segment: f.segment, cnt: f.cnt, mean: f.mean, std: f.std, min: f.min, max: f.max, slope: f.slope, breachCnt: f.breachCnt, refMean: band?.refMean ?? null, refStd: band?.refStd ?? null, k: K, zScore: z, violated: true, createdAt: '' })
        }
      }
    }
    jobDone(jobId, count)
    // 违例播报:ops 审计(幂等性由 UNIQUE 约束保证:同 run 同节点同段只判一次)+ 线操作员定向通知
    for (const v of violatedRows) {
      try {
        const { recordOps } = await import('../ops/ops')
        recordOps({
          actor: 'system', actorName: 'EDA/FDC', actorKind: 'system',
          action: 'fdc.violate', kind: 'alarm', level: 'warn',
          targetKind: 'daq', targetId: v.nodeId,
          lineId: run.lineId, recipeId: run.recipeId,
          scope: 'line',
          summary: `FDC 违例:批次 ${v.runId} 节点 ${v.nodeId}${v.segment ? `[${v.segment}]` : ''} mean=${v.mean} 参考带 ${v.refMean?.toFixed(3)}±${K}·${v.refStd?.toFixed(3)} (z=${v.zScore})`,
          detail: { runId: v.runId, nodeId: v.nodeId, zScore: v.zScore, breachCnt: v.breachCnt },
        })
      }
      catch { /* 审计失败不阻断 */ }
    }
    if (violatedRows.length > 0) {
      try {
        const { notifyLineOperators } = await import('../runtime/line-notify')
        notifyLineOperators(run.lineId, {
          eventId: `fdc:${runId}:${violatedRows[0]!.nodeId}`,
          title: `FDC 违例:批次 ${runId}`,
          body: violatedRows.map(v => `${v.nodeId} z=${v.zScore}`).join(';'),
          payload: { runId, nodes: violatedRows.map(v => v.nodeId) },
        })
      }
      catch { /* 通知失败不阻断 */ }
    }
    // E4 联动:特征落库后,本线的启用 SPC 图逐个追加判定点
    try {
      const { appendSpcPointsForRun } = await import('./spc')
      await appendSpcPointsForRun(run)
    }
    catch { /* SPC 联动失败不影响特征主链 */ }
    return count
  }
  catch (err) {
    jobDone(jobId, 0, err instanceof Error ? err.message : String(err))
    throw err
  }
}

export function listFeatures(q: { runId?: string, nodeId?: string, violated?: boolean, limit?: number } = {}): RunFeatureRow[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (q.runId) {
    where.push('run_id = ?')
    params.push(q.runId)
  }
  if (q.nodeId) {
    where.push('node_id = ?')
    params.push(q.nodeId)
  }
  if (q.violated != null) {
    where.push('violated = ?')
    params.push(q.violated ? 1 : 0)
  }
  const rows = edaDb().prepare(`SELECT * FROM eda_run_features ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(Math.round(Number(q.limit)) || 100, 1), 500)) as Array<Record<string, unknown>>
  return rows.map(rowOf)
}

export function listFeatureJobs(limit = 50): Array<{ id: string, runId: string, status: string, features: number, error?: string, createdAt: string }> {
  const rows = edaDb().prepare('SELECT * FROM eda_feature_jobs ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(r => ({
    id: String(r.id), runId: String(r.run_id), status: String(r.status),
    features: Number(r.features ?? 0), error: r.error == null ? undefined : String(r.error), createdAt: String(r.created_at ?? ''),
  }))
}
