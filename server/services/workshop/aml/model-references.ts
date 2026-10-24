/**
 * 模型引用保护(C13/A19):删除模型前扫描所有引用面,命中任一即 409 并列出引用者。
 *
 * 覆盖:
 *  - aml_channel_profiles.bound_model_id(优化 Channel 绑定)
 *  - aml_training_plans.last_model_id(训练计划最近产物)
 *  - optimizer_profiles.model_ref(Optimizer Profile;retired 不算占用)
 *  - 在途训练/Solver 租约(进程内台账,跨介质事务不存在,只能进程内保证)
 *
 * 说明:retention 清理工件前也调用同一函数,避免"台账行还在、工件被 GC"。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'

export interface ModelReference {
  kind: 'channel_profile' | 'training_plan' | 'optimizer_profile' | 'lease'
  id: string
  detail?: string
}

/** 在途模型租约台账(Solver/Training 使用期间阻止工件 GC)。 */
const leases = new Map<string, { count: number, holders: Set<string> }>()

export interface ModelLease {
  modelId: string
  holder: string
  release(): void
}

export function acquireModelLease(modelId: string, holder: string): ModelLease {
  const cur = leases.get(modelId) ?? { count: 0, holders: new Set<string>() }
  cur.count++
  cur.holders.add(holder)
  leases.set(modelId, cur)
  let released = false
  return {
    modelId,
    holder,
    release() {
      if (released) return
      released = true
      const row = leases.get(modelId)
      if (!row) return
      row.count = Math.max(0, row.count - 1)
      row.holders.delete(holder)
      if (row.count === 0) leases.delete(modelId)
    },
  }
}

export function inFlightModelLeases(): Array<{ modelId: string, count: number, holders: string[] }> {
  return [...leases.entries()].map(([modelId, v]) => ({ modelId, count: v.count, holders: [...v.holders] }))
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table))
}

export function modelReferences(db: DatabaseSync, modelId: string): ModelReference[] {
  const refs: ModelReference[] = []
  if (tableExists(db, 'aml_channel_profiles')) {
    const rows = db.prepare('SELECT channel_id FROM aml_channel_profiles WHERE bound_model_id = ?').all(modelId) as Array<{ channel_id: string }>
    for (const row of rows) refs.push({ kind: 'channel_profile', id: row.channel_id, detail: '优化 Channel 绑定' })
  }
  if (tableExists(db, 'aml_training_plans')) {
    const rows = db.prepare('SELECT id FROM aml_training_plans WHERE last_model_id = ?').all(modelId) as Array<{ id: string }>
    for (const row of rows) refs.push({ kind: 'training_plan', id: row.id, detail: '训练计划最近产物' })
  }
  if (tableExists(db, 'optimizer_profiles')) {
    const rows = db.prepare('SELECT id, version, status FROM optimizer_profiles WHERE model_ref = ? AND status != \'retired\'').all(modelId) as Array<{ id: string, version: number, status: string }>
    for (const row of rows) refs.push({ kind: 'optimizer_profile', id: `${row.id}@${row.version}`, detail: `Profile 状态 ${row.status}` })
  }
  const lease = leases.get(modelId)
  if (lease) refs.push({ kind: 'lease', id: modelId, detail: `在途租约 ${lease.count}(${[...lease.holders].join(', ')})` })
  return refs
}

export function assertModelNotReferenced(db: DatabaseSync, modelId: string): void {
  const refs = modelReferences(db, modelId)
  if (!refs.length) return
  const detail = refs.map(r => `${r.kind}:${r.id}${r.detail ? `(${r.detail})` : ''}`).join('; ')
  throw new AppError(409, 'MODEL_IN_USE', `模型 ${modelId} 仍被引用,拒绝删除:${detail}`)
}
