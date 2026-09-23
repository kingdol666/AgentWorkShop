/**
 * HitlRequest 仓储 —— v17 HITL 持久化事实源(hitl_requests)。
 *
 * 定位(主计划 §13.4):`hitl-registry` 只是进程内缓存门面;重启恢复、并发审批
 * 抢占、策略资格判定都必须以本表为准。
 *
 * 状态机:
 *   pending → resolving → answered | approved | rejected | cancelled | expired | failed
 *                      ↘ delivery_unknown → reconciling →(answered|failed)
 *
 * 决策抢占必须用**条件更新**(`WHERE id=? AND status='pending'`),返回受影响行数:
 * 只有 changes>0 的那一个调用者获得决策权,其余拿到 409(并发审批只允许一个成功)。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HitlRequestRow } from './database'

const COLS = `id, kind, request_type AS requestType, native_request_id AS nativeRequestId, channel_id AS channelId,
  agent_id AS agentId, agent_name AS agentName, session_id AS sessionId, harness, mode, title, detail,
  options_json AS optionsJson, questions_json AS questionsJson, schema_json AS schemaJson, status, policy,
  policy_snapshot_json AS policySnapshotJson, policy_version AS policyVersion, decision_id AS decisionId,
  responder_user_id AS responderUserId, decision_json AS decisionJson, native_confirmed AS nativeConfirmed,
  error, created_at AS createdAt, updated_at AS updatedAt, resolved_at AS resolvedAt, expires_at AS expiresAt`

/** 持久化状态(与 registry 的 AepHitlResolved.outcome 是三值映射关系) */
export type HitlStatus
  = 'pending'
    | 'resolving'
    | 'answered'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | 'failed'
    | 'delivery_unknown'
    | 'reconciling'

/** 终态集合(不再可决策) */
export const HITL_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'answered', 'approved', 'rejected', 'cancelled', 'expired', 'failed',
])

export type HitlRequestType = 'question' | 'approval'

/** 创建时冻结的策略快照(资格判定 = 创建时资格 ∩ 当前资格,§13.4) */
export interface HitlPolicySnapshot {
  /** owner_only | any_member */
  policy: string
  /** 创建时 channel 策略版本(设置变更会 +1) */
  policyVersion: number
  /** 创建时对该 Channel 有审批资格的用户 id(冻结集合) */
  eligibleUserIds: string[]
  /** 创建时的 membership generation(退出再加入的用户失去旧资格) */
  memberGenerations: Record<string, number>
  createdAt: string
}

export interface HitlRequestCreateInput {
  id?: string
  kind: string
  requestType: HitlRequestType
  nativeRequestId?: string
  channelId: string
  agentId: string
  agentName?: string
  sessionId?: string
  harness?: string
  mode?: string
  title?: string
  detail?: string
  options?: string[]
  questions?: unknown[]
  schema?: Record<string, unknown>
  policy: string
  policySnapshot: HitlPolicySnapshot
  expiresAt?: string | null
}

export type HitlRequestRepo = ReturnType<typeof createHitlRequestRepo>

export function createHitlRequestRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO hitl_requests (id, kind, request_type, native_request_id, channel_id, agent_id, agent_name, session_id, harness, mode, title, detail, options_json, questions_json, schema_json, status, policy, policy_snapshot_json, policy_version, decision_id, responder_user_id, decision_json, native_confirmed, error, created_at, updated_at, resolved_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, '{}', 0, '', ?, ?, NULL, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE id = ?`)
  const selectByKindId = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE kind = ? AND id = ?`)
  const selectByNative = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE kind = ? AND native_request_id = ? LIMIT 1`)
  const selectPendingByChannel = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE channel_id = ? AND status IN ('pending', 'resolving') ORDER BY created_at ASC`)
  const selectPendingAll = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE status IN ('pending', 'resolving') ORDER BY created_at ASC`)
  const selectNonTerminal = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE status NOT IN ('answered', 'approved', 'rejected', 'cancelled', 'expired', 'failed') ORDER BY created_at ASC`)
  const selectRecent = db.prepare(`SELECT ${COLS} FROM hitl_requests ORDER BY created_at DESC LIMIT ?`)
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM hitl_requests WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`)
  const countByStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM hitl_requests GROUP BY status`)
  /** 条件抢占:仅当仍 pending 时才能置 resolving(并发审批的原子闸门) */
  const claimStmt = db.prepare(
    `UPDATE hitl_requests SET status = 'resolving', decision_id = ?, responder_user_id = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
  const finalizeStmt = db.prepare(
    `UPDATE hitl_requests SET status = ?, decision_json = ?, native_confirmed = ?, error = ?, updated_at = ?, resolved_at = ?
     WHERE id = ? AND status IN ('pending', 'resolving', 'delivery_unknown', 'reconciling')`,
  )
  const markDeliveryUnknownStmt = db.prepare(
    `UPDATE hitl_requests SET status = 'delivery_unknown', error = ?, updated_at = ? WHERE id = ? AND status = 'resolving'`,
  )
  const markReconcilingStmt = db.prepare(
    `UPDATE hitl_requests SET status = 'reconciling', updated_at = ? WHERE id = ? AND status = 'delivery_unknown'`,
  )
  /** 抢占回落:resolving 因原生调用失败需让出(回到 pending,允许他人重试或标记 failed) */
  const releaseClaimStmt = db.prepare(
    `UPDATE hitl_requests SET status = 'pending', decision_id = NULL, responder_user_id = NULL, error = ?, updated_at = ?
     WHERE id = ? AND status = 'resolving'`,
  )

  return {
    create(input: HitlRequestCreateInput): HitlRequestRow {
      const id = input.id ?? randomUUID()
      const now = new Date().toISOString()
      insert.run(
        id, input.kind, input.requestType, input.nativeRequestId ?? '', input.channelId, input.agentId,
        input.agentName ?? '', input.sessionId ?? '', input.harness ?? '', input.mode ?? input.requestType,
        input.title ?? '', input.detail ?? '',
        JSON.stringify(input.options ?? []), JSON.stringify(input.questions ?? []), JSON.stringify(input.schema ?? {}),
        input.policy, JSON.stringify(input.policySnapshot), input.policySnapshot.policyVersion ?? 0,
        now, now, input.expiresAt ?? null,
      )
      return selectById.get(id) as unknown as HitlRequestRow
    },

    findById(id: string): HitlRequestRow | undefined {
      return (selectById.get(id) as unknown as HitlRequestRow | undefined) ?? undefined
    },

    find(kind: string, id: string): HitlRequestRow | undefined {
      return (selectByKindId.get(kind, id) as unknown as HitlRequestRow | undefined) ?? undefined
    },

    /** 原生 requestId 反查(重启后重挂/去重) */
    findByNativeRequestId(kind: string, nativeRequestId: string): HitlRequestRow | undefined {
      return (selectByNative.get(kind, nativeRequestId) as unknown as HitlRequestRow | undefined) ?? undefined
    },

    listPending(channelId?: string): HitlRequestRow[] {
      return channelId
        ? selectPendingByChannel.all(channelId) as unknown as HitlRequestRow[]
        : selectPendingAll.all() as unknown as HitlRequestRow[]
    },

    /** 非终态(含 delivery_unknown/reconciling;启动恢复的对账清单) */
    listNonTerminal(): HitlRequestRow[] {
      return selectNonTerminal.all() as unknown as HitlRequestRow[]
    },

    listRecent(limit = 100): HitlRequestRow[] {
      return selectRecent.all(limit) as unknown as HitlRequestRow[]
    },

    listByChannel(channelId: string, limit = 100): HitlRequestRow[] {
      return selectByChannel.all(channelId, limit) as unknown as HitlRequestRow[]
    },

    counts(): Record<string, number> {
      const rows = countByStatus.all() as unknown as Array<{ status: string, n: number }>
      const out: Record<string, number> = {}
      for (const r of rows) out[r.status] = Number(r.n)
      return out
    },

    /**
     * 原子抢占 pending → resolving。
     * 返回 true = 本次调用获得决策权(唯一);false = 已被他人抢占/已终态 → 上层返回 409。
     */
    claimPending(id: string, decisionId: string, responderUserId: string): boolean {
      return Number(claimStmt.run(decisionId, responderUserId, new Date().toISOString(), id).changes ?? 0) > 0
    },

    /** 落终态。`nativeConfirmed` 必须由 adapter 的引擎确认结果决定(§8 步骤 7)。 */
    finalize(id: string, status: HitlStatus, opts: {
      decision?: Record<string, unknown>
      nativeConfirmed: boolean
      error?: string
    }): boolean {
      return Number(finalizeStmt.run(
        status,
        JSON.stringify(opts.decision ?? {}),
        opts.nativeConfirmed ? 1 : 0,
        (opts.error ?? '').slice(0, 500),
        new Date().toISOString(),
        new Date().toISOString(),
        id,
      ).changes ?? 0) > 0
    },

    /** 原生调用结果未知 → delivery_unknown(不重试、不标记成功) */
    markDeliveryUnknown(id: string, error: string): boolean {
      return Number(markDeliveryUnknownStmt.run(error.slice(0, 500), new Date().toISOString(), id).changes ?? 0) > 0
    },

    markReconciling(id: string): boolean {
      return Number(markReconcilingStmt.run(new Date().toISOString(), id).changes ?? 0) > 0
    },

    /** 抢占回落(原生调用明确失败且未产生副作用时) */
    releaseClaim(id: string, error = ''): boolean {
      return Number(releaseClaimStmt.run(error.slice(0, 500), new Date().toISOString(), id).changes ?? 0) > 0
    },

    /**
     * 启动恢复:重启后**绝不自动批准**。
     * 把所有非终态置 failed(error 说明原生会话已随进程消失),返回受影响行数。
     * `resumable` 谓词允许调用方保留真正可恢复的条目(如 dcw 内存审批必定不可恢复)。
     */
    failAllNonTerminalOnRestart(error = '服务重启,原生会话已失效,未自动批准'): number {
      return Number(db.prepare(
        `UPDATE hitl_requests SET status = 'failed', error = ?, updated_at = ?, resolved_at = ?
         WHERE status NOT IN ('answered', 'approved', 'rejected', 'cancelled', 'expired', 'failed')`,
      ).run(error, new Date().toISOString(), new Date().toISOString()).changes ?? 0)
    },
  }
}
