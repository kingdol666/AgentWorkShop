/**
 * E2 golden 参考轨迹服务(eda-enterprise E2)。
 *
 * golden = 某 good run 在 [started,ended] 窗口内的相位归一画像:
 *   phase = (ts-start)/(end-start) ∈ [0,1] 均分 n_bins 桶,逐桶聚合 mean/std/min/max。
 * 变长 run 的对齐问题由此消解(比较时两 run 都映到同一相位轴,物理上消除大部分时移)。
 * fingerprint = 各节点标量摘要(mean/std/min/max/cnt),与 runData 聚合同口径可交叉核对。
 * 相位网格化与 dataset-builder 的 alignToGrid 同思想(那里是等间隔时间网格,这里是相位网格)。
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { edaDb } from './eda-db'
import { edaRunById } from './eda-run.repo'

export interface GoldenBin { phase: number, mean: number | null, std: number | null, min: number | null, max: number | null }
export interface GoldenView {
  id: string
  recipeId: string
  nodeId: string
  sourceRunId: string
  nBins: number
  profile: GoldenBin[]
  fingerprint: Record<string, number>
  createdBy: string
  createdAt: string
}

function rowToView(r: Record<string, unknown>): GoldenView {
  return {
    id: String(r.id),
    recipeId: String(r.recipe_id),
    nodeId: String(r.node_id),
    sourceRunId: String(r.source_run_id ?? ''),
    nBins: Number(r.n_bins ?? 100),
    profile: safeArr(r.profile_json),
    fingerprint: safeObj(r.fingerprint_json),
    createdBy: String(r.created_by ?? ''),
    createdAt: String(r.created_at ?? ''),
  }
}
function safeArr(text: unknown): GoldenBin[] {
  try {
    return JSON.parse(String(text ?? '[]')) as GoldenBin[]
  }
  catch {
    return []
  }
}
function safeObj(text: unknown): Record<string, number> {
  try {
    return JSON.parse(String(text ?? '{}')) as Record<string, number>
  }
  catch {
    return {}
  }
}

export class GoldenError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function readableRun(user: ResolvedUser, runId: string) {
  const run = edaRunById(runId)
  if (!run) throw new GoldenError(404, 'NOT_FOUND', `批次不存在: ${runId}`)
  if (lineMode(user, run.lineId) === 'none') {
    throw new GoldenError(403, 'SCOPE_VIOLATION', `批次 ${runId} 不在你的可读产线上。`)
  }
  return run
}

/** 从 good run 构建某节点的 golden 画像并入库(upsert by recipe+node) */
export async function buildGolden(user: ResolvedUser, args: {
  runId: string
  nodeId: string
  nBins?: number
}): Promise<GoldenView> {
  const run = readableRun(user, args.runId)
  if (run.outcome !== 'good' && run.outcome !== 'open') {
    throw new GoldenError(400, 'VALIDATION_ERROR', `参考轨迹应取自 good 批次(当前 ${run.outcome});如确要使用,先把该批次标为 good。`)
  }
  if (!run.endedAt) throw new GoldenError(400, 'VALIDATION_ERROR', '该批次尚未关账,无完整窗口可作参考。')
  const node = getDaqNodeRepo().byId(args.nodeId)
  if (!node) throw new GoldenError(404, 'NOT_FOUND', `节点不存在: ${args.nodeId}`)
  const nBins = Math.min(Math.max(Math.round(Number(args.nBins)) || 100, 20), 400)
  const startMs = Date.parse(run.startedAt)
  const endMs = Date.parse(run.endedAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new GoldenError(400, 'VALIDATION_ERROR', '批次窗口非法。')
  }
  const { getTsdb, tsdbReady } = await import('../daq/storage')
  await tsdbReady
  const series = await getTsdb().queryTagged({
    runId: run.id,
    nodeIds: [node.id],
    fromMs: startMs,
    toMs: endMs,
    limit: 1_000_000,
  })
  const pts = (series.get(node.id) ?? []).map(p => ({ ts: p.at, v: p.value ?? p.avg ?? 0 })).filter(p => Number.isFinite(p.v))
  if (pts.length < nBins) {
    throw new GoldenError(400, 'VALIDATION_ERROR', `该批次窗口内样本不足(需要 ≥${nBins},实际 ${pts.length});请减小分桶数。`)
  }
  const width = (endMs - startMs) / nBins
  const bins: Array<{ s: number, s2: number, min: number, max: number, cnt: number }> = Array.from({ length: nBins }, () => ({ s: 0, s2: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, cnt: 0 }))
  for (const p of pts) {
    let b = Math.floor((p.ts - startMs) / width)
    if (b >= nBins) b = nBins - 1
    if (b < 0) b = 0
    const acc = bins[b]!
    acc.s += p.v
    acc.s2 += p.v * p.v
    acc.cnt += 1
    if (p.v < acc.min) acc.min = p.v
    if (p.v > acc.max) acc.max = p.v
  }
  const profile: GoldenBin[] = bins.map((acc, i) => {
    if (acc.cnt === 0) return { phase: Number((i / (nBins - 1)).toFixed(4)), mean: null, std: null, min: null, max: null }
    const mean = acc.s / acc.cnt
    const std = Math.sqrt(Math.max(0, acc.s2 / acc.cnt - mean * mean))
    return {
      phase: Number((i / (nBins - 1)).toFixed(4)),
      mean: Number(mean.toFixed(6)),
      std: Number(std.toFixed(6)),
      min: Number(acc.min.toFixed(6)),
      max: Number(acc.max.toFixed(6)),
    }
  })
  const vals = pts.map(p => p.v)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const fingerprint = {
    mean: Number(mean.toFixed(6)),
    std: Number(Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length).toFixed(6)),
    min: Number(Math.min(...vals).toFixed(6)),
    max: Number(Math.max(...vals).toFixed(6)),
    cnt: vals.length,
  }
  const id = `gld-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_golden_traces (id, recipe_id, node_id, source_run_id, n_bins, profile_json, fingerprint_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recipe_id, node_id) DO UPDATE SET
      id = excluded.id, source_run_id = excluded.source_run_id, n_bins = excluded.n_bins,
      profile_json = excluded.profile_json, fingerprint_json = excluded.fingerprint_json,
      created_by = excluded.created_by, created_at = excluded.created_at`)
    .run(id, run.recipeId, node.id, run.id, nBins, JSON.stringify(profile), JSON.stringify(fingerprint), user.id, now)
  return { id, recipeId: run.recipeId, nodeId: node.id, sourceRunId: run.id, nBins, profile, fingerprint, createdBy: user.id, createdAt: now }
}

export function getGolden(recipeId: string, nodeId: string): GoldenView | null {
  const r = edaDb().prepare('SELECT * FROM eda_golden_traces WHERE recipe_id = ? AND node_id = ?').get(recipeId, nodeId) as Record<string, unknown> | undefined
  return r ? rowToView(r) : null
}

export function listGolden(recipeId?: string): GoldenView[] {
  const rows = recipeId
    ? edaDb().prepare('SELECT * FROM eda_golden_traces WHERE recipe_id = ? ORDER BY created_at DESC').all(recipeId) as Array<Record<string, unknown>>
    : edaDb().prepare('SELECT * FROM eda_golden_traces ORDER BY created_at DESC LIMIT 200').all() as Array<Record<string, unknown>>
  return rows.map(rowToView)
}

export function deleteGolden(user: ResolvedUser, id: string): boolean {
  const r = edaDb().prepare('SELECT * FROM eda_golden_traces WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return false
  if (String(r.created_by ?? '') !== user.id && user.role !== 'admin') {
    throw new GoldenError(403, 'SCOPE_VIOLATION', '仅创建者或 admin 可删除 golden 参考轨迹。')
  }
  edaDb().prepare('DELETE FROM eda_golden_traces WHERE id = ?').run(id)
  return true
}

/**
 * 批次 vs golden 偏差分:相位轴上逐桶 |z|=(mean_run-golden.mean)/golden.std
 * (golden.std≈0 的桶跳过),报告=均分 + 最大偏差桶。评分只依赖两串相位画像,毫秒级。
 */
export async function deviationScore(user: ResolvedUser, args: {
  runId: string
  nodeId: string
}): Promise<{ score: number, maxBucket: number, bins: number, fingerprint: Record<string, number> }> {
  const run = readableRun(user, args.runId)
  if (!run.endedAt) throw new GoldenError(400, 'VALIDATION_ERROR', '该批次尚未关账。')
  const golden = getGolden(run.recipeId, args.nodeId)
  if (!golden) throw new GoldenError(404, 'NOT_FOUND', '该配方/节点尚无 golden 参考轨迹,请先从 good 批次生成。')
  const startMs = Date.parse(run.startedAt)
  const endMs = Date.parse(run.endedAt)
  const { getTsdb, tsdbReady } = await import('../daq/storage')
  await tsdbReady
  const series = await getTsdb().queryTagged({ runId: run.id, nodeIds: [args.nodeId], fromMs: startMs, toMs: endMs, limit: 1_000_000 })
  const pts = (series.get(args.nodeId) ?? []).map(p => ({ ts: p.at, v: p.value ?? p.avg ?? 0 })).filter(p => Number.isFinite(p.v))
  if (!pts.length) throw new GoldenError(400, 'VALIDATION_ERROR', '该批次窗口内无样本。')
  const width = (endMs - startMs) / golden.nBins
  const acc = new Map<number, { s: number, cnt: number }>()
  for (const p of pts) {
    let b = Math.floor((p.ts - startMs) / width)
    if (b >= golden.nBins) b = golden.nBins - 1
    const a = acc.get(b) ?? { s: 0, cnt: 0 }
    a.s += p.v
    a.cnt += 1
    acc.set(b, a)
  }
  let sum = 0
  let cnt = 0
  let maxBucket = -1
  let maxZ = 0
  for (const g of golden.profile) {
    const b = Math.round(g.phase * (golden.nBins - 1))
    const a = acc.get(b)
    if (!a || g.std == null || g.mean == null || g.std < 1e-9) continue
    const z = Math.abs(a.s / a.cnt - g.mean) / g.std
    sum += z
    cnt += 1
    if (z > maxZ) {
      maxZ = z
      maxBucket = b
    }
  }
  if (cnt === 0) throw new GoldenError(400, 'VALIDATION_ERROR', 'golden 与该批次无重叠有效相位桶。')
  return {
    score: Number((sum / cnt).toFixed(4)),
    maxBucket,
    bins: cnt,
    fingerprint: golden.fingerprint,
  }
}
