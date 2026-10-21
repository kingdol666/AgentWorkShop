/**
 * E7 OCAP —— 越限处置记录(Alarm→OCAP 闭环的人为处置面)。
 *
 * 数据流:FDC/SPC 违例(ops 审计 fdc.violate/spc.violate)→ 用户开 OCAP 单
 * (关联 alarm 明细/run/节点)→ 记录处置步骤 → 关单(可弱关联 optimization_explorations
 * 与 rollback anchor;跨 JSON 存储不设 FK,孤儿引用呈现侧标 stale,评审 A-9)。
 * 通知侧:FDC 违例已走 notifyLineOperators;OCAP 开单/关单走 recordOps 审计。
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { recordOps } from '../ops/ops'
import { edaDb } from './eda-db'
import { edaRunById } from './eda-run.repo'

export interface OcapRow {
  id: string
  alarmId: string
  runId: string | null
  nodeId: string | null
  title: string
  steps: Array<{ at: string, by: string, text: string }>
  status: 'open' | 'closed' | 'void'
  closedBy: string | null
  closedAt: string | null
  linkedExplorationId: string | null
  linkedRollbackAnchor: string | null
  linkedExplorationExists: boolean | null
  ownerUserId: string | null
  createdAt: string
}

function rowOf(r: Record<string, unknown>): OcapRow {
  let steps: OcapRow['steps'] = []
  try {
    steps = JSON.parse(String(r.steps_json ?? '[]')) as OcapRow['steps']
  }
  catch { /* 坏 JSON 按空步骤 */ }
  return {
    id: String(r.id),
    alarmId: String(r.alarm_id ?? ''),
    runId: r.run_id == null ? null : String(r.run_id),
    nodeId: r.node_id == null ? null : String(r.node_id),
    title: String(r.title ?? ''),
    steps,
    status: String(r.status ?? 'open') as OcapRow['status'],
    closedBy: r.closed_by == null ? null : String(r.closed_by),
    closedAt: r.closed_at == null ? null : String(r.closed_at),
    linkedExplorationId: r.linked_exploration_id == null ? null : String(r.linked_exploration_id),
    linkedRollbackAnchor: r.linked_rollback_anchor == null ? null : String(r.linked_rollback_anchor),
    linkedExplorationExists: null,
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    createdAt: String(r.created_at ?? ''),
  }
}

/** 可读性:owner/admin 或记录的批次/节点落在可读产线 */
function canRead(user: ResolvedUser, row: OcapRow): boolean {
  if (row.ownerUserId === user.id || user.role === 'admin') return true
  try {
    if (row.runId) {
      const run = edaRunById(row.runId)
      if (run && lineMode(user, run.lineId) !== 'none') return true
    }
    if (row.nodeId) {
      const n = getDaqNodeRepo().byId(row.nodeId)
      if (n && lineMode(user, n.lineId) !== 'none') return true
    }
  }
  catch { /* 探测失败按不可读 */ }
  return false
}

export function listOcap(user: ResolvedUser, opts: { status?: string, limit?: number } = {}): OcapRow[] {
  const rows = edaDb().prepare('SELECT * FROM eda_ocap_records ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(Math.round(Number(opts.limit)) || 100, 1), 500)) as Array<Record<string, unknown>>
  return rows.map(rowOf).filter(r => canRead(user, r)).filter(r => (opts.status ? r.status === opts.status : true))
}

export function ocapById(user: ResolvedUser, id: string): OcapRow | null {
  const r = edaDb().prepare('SELECT * FROM eda_ocap_records WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  const row = rowOf(r)
  return canRead(user, row) ? enrich(row) : null
}

/** 弱关联存在性校验(孤儿标 stale 不报错,评审 A-9③) */
function enrich(row: OcapRow): OcapRow {
  if (row.linkedExplorationId) {
    try {
      const db = edaDb()
      const t = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name = \'optimization_explorations\'').get() as { name?: string } | undefined
      if (!t) {
        row.linkedExplorationExists = null
        return row
      }
      const hit = db.prepare('SELECT id FROM optimization_explorations WHERE id = ?').get(row.linkedExplorationId)
      row.linkedExplorationExists = Boolean(hit)
    }
    catch {
      row.linkedExplorationExists = null
    }
  }
  return row
}

export function createOcap(user: ResolvedUser, input: {
  alarmId: string
  runId?: string
  nodeId?: string
  title: string
}): OcapRow {
  if (!input.alarmId.trim()) throw new Error('alarm_id 必填(来自 ops 审计的 fdc.violate/spc.violate 记录 id)。')
  const id = `ocap-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  edaDb().prepare(`INSERT INTO eda_ocap_records (id, alarm_id, run_id, node_id, title, steps_json, status, owner_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, '[]', 'open', ?, ?)`)
    .run(id, input.alarmId, input.runId ?? null, input.nodeId ?? null, input.title.slice(0, 200), user.id, now)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'ocap.open', kind: 'alarm', level: 'warn',
    targetKind: 'ocap', targetId: id,
    summary: `开 OCAP 处置单「${input.title}」(alarm=${input.alarmId})`,
    detail: { runId: input.runId, nodeId: input.nodeId },
  })
  return ocapById(user, id)!
}

/** 追加处置步骤(open 态;关单后只读) */
export function addOcapStep(user: ResolvedUser, id: string, text: string): OcapRow {
  const row = ocapById(user, id)
  if (!row) throw new Error(`OCAP 不存在或不可见: ${id}`)
  if (row.status !== 'open') throw new Error('已关闭的 OCAP 不可追加步骤。')
  if (!row.ownerUserId || (row.ownerUserId !== user.id && user.role !== 'admin')) {
    throw new Error('仅 owner 或 admin 可追加处置步骤。')
  }
  const steps = [...row.steps, { at: new Date().toISOString(), by: user.name || user.id, text: text.slice(0, 500) }]
  edaDb().prepare('UPDATE eda_ocap_records SET steps_json = ? WHERE id = ?').run(JSON.stringify(steps), id)
  return ocapById(user, id)!
}

/** 关单/作废(弱关联可随关单补记) */
export function closeOcap(user: ResolvedUser, id: string, args: {
  status: 'closed' | 'void'
  linkedExplorationId?: string
  linkedRollbackAnchor?: string
}): OcapRow {
  const row = ocapById(user, id)
  if (!row) throw new Error(`OCAP 不存在或不可见: ${id}`)
  if (row.status !== 'open') throw new Error('该 OCAP 已终态。')
  if (!row.ownerUserId || (row.ownerUserId !== user.id && user.role !== 'admin')) {
    throw new Error('仅 owner 或 admin 可关闭 OCAP。')
  }
  edaDb().prepare('UPDATE eda_ocap_records SET status = ?, closed_by = ?, closed_at = ?, linked_exploration_id = COALESCE(?, linked_exploration_id), linked_rollback_anchor = COALESCE(?, linked_rollback_anchor) WHERE id = ?')
    .run(args.status, user.id, new Date().toISOString(), args.linkedExplorationId ?? null, args.linkedRollbackAnchor ?? null, id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'ocap.close', kind: 'alarm',
    targetKind: 'ocap', targetId: id,
    summary: `OCAP ${args.status === 'closed' ? '关单' : '作废'}「${row.title}」`,
    detail: { linkedExplorationId: args.linkedExplorationId, linkedRollbackAnchor: args.linkedRollbackAnchor },
  })
  return ocapById(user, id)!
}
