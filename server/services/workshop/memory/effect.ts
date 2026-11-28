/**
 * 记忆效果归因（批次 H，2026-11-27）。
 *
 * 只做相关性测量与保守动作：
 *  - 注入留痕：每次 recall 记录 refs（不复制正文）；
 *  - 任务终态按 task_id 关联一次（attributions 唯一约束防双计）；
 *  - channel 档经验 uses≥8 且失败率≥0.6 → 自动 withdrawn + 审计；line/product 只 flag；
 *  - 人工 restore 后 30 天内不再自动退役（防抖动）；
 *  - 绝不自动晋升 candidate→validated，也绝不自动改配方/参数。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../db/transaction'
import { getVersion, headVersionId, setVersionState } from '../experience/versions'
import { invalidateHarnessOverlayCache } from '../experience/overlay'
import { recordOps } from '../ops/ops'

export interface InjectionRef {
  id: string
  kind: string
  source: 'brief' | 'primer' | 'curated' | 'shared' | 'graph' | 'search'
  scopeKind?: string
  scopeKey?: string
}

export interface InjectionTraceInput {
  channelId: string
  agentId: string
  sessionId?: string | null
  taskId?: string | null
  refs: InjectionRef[]
}

/** 注入留痕（正文不入日志；refs 可还原到具体记忆/文档） */
export function recordMemoryInjection(db: DatabaseSync, input: InjectionTraceInput): string | null {
  if (input.refs.length === 0) return null
  try {
    const id = `inj-${randomUUID().slice(0, 12)}`
    db.prepare(
      `INSERT INTO memory_injection_log(id, channel_id, agent_id, session_id, task_id, refs_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.channelId, input.agentId, input.sessionId ?? '', input.taskId ?? '',
      JSON.stringify(input.refs), new Date().toISOString())
    return id
  }
  catch {
    return null
  }
}

export interface AttributionResult {
  attributed: number
  retired: string[]
  flagged: string[]
}

/**
 * 任务终态归因：同一 task 只计一次；无终态/无注入不产生统计。
 * success = COMPLETED/L2 approved；失败 = FAILED/CANCELED/驳回（由调用方传入）。
 */
export function attributeMemoryInjection(db: DatabaseSync, taskId: string, success: boolean): AttributionResult {
  const result: AttributionResult = { attributed: 0, retired: [], flagged: [] }
  if (!taskId) return result
  try {
    const logs = db.prepare(`SELECT id, refs_json AS refs FROM memory_injection_log WHERE task_id = ?`).all(taskId) as Array<{ id: string, refs: string }>
    if (logs.length === 0) return result
    const now = new Date().toISOString()
    const seen = new Set<string>()
    withTransaction(db, () => {
      for (const log of logs) {
        let refs: InjectionRef[]
        try {
          refs = JSON.parse(log.refs) as InjectionRef[]
        }
        catch {
          continue
        }
        for (const ref of refs) {
          if (!ref?.id || seen.has(ref.id)) continue
          seen.add(ref.id)
          const inserted = Number(db.prepare(
            `INSERT INTO memory_effect_attributions(id, memory_id, task_id, injection_id, outcome, created_at)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, memory_id) DO NOTHING`,
          ).run(`mea-${randomUUID().slice(0, 12)}`, ref.id, taskId, log.id, success ? 'success' : 'failure', now).changes ?? 0)
          if (inserted === 0) continue
          // 只有 experience 行进入效果统计（semantic/curated 不参与退役）
          const mem = db.prepare(`SELECT kind, scope_kind AS scopeKind, scope_key AS scopeKey, channel_id AS channelId FROM agent_memories WHERE id = ?`)
            .get(ref.id) as { kind?: string, scopeKind?: string, scopeKey?: string, channelId?: string } | undefined
          if (mem?.kind !== 'experience') continue
          db.prepare(
            `INSERT INTO memory_effect_stats(memory_id, uses, successes, failures, flagged, restored_at, updated_at)
             VALUES (?, 1, ?, ?, 0, NULL, ?)
             ON CONFLICT(memory_id) DO UPDATE SET uses = uses + 1,
               successes = successes + excluded.successes, failures = failures + excluded.failures,
               updated_at = excluded.updated_at`,
          ).run(ref.id, success ? 1 : 0, success ? 0 : 1, now)
          result.attributed++
          const stats = db.prepare(`SELECT uses, failures, flagged, restored_at AS restoredAt FROM memory_effect_stats WHERE memory_id = ?`)
            .get(ref.id) as { uses: number, failures: number, flagged: number, restoredAt: string | null } | undefined
          if (!stats || stats.uses < 8) continue
          const restoreFresh = stats.restoredAt ? Date.now() - Date.parse(stats.restoredAt) < 30 * 86_400_000 : false
          if (restoreFresh) continue
          if (stats.failures / stats.uses < 0.6) continue
          const channel = mem.channelId ?? ''
          if (mem.scopeKind === 'channel') {
            if (retireChannelExperience(db, ref.id)) {
              result.retired.push(ref.id)
              db.prepare(`UPDATE memory_effect_stats SET updated_at = ? WHERE memory_id = ?`).run(now, ref.id)
              try {
                recordOps({
                  actor: 'system:memory-effect',
                  actorName: '记忆效果归因',
                  actorKind: 'system',
                  action: 'experience.auto.withdraw',
                  kind: 'system',
                  targetKind: 'memory',
                  targetId: ref.id,
                  summary: `自动退役：注入 ${stats.uses} 次，失败率 ${(stats.failures / stats.uses * 100).toFixed(0)}%（channel 档；可人工恢复）`,
                  lineId: channel,
                })
              }
              catch { /* 审计失败不影响退役 */ }
              invalidateHarnessOverlayCache(channel)
            }
          }
          else if (stats.flagged === 0) {
            db.prepare(`UPDATE memory_effect_stats SET flagged = 1, updated_at = ? WHERE memory_id = ?`).run(now, ref.id)
            result.flagged.push(ref.id)
          }
        }
      }
    })
    return result
  }
  catch {
    return result
  }
}

function retireChannelExperience(db: DatabaseSync, memoryId: string): boolean {
  try {
    const versionId = headVersionId(db, memoryId)
    if (!versionId) return false
    const version = getVersion(db, versionId)
    if (!version) return false
    if (version.lifecycle !== 'validated') return false
    if (version.deployment !== 'active' && version.deployment !== 'canary') return false
    setVersionState(db, versionId, { deployment: 'withdrawn' }, 'system:memory-effect')
    return true
  }
  catch {
    return false
  }
}

/** 人工恢复标记：30 天内不再自动退役 */
export function markMemoryRestored(db: DatabaseSync, memoryId: string): void {
  try {
    db.prepare(
      `INSERT INTO memory_effect_stats(memory_id, uses, successes, failures, flagged, restored_at, updated_at)
       VALUES (?, 0, 0, 0, 0, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET restored_at = excluded.restored_at, updated_at = excluded.updated_at`,
    ).run(memoryId, new Date().toISOString(), new Date().toISOString())
  }
  catch { /* 恢复标记失败不阻断人工动作 */ }
}

export function effectStatsOf(db: DatabaseSync, memoryId: string): { uses: number, successes: number, failures: number, flagged: boolean, restoredAt: string | null } | null {
  try {
    const row = db.prepare(
      `SELECT uses, successes, failures, flagged, restored_at AS restoredAt FROM memory_effect_stats WHERE memory_id = ?`,
    ).get(memoryId) as { uses: number, successes: number, failures: number, flagged: number, restoredAt: string | null } | undefined
    if (!row) return null
    return { ...row, flagged: Number(row.flagged) === 1 }
  }
  catch {
    return null
  }
}

/** 90 天清理（维护定时器） */
export function cleanupInjectionLogs(db: DatabaseSync, days = 90): number {
  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    return Number(db.prepare('DELETE FROM memory_injection_log WHERE created_at < ?').run(cutoff).changes ?? 0)
  }
  catch {
    return 0
  }
}
