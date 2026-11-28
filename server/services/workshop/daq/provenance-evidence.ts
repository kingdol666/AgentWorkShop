/**
 * 操作 → 数采证据快照（批次 N2，2026-11-26）。
 *
 * 为什么必须快照：原始样本有保留期（默认 30 天）且逐产线可覆写；操作台账
 * 需要回答「当时前后数采是多少」，不能等 raw 过期后只剩一句“查不到”。
 * 这里把 pre/post 统计与 ≤120 点降采样序列固化到操作行旁边，raw 清理不影响。
 *
 * 纪律：
 *  - 先 run+tags（最可信），无 run/标签才退回 node+时间窗，并如实标 `join_quality`；
 *  - 无数据 → `missing_reason`（no_samples/raw_expired/target_missing），**绝不插值**；
 *  - 采集失败只影响快照，不改变干预/写入语义（调用方 fire-and-forget）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getTsdb, tsdbRetentionInfo } from '../daq/storage'
import type { TsdbPoint } from '../daq/storage/tsdb-port'

const SERIES_MAX_POINTS = 120
const QUERY_LIMIT = 800

export interface DaqStats {
  count: number
  mean: number | null
  min: number | null
  max: number | null
  first: number | null
  last: number | null
}

export interface CaptureResult {
  ok: boolean
  evidenceId?: string
  joinQuality: 'run+tags' | 'time-window' | 'none'
  sampleCount: number
  rawAvailable: boolean
  missingReason: string
}

interface InterventionLite {
  id: string
  ts: string
  line_id: string
  node_id: string
  node_name: string
  target_node_id: string | null
  recipe_run_id: string | null
  settle_ms: number | null
  product_id: string
  recipe_id: string
  recipe_revision: string
  attempt_id: string
}

const emptyStats = (): DaqStats => ({ count: 0, mean: null, min: null, max: null, first: null, last: null })

function statsOf(points: TsdbPoint[]): DaqStats {
  const values = points.map(p => (typeof p.value === 'number' ? p.value : p.avg)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (values.length === 0) return emptyStats()
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    count: values.length,
    mean: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    first: values[0]!,
    last: values[values.length - 1]!,
  }
}

/** 降采样：等步长抽样，始终保留首尾点（≤120 点） */
function downsample(points: TsdbPoint[]): Array<{ at: number, value: number | null, state?: string, quality?: string }> {
  const serial = points.map(p => ({
    at: p.at,
    value: typeof p.value === 'number' ? p.value : (typeof p.avg === 'number' ? p.avg : null),
    ...(p.state ? { state: p.state } : {}),
    ...(p.quality ? { quality: p.quality } : {}),
  }))
  if (serial.length <= SERIES_MAX_POINTS) return serial
  const step = (serial.length - 1) / (SERIES_MAX_POINTS - 1)
  const out: typeof serial = []
  for (let i = 0; i < SERIES_MAX_POINTS; i++) {
    const idx = i === SERIES_MAX_POINTS - 1 ? serial.length - 1 : Math.round(i * step)
    const point = serial[idx]
    if (point && out[out.length - 1]?.at !== point.at) out.push(point)
  }
  return out
}

function qualityOf(points: TsdbPoint[], windowMs: number): Record<string, unknown> {
  if (points.length < 2) {
    return { underpowered: true, reason: points.length === 0 ? 'no_samples' : 'single_sample' }
  }
  const gaps: number[] = []
  for (let i = 1; i < points.length; i++) gaps.push(points[i]!.at - points[i - 1]!.at)
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0
  const maxGap = gaps[gaps.length - 1] ?? 0
  const expected = median > 0 ? Math.floor(windowMs / median) : 0
  const underpowered = expected > 0 && points.length < Math.max(3, Math.floor(expected * 0.3))
  return {
    underpowered,
    sampleCount: points.length,
    medianGapMs: median,
    maxGapMs: maxGap,
    coverageRatio: expected > 0 ? Math.min(1, points.length / expected) : null,
  }
}

/**
 * 采集并持久化一条干预的 DAQ 前后窗证据（幂等 upsert by intervention_id）。
 * 调用方不得让异常影响写入/判定主链。
 */
export async function captureOperationEvidence(db: DatabaseSync, interventionId: string): Promise<CaptureResult> {
  const row = db.prepare(
    `SELECT id, ts, line_id, node_id, node_name, target_node_id, recipe_run_id, settle_ms,
            product_id, recipe_id, recipe_revision, attempt_id
       FROM intervention_events WHERE id = ?`,
  ).get(interventionId) as InterventionLite | undefined
  if (!row) return { ok: false, joinQuality: 'none', sampleCount: 0, rawAvailable: false, missingReason: 'intervention_missing' }

  const eventMs = Date.parse(row.ts)
  if (!Number.isFinite(eventMs)) return { ok: false, joinQuality: 'none', sampleCount: 0, rawAvailable: false, missingReason: 'bad_event_ts' }
  const settleMs = Math.max(1_000, Number(row.settle_ms ?? 45_000))
  const target = row.target_node_id || row.node_id
  const preFrom = eventMs - settleMs
  const preTo = eventMs
  const postFrom = eventMs
  const postTo = eventMs + settleMs
  const nowMs = Date.now()

  // 原始样本保留期：窗口末端早于当前 raw cutoff 时，raw 已不可复算（快照仍保留历史值）
  let rawCutoff = nowMs - 720 * 3_600_000
  try {
    rawCutoff = nowMs - tsdbRetentionInfo().rawRetentionH * 3_600_000
  }
  catch { /* 保留期不可读 → 用保守默认 30 天 */ }
  const rawAvailable = postTo >= rawCutoff
  const effectivePostTo = Math.min(postTo, nowMs)

  const tsdb = getTsdb()
  const runId = row.recipe_run_id ?? ''
  let joinQuality: CaptureResult['joinQuality'] = 'none'
  let pre: TsdbPoint[] = []
  let post: TsdbPoint[] = []
  let query: Record<string, unknown> = {}

  const fetchWindow = async (fromMs: number, toMs: number, tagged: boolean): Promise<TsdbPoint[]> => {
    if (toMs <= fromMs) return []
    const q = {
      nodeIds: [target],
      fromMs,
      toMs,
      limit: QUERY_LIMIT,
      ...(tagged
        ? {
            ...(row.line_id ? { lineId: row.line_id } : {}),
            ...(row.product_id ? { productId: row.product_id } : {}),
            ...(row.recipe_id ? { recipeId: row.recipe_id } : {}),
            ...(runId ? { runId } : {}),
          }
        : {}),
    }
    query = { ...q }
    const map = await tsdb.queryTagged(q)
    const points = map.get(target) ?? []
    // 按窗口切（部分后端 limit 可能跨窗返回）
    return points.filter(p => p.at >= fromMs && p.at <= toMs).sort((a, b) => a.at - b.at)
  }

  try {
    if (runId) {
      pre = await fetchWindow(preFrom, preTo, true)
      post = await fetchWindow(postFrom, effectivePostTo, true)
      if (pre.length > 0 || post.length > 0) joinQuality = 'run+tags'
    }
    if (joinQuality === 'none') {
      // 无 run 或 run+tags 无命中 → 退回 node+时间窗（明确标注，不冒充 exact）
      pre = await fetchWindow(preFrom, preTo, false)
      post = await fetchWindow(postFrom, effectivePostTo, false)
      if (pre.length > 0 || post.length > 0) joinQuality = 'time-window'
    }
  }
  catch (err) {
    return { ok: false, joinQuality: 'none', sampleCount: 0, rawAvailable, missingReason: `query_failed:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}` }
  }

  const sampleCount = pre.length + post.length
  const missingReason = sampleCount > 0 ? '' : (!rawAvailable ? 'raw_expired' : 'no_samples')
  const evidenceId = `daqev-${randomUUID().slice(0, 12)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO operation_daq_evidence
      (id, intervention_id, attempt_id, written_node_id, target_node_id, line_id, product_id, recipe_id,
       recipe_revision, run_id, event_ts, pre_from_ms, pre_to_ms, post_from_ms, post_to_ms,
       pre_stats_json, post_stats_json, series_json, sample_count, quality_json, query_json,
       join_quality, raw_available, missing_reason, captured_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(intervention_id) DO UPDATE SET
       attempt_id = excluded.attempt_id, target_node_id = excluded.target_node_id, line_id = excluded.line_id,
       product_id = excluded.product_id, recipe_id = excluded.recipe_id, recipe_revision = excluded.recipe_revision,
       run_id = excluded.run_id, event_ts = excluded.event_ts, pre_from_ms = excluded.pre_from_ms,
       pre_to_ms = excluded.pre_to_ms, post_from_ms = excluded.post_from_ms, post_to_ms = excluded.post_to_ms,
       pre_stats_json = excluded.pre_stats_json, post_stats_json = excluded.post_stats_json,
       series_json = excluded.series_json, sample_count = excluded.sample_count,
       quality_json = excluded.quality_json, query_json = excluded.query_json,
       join_quality = excluded.join_quality, raw_available = excluded.raw_available,
       missing_reason = excluded.missing_reason, updated_at = excluded.updated_at`,
  ).run(
    evidenceId, row.id, row.attempt_id, row.node_id, row.target_node_id ?? target,
    row.line_id, row.product_id, row.recipe_id, row.recipe_revision, runId, row.ts,
    preFrom, preTo, postFrom, postTo,
    JSON.stringify(statsOf(pre)), JSON.stringify(statsOf(post)),
    JSON.stringify(downsample([...pre, ...post])), sampleCount,
    JSON.stringify({
      pre: qualityOf(pre, settleMs),
      post: qualityOf(post, settleMs),
    }),
    JSON.stringify(query), joinQuality, rawAvailable ? 1 : 0, missingReason, now, now,
  )

  return { ok: true, evidenceId, joinQuality, sampleCount, rawAvailable, missingReason }
}

/** 维护任务：对缺少快照且已过判读窗的干预补采（限流；raw 过期如实标 raw_expired） */
export async function backfillOperationEvidence(db: DatabaseSync, opts: { limit?: number, minAgeMs?: number } = {}): Promise<{ attempted: number, captured: number, failed: number }> {
  const minAgeMs = Math.max(0, opts.minAgeMs ?? 120_000)
  const cutoff = new Date(Date.now() - minAgeMs).toISOString()
  const rows = db.prepare(
    `SELECT e.id FROM intervention_events e
      WHERE e.ts <= ?
        AND NOT EXISTS (SELECT 1 FROM operation_daq_evidence d WHERE d.intervention_id = e.id)
      ORDER BY e.ts DESC LIMIT ?`,
  ).all(cutoff, Math.min(Math.max(opts.limit ?? 20, 1), 100)) as Array<{ id: string }>
  let captured = 0
  let failed = 0
  for (const row of rows) {
    try {
      const result = await captureOperationEvidence(db, row.id)
      if (result.ok) captured++
      else failed++
    }
    catch {
      failed++
    }
  }
  return { attempted: rows.length, captured, failed }
}
