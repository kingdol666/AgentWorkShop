/**
 * 用户面 DAQ 批量导出服务(plan1 M1)。
 *
 * 与 Agent 面差异:授权 = 可读产线(readonly+)的节点集合(toolDaqExport 是 agent
 * 绑定口径);执行走同一 exportDaqDataset 核心(依赖注入,护栏沿用 7 天窗/200 万点
 * 每节点/400 万总行/保留 50 目录)。任务经 eda_export_jobs 账本异步执行:
 *  - 并发=1 队列(exportDaqDataset 全内存缓冲,并发多路会叠加内存尖峰 —— 评审 H4);
 *  - bootedAt 判死:进程重启后遗留 running 按失败呈现(mes_fetch_jobs 同款);
 *  - 产物目录仍落 <dataDir>/daq-exports/,台账存 id 引用(RETAIN_EXPORTS 清理旧目录
 *    后文件可能不存在 —— 读时探测并如实呈现,评审 H4)。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'

const WINDOW_MAX_MS = 7 * 24 * 3600_000
const NODES_MAX = 50
/** 进程启动时刻(跨进程判死基线) */
const bootedAt = new Date().toISOString()

export interface EdaExportJobView {
  id: string
  kind: string
  status: 'running' | 'ready' | 'failed'
  spec: { nodeIds: string[], fromMs: number, toMs: number, title: string, note: string, merge: boolean }
  result: { exportId?: string, dir?: string, files?: Array<{ nodeId: string, rows: number }>, totalRows?: number, truncated?: string[], mergedFile?: string, missing?: boolean }
  error?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

function rowToView(r: Record<string, unknown>): EdaExportJobView {
  return {
    id: String(r.id),
    kind: String(r.kind ?? 'daq-export'),
    status: String(r.status) as EdaExportJobView['status'],
    spec: safeJson(r.spec_json, { nodeIds: [], fromMs: 0, toMs: 0, title: '', note: '', merge: false }),
    result: safeJson(r.result_json, {} as EdaExportJobView['result']),
    error: r.error == null ? undefined : String(r.error),
    createdBy: String(r.created_by ?? ''),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
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

function jobById(id: string): EdaExportJobView | null {
  const r = edaDb().prepare('SELECT * FROM eda_export_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? rowToView(r) : null
}

function updateJob(id: string, patch: { status?: string, result?: unknown, error?: string }): void {
  edaDb().prepare('UPDATE eda_export_jobs SET status = COALESCE(?, status), result_json = COALESCE(?, result_json), error = ?, updated_at = ? WHERE id = ?')
    .run(patch.status ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), patch.error ?? null, new Date().toISOString(), id)
}

/** 进程重启判死:遗留 running 一律按失败呈现(一次性,模块首用时收口) */
let swept = false
function sweepStaleOnce(): void {
  if (swept) return
  swept = true
  try {
    edaDb().prepare(`UPDATE eda_export_jobs SET status = 'failed', error = '进程重启,任务中断(bootedAt 判死)', updated_at = ?
      WHERE status = 'running' AND created_at < ?`).run(bootedAt, bootedAt)
  }
  catch { /* 台账不可用不阻断导出 */ }
}

// ===== 并发=1 队列 =====
let queue: Promise<void> = Promise.resolve()

export function edaExportQueueResetForTest(): void {
  queue = Promise.resolve()
}

function enqueue(jobId: string): void {
  queue = queue.then(() => runExportJob(jobId)).catch(() => { /* 队列不因单任务失败断裂 */ })
}

async function runExportJob(jobId: string): Promise<void> {
  const job = jobById(jobId)
  if (!job || job.status !== 'running') return
  try {
    const { exportDaqDataset } = await import('../agents/industrial/daq-export')
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    await tsdbReady
    const { findDaqTemplate } = await import('../daq/daq-templates')
    const { getDcwLineRepo } = await import('../dcw/dcw-line.repo')
    const nodeOf = (id: string) => {
      const n = getDaqNodeRepo().byId(id)
      if (!n) return undefined
      const tpl = findDaqTemplate(n.templateKey)
      return {
        id: n.id, name: n.name, unit: n.unit ?? '', lineId: n.lineId ?? '',
        min: n.min, max: n.max, warnLow: n.warnLow, warnHigh: n.warnHigh,
        intervalMs: n.intervalMs ?? null, decimals: n.decimals,
        semantics: n.semantics || tpl?.semantics || tpl?.ch || '',
        signalKind: (tpl?.signalKind === 'vector' || tpl?.signalKind === 'image' ? tpl.signalKind : 'scalar') as 'scalar' | 'vector' | 'image',
        ...(tpl?.vector ? { vector: tpl.vector } : {}),
      }
    }
    const lineIds = [...new Set(job.spec.nodeIds.map(id => nodeOf(id)?.lineId ?? '').filter(Boolean))]
    const lines = lineIds.map((lid) => {
      const line = getDcwLineRepo().byId(lid)
      return { lineId: lid, lineName: line?.name ?? lid, description: '' }
    })
    const result = await exportDaqDataset({
      targets: job.spec.nodeIds,
      nodeOf,
      readPoints: (nodeId, win) => getTsdb().query(nodeId, win),
      fromMs: job.spec.fromMs,
      toMs: job.spec.toMs,
      title: job.spec.title,
      note: job.spec.note,
      lines,
      rootDir: join(ensureDataDir(), 'daq-exports'),
      merge: job.spec.merge,
      readFrames: (nodeId, win) => getTsdb().queryFrames(nodeId, win),
      readFrameContent: async (nodeId, at) => {
        const { getDaqController } = await import('../daq/daq-controller')
        return getDaqController().frameContent(nodeId, at, false)
      },
    })
    updateJob(jobId, {
      status: 'ready',
      result: {
        exportId: result.exportId,
        dir: result.dir,
        files: result.files.map(f => ({ nodeId: f.nodeId, rows: f.rows })),
        totalRows: result.totalRows,
        truncated: result.truncated,
        ...(result.mergedFile ? { mergedFile: result.mergedFile } : {}),
      },
    })
  }
  catch (err) {
    updateJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
  }
}

/** 可读节点 allowlist(readonly+;与 /data 数据源树同口径) */
function readableNodeIds(user: ResolvedUser): string[] {
  return getDaqNodeRepo().all().filter(n => n.enabled && lineMode(user, n.lineId) !== 'none').map(n => n.id)
}

export function startDaqExport(user: ResolvedUser, args: {
  lineId?: string
  nodeIds?: string[]
  fromMs?: number
  toMs?: number
  lastMinutes?: number
  title?: string
  note?: string
  merge?: boolean
}): EdaExportJobView {
  sweepStaleOnce()
  const allowed = new Set(readableNodeIds(user))
  if (allowed.size === 0) {
    throw Object.assign(new Error('你没有可读产线的数采节点,无权导出。'), { status: 403, code: 'SCOPE_VIOLATION' })
  }
  let targets = (args.nodeIds ?? []).map(s => String(s).trim()).filter(Boolean)
  if (targets.length > NODES_MAX) {
    throw Object.assign(new Error(`node_ids 一次最多 ${NODES_MAX} 个。`), { status: 400, code: 'VALIDATION_ERROR' })
  }
  if (targets.length > 0) {
    const illegal = targets.filter(id => !allowed.has(id))
    if (illegal.length > 0) {
      throw Object.assign(new Error(`无权导出节点:${illegal.join(', ')}。`), { status: 403, code: 'SCOPE_VIOLATION' })
    }
  }
  else {
    targets = [...allowed]
    if (args.lineId) targets = targets.filter((id) => {
      const n = getDaqNodeRepo().byId(id)
      return n?.lineId === args.lineId
    })
  }
  targets = [...new Set(targets)].filter(id => getDaqNodeRepo().byId(id))
  if (targets.length === 0) {
    throw Object.assign(new Error('没有可导出的节点(指定节点均不存在或不在可读产线上)。'), { status: 400, code: 'VALIDATION_ERROR' })
  }
  const toMs = Number(args.toMs) || Date.now()
  const fromMs = Number(args.fromMs) || toMs - (Number(args.lastMinutes) || 60) * 60_000
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw Object.assign(new Error('时间窗非法:from 必须小于 to。'), { status: 400, code: 'VALIDATION_ERROR' })
  }
  if (toMs - fromMs > WINDOW_MAX_MS) {
    throw Object.assign(new Error('时间窗超限(最大 7 天),请缩小窗口。'), { status: 400, code: 'VALIDATION_ERROR' })
  }
  const id = `edajob-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const spec = { nodeIds: targets, fromMs, toMs, title: String(args.title ?? '').slice(0, 200), note: String(args.note ?? '').slice(0, 500), merge: args.merge === true }
  edaDb().prepare(`INSERT INTO eda_export_jobs (id, kind, spec_json, status, result_json, created_by, created_at, updated_at)
    VALUES (?, 'daq-export', ?, 'running', '{}', ?, ?, ?)`).run(id, JSON.stringify(spec), user.id, now, now)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'data.export',
    kind: 'daq',
    targetKind: 'daq',
    targetId: id,
    lineId: args.lineId ?? '',
    scope: 'line',
    summary: `用户发起 DAQ 批量导出(${targets.length} 节点,窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()}${spec.merge ? ',merge 宽表' : ''})`,
    detail: { jobId: id, nodes: targets.length },
  })
  enqueue(id)
  return jobById(id)!
}

/** 可见 job = 创建者本人 ∪ 产线可读者 */
export function visibleExportJobs(user: ResolvedUser, limit = 50): EdaExportJobView[] {
  sweepStaleOnce()
  const rows = edaDb().prepare('SELECT * FROM eda_export_jobs ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(rowToView).filter((j) => {
    if (j.createdBy === user.id) return true
    return j.spec.nodeIds.some((id) => {
      const n = getDaqNodeRepo().byId(id)
      return !!n && lineMode(user, n.lineId) !== 'none'
    })
  })
}

export function getExportJobFor(user: ResolvedUser, id: string): EdaExportJobView | null {
  sweepStaleOnce()
  const job = jobById(id)
  if (!job) return null
  if (job.createdBy !== user.id && !visibleExportJobs(user, 200).some(j => j.id === id)) return null
  return { ...job, result: probeMissing(job) }
}

/** RETAIN_EXPORTS 清理后目录可能不存在:读时探测,missing 标记如实呈现(评审 H4) */
function probeMissing(job: EdaExportJobView): EdaExportJobView['result'] {
  if (job.status === 'ready' && job.result.dir && !existsSync(job.result.dir)) {
    return { ...job.result, missing: true }
  }
  return job.result
}

/** 产物文件安全下载:仅允许 manifest.json / merged.csv / nodes/<safe>.csv / README.md(路径穿越防护) */
export function resolveExportFile(user: ResolvedUser, jobId: string, rel: string): { abs: string, mime: string } | null {
  const job = getExportJobFor(user, jobId)
  if (!job || job.status !== 'ready' || !job.result.dir) return null
  const clean = String(rel ?? '').trim()
  if (!/^(manifest\.json|README\.md|merged\.csv|nodes\/[A-Za-z0-9_-]{1,80}\.csv)$/.test(clean)) return null
  const dir = job.result.dir
  const abs = join(dir, clean)
  if (!abs.startsWith(dir) || !existsSync(abs)) return null
  return { abs, mime: clean.endsWith('.json') ? 'application/json' : 'text/csv; charset=utf-8' }
}
