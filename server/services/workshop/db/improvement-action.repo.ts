/**
 * 元层成效仓储（WP-C3）—— 「改进的改进」：记录每类改进动作的结果。
 *
 * 与 exp-miner 置信度演化同语义（观察→候选→稳）：这里只提供**事实计数**，
 * 统计口径由 `improvementStats` 在 SQL 侧聚合（不做加权猜测）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type ActionDecision = 'accepted' | 'rejected' | 'expired' | 'promoted' | 'rolled_back'

export interface ImprovementActionInput {
  /** 动作类别：recipe_update|kb_ingest|runbook|experience_promote|profile_promote|profile_rollback */
  actionKind: string
  /** 主体类别：proposal|experience|harness_profile */
  subjectKind: string
  subjectId: string
  channelId?: string
  decision: ActionDecision
  /** 可选成效差（如 effect/配对 Δ；无则 null） */
  outcomeDelta?: number | null
  detail?: Record<string, unknown>
  decidedBy?: string
}

export type ImprovementActionRepo = ReturnType<typeof createImprovementActionRepo>

export function createImprovementActionRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO improvement_actions
       (id, action_kind, subject_kind, subject_id, channel_id, decision, outcome_delta, detail_json, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const statsStmt = db.prepare(
    `SELECT action_kind AS actionKind, decision, COUNT(*) AS n
       FROM improvement_actions WHERE channel_id = ?
      GROUP BY action_kind, decision
      ORDER BY action_kind`,
  )
  const statsAllStmt = db.prepare(
    `SELECT action_kind AS actionKind, decision, COUNT(*) AS n
       FROM improvement_actions GROUP BY action_kind, decision ORDER BY action_kind`,
  )

  return {
    /** 记录一次改进动作结果（UNIQUE(subject,decision) 幂等） */
    record(input: ImprovementActionInput): boolean {
      const res = insert.run(
        `ia-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        input.actionKind, input.subjectKind, input.subjectId, input.channelId ?? '',
        input.decision, input.outcomeDelta ?? null, JSON.stringify(input.detail ?? {}),
        input.decidedBy ?? '', new Date().toISOString(),
      )
      return Number(res.changes ?? 0) > 0
    },

    /**
     * 按 action_kind 聚合成功率（accepted+promoted 视为成功）。
     * 返回 `{ actionKind, total, success, rate }[]`（rate 保留 3 位小数）。
     */
    stats(channelId?: string): Array<{ actionKind: string, total: number, success: number, rate: number }> {
      const rows = (channelId
        ? statsStmt.all(channelId)
        : statsAllStmt.all()) as Array<{ actionKind: string, decision: string, n: number }>
      const acc = new Map<string, { total: number, success: number }>()
      for (const r of rows) {
        const cur = acc.get(r.actionKind) ?? { total: 0, success: 0 }
        cur.total += Number(r.n)
        if (r.decision === 'accepted' || r.decision === 'promoted') cur.success += Number(r.n)
        acc.set(r.actionKind, cur)
      }
      return [...acc.entries()]
        .map(([actionKind, v]) => ({
          actionKind,
          total: v.total,
          success: v.success,
          rate: v.total > 0 ? Math.round((v.success / v.total) * 1000) / 1000 : 0,
        }))
        .sort((a, b) => b.total - a.total)
    },
  }
}
