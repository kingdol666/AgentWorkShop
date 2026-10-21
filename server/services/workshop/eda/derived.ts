/**
 * M3 派生数据集管道 —— 「自动数据处理」的落点(纯 TS 算子,无 Python)。
 *
 * 流程:源查询(/daq/query 同参数面)→ 算子管道(逐序列顺序应用)→ CSV 落
 * <dataDir>/eda-derived/<jobId>/data.csv + manifest.json → 登记 eda_export_jobs
 * (kind='derived-dataset',result.dir/files)—— 台账/下载(export-file 白名单已含
 * data.csv)/权限完全复用导出设施。
 * 算子白名单:movavg(滑动均值 window)/delta(一阶差分)/shift(period,环比差;
 * 同比=shift+重采样由 bucket 承担)。变换在服务端做,避免大 payload 下沉前端。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'
import { dataQuery } from './data-query'

export const DERIVED_OPS = ['movavg', 'delta', 'shift'] as const
export type DerivedOpKind = typeof DERIVED_OPS[number]

export interface DerivedOp { kind: DerivedOpKind, window?: number, period?: number }

export interface DerivedSpec {
  lineId?: string
  nodeIds: string[]
  fromMs: number
  toMs: number
  bucketMs?: number
  agg?: 'avg' | 'min' | 'max'
  ops: DerivedOp[]
}

export function applyOps(points: Array<{ at: number, v: number }>, ops: DerivedOp[]): Array<{ at: number, v: number }> {
  let cur = points.map(p => ({ ...p }))
  for (const op of ops) {
    if (op.kind === 'movavg') {
      const w = Math.max(1, Math.round(Number(op.window) || 5))
      cur = cur.map((_, i) => {
        const from = Math.max(0, i - w + 1)
        const win = cur.slice(from, i + 1)
        return { at: cur[i]!.at, v: Number((win.reduce((a, b) => a + b.v, 0) / win.length).toFixed(6)) }
      })
    }
    else if (op.kind === 'delta') {
      cur = cur.map((p, i) => ({ at: p.at, v: i === 0 ? 0 : Number((p.v - cur[i - 1]!.v).toFixed(6)) }))
    }
    else if (op.kind === 'shift') {
      const p0 = Math.max(1, Math.round(Number(op.period) || 1))
      cur = cur.map((p, i) => ({ at: p.at, v: i >= p0 ? Number((p.v - cur[i - p0]!.v).toFixed(6)) : 0 }))
    }
  }
  return cur
}

export async function createDerivedDataset(user: ResolvedUser, spec: DerivedSpec, title: string): Promise<{ jobId: string, dir: string, rows: number }> {
  const ops = (spec.ops ?? []).filter(o => DERIVED_OPS.includes(o.kind))
  if (!ops.length) throw new Error('ops 至少提供一个合法算子(movavg/delta/shift)。')
  const q = await dataQuery(user, {
    lineId: spec.lineId,
    nodeIds: spec.nodeIds,
    fromMs: spec.fromMs,
    toMs: spec.toMs,
    bucketMs: spec.bucketMs,
    agg: spec.agg ?? 'avg',
  })
  const series = q.series
  if (!series.length) throw new Error('源查询无数据,无法派生。')
  const jobId = `edajob-${randomUUID().slice(0, 8)}`
  const dir = join(ensureDataDir(), 'eda-derived', jobId)
  mkdirSync(dir, { recursive: true })
  // 宽表 CSV:time + 每序列一列(派生后)
  const ats = new Set<number>()
  for (const s of series) for (const p of s.points) ats.add(p.at)
  const sorted = [...ats].sort((a, b) => a - b)
  const derived = series.map((s) => {
    const transformed = applyOps(s.points, ops)
    return { name: `${s.name}(${s.nodeId})`, unit: s.unit, map: new Map(transformed.map(p => [p.at, p.v])) }
  })
  const rows: string[] = [`time,${derived.map(d => `"${d.name}${d.unit ? ` [${d.unit}]` : ''}"`).join(',')}`]
  for (const at of sorted) {
    rows.push([new Date(at).toISOString(), ...derived.map(d => (d.map.has(at) ? String(d.map.get(at)) : ''))].join(','))
  }
  writeFileSync(join(dir, 'data.csv'), rows.join('\r\n'), 'utf8')
  const manifest = {
    schema: 'aw.eda-derived/1',
    jobId,
    title,
    source: { lineId: spec.lineId ?? null, nodeIds: spec.nodeIds, fromMs: spec.fromMs, toMs: spec.toMs, bucketMs: q.window.bucketMs, agg: spec.agg ?? 'avg' },
    ops: spec.ops,
    rows: sorted.length,
    series: series.map(s => s.nodeId),
    created_at: new Date().toISOString(),
    createdBy: user.id,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_export_jobs (id, kind, spec_json, status, result_json, created_by, created_at, updated_at)
    VALUES (?, 'derived-dataset', ?, 'ready', ?, ?, ?, ?)`)
    .run(jobId, JSON.stringify({ ...spec, title }), JSON.stringify({ dir, files: [{ nodeId: 'derived', rows: sorted.length }], totalRows: sorted.length }), user.id, now, now)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'data.derive', kind: 'daq', targetKind: 'eda-derived', targetId: jobId,
    lineId: spec.lineId ?? '', scope: 'line',
    summary: `派生数据集「${title}」(${series.length} 序列 × ${sorted.length} 行,算子 ${ops.map(o => o.kind).join('→')})`,
    detail: { jobId, ops: spec.ops },
  })
  return { jobId, dir, rows: sorted.length }
}
