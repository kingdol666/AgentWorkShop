/**
 * 改进提案仓储（WP-D2）—— 反射器产出的「带证据候选」。
 *
 * 与写治理的分工：本表**只描述**建议（改哪个配方/入哪条知识/补哪段 runbook），
 * 执行永远走既有 HITL 工具（recipe_update / kb_agent ingest）。status 只反映
 * 提案自身的处理结果（pending→accepted/rejected/expired），不代表产线已改变。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExperienceEvidence } from './memory.repo'

export type ImprovementKind = 'recipe_update' | 'kb_ingest' | 'runbook'
export type ImprovementStatus = 'pending' | 'accepted' | 'rejected' | 'expired'

export interface ImprovementProposalRow {
  id: string
  kind: ImprovementKind
  channelId: string
  lineId: string
  recipeId: string
  sourceKind: string
  sourceId: string
  dedupKey: string
  title: string
  detail: string
  evidenceJson: string
  status: ImprovementStatus
  decidedBy: string
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ImprovementCreateInput {
  kind: ImprovementKind
  channelId: string
  lineId?: string
  recipeId?: string
  sourceKind: string
  sourceId: string
  title: string
  detail?: string
  evidence: ExperienceEvidence | string
}

const COLS = `id, kind, channel_id AS channelId, line_id AS lineId, recipe_id AS recipeId,
  source_kind AS sourceKind, source_id AS sourceId, dedup_key AS dedupKey, title, detail,
  evidence_json AS evidenceJson, status, decided_by AS decidedBy, decided_at AS decidedAt,
  created_at AS createdAt, updated_at AS updatedAt`

export type ImprovementRepo = ReturnType<typeof createImprovementRepo>

/**
 * 配方固化成功后收口该配方的 pending 提案（WP-D2）。
 * 独立函数：调用点在工业工具层（只拿到 db 单例），不需要构造整个仓储对象。
 */
export function markRecipeProposalsAccepted(db: DatabaseSync, recipeId: string, decidedBy: string): number {
  if (!recipeId) return 0
  const now = new Date().toISOString()
  return Number(db.prepare(
    `UPDATE improvement_proposals SET status = 'accepted', decided_by = ?, decided_at = ?, updated_at = ?
      WHERE recipe_id = ? AND status = 'pending'`,
  ).run(decidedBy, now, now, recipeId).changes ?? 0)
}

export function createImprovementRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO improvement_proposals
       (id, kind, channel_id, line_id, recipe_id, source_kind, source_id, dedup_key, title, detail,
        evidence_json, status, decided_by, decided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, ?, ?)`,
  )
  const listStmt = db.prepare(
    `SELECT ${COLS} FROM improvement_proposals WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
  const listByStatusStmt = db.prepare(
    `SELECT ${COLS} FROM improvement_proposals WHERE channel_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
  )
  const listPendingAllStmt = db.prepare(
    `SELECT ${COLS} FROM improvement_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`,
  )
  const getStmt = db.prepare(`SELECT ${COLS} FROM improvement_proposals WHERE id = ?`)
  const findByDedupStmt = db.prepare(`SELECT ${COLS} FROM improvement_proposals WHERE dedup_key = ?`)
  const markStmt = db.prepare(
    `UPDATE improvement_proposals SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
  )
  const countStmt = db.prepare(
    `SELECT status, COUNT(*) AS n FROM improvement_proposals WHERE channel_id = ? GROUP BY status`,
  )

  return {
    /** 建提案（dedup_key 幂等：重复事件不新增）；返回是否新建 */
    create(input: ImprovementCreateInput): { id: string, created: boolean } {
      const id = `ip-${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const now = new Date().toISOString()
      const dedupKey = `prop:${input.sourceKind}:${input.sourceId}`
      const evidenceJson = typeof input.evidence === 'string' ? input.evidence : JSON.stringify(input.evidence)
      const res = insertStmt.run(
        id, input.kind, input.channelId, input.lineId ?? '', input.recipeId ?? '',
        input.sourceKind, input.sourceId, dedupKey, input.title, input.detail ?? '',
        evidenceJson, now, now,
      )
      if (Number(res.changes ?? 0) > 0) return { id, created: true }
      const existing = findByDedupStmt.get(dedupKey) as ImprovementProposalRow | undefined
      return { id: existing?.id ?? id, created: false }
    },

    /** 频道维度列出（可按状态过滤） */
    listByChannel(channelId: string, opts: { status?: ImprovementStatus, limit?: number } = {}): ImprovementProposalRow[] {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
      return (opts.status
        ? listByStatusStmt.all(channelId, opts.status, limit)
        : listStmt.all(channelId, limit)) as unknown as ImprovementProposalRow[]
    },

    listPending(limit = 50): ImprovementProposalRow[] {
      return listPendingAllStmt.all(Math.min(Math.max(limit, 1), 200)) as unknown as ImprovementProposalRow[]
    },

    get(id: string): ImprovementProposalRow | null {
      return (getStmt.get(id) as ImprovementProposalRow | undefined) ?? null
    },

    findByDedup(dedupKey: string): ImprovementProposalRow | null {
      return (findByDedupStmt.get(dedupKey) as ImprovementProposalRow | undefined) ?? null
    },

    /** 状态迁移（HITL 执行成功后回写 accepted；人工驳回 rejected） */
    markStatus(id: string, status: ImprovementStatus, decidedBy = ''): boolean {
      return Number(markStmt.run(status, decidedBy, new Date().toISOString(), new Date().toISOString(), id).changes ?? 0) > 0
    },

    countsByStatus(channelId: string): Record<string, number> {
      const out: Record<string, number> = {}
      for (const r of countStmt.all(channelId) as Array<{ status: string, n: number }>) out[r.status] = Number(r.n)
      return out
    },
  }
}
