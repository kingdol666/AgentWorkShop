/**
 * 合规三表仓储:审批历史(S4)/ 报警事件(S5)/ 审计日志(R1)/ 高危复核(R3)。
 * 全部走 CREATE IF NOT EXISTS 幂等表(见 database.ts v11-v14);写入失败不得击穿主链路
 * (调用方 catch 后仅计数/告警)。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

// ===== S4:工具审批历史 =====

export interface ApprovalHistoryRow {
  id: string
  agentId: string
  nodeId: string
  kind: string
  detail: string
  status: string
  comment: string
  decidedBy: string
  decidedName: string
  createdAt: string
  decidedAt: string | null
}

const APPROVAL_COLS = `id, agent_id AS agentId, node_id AS nodeId, kind, detail, status,
  comment, decided_by AS decidedBy, decided_name AS decidedName, created_at AS createdAt, decided_at AS decidedAt`

export function createApprovalHistoryRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO approval_history
       (id, agent_id, node_id, kind, detail, status, comment, decided_by, decided_name, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const listStmt = db.prepare(
    `SELECT ${APPROVAL_COLS} FROM approval_history ORDER BY created_at DESC LIMIT ?`,
  )

  return {
    upsert(a: {
      id: string
      agentId: string
      nodeId: string
      kind: string
      detail: string
      status: string
      comment: string
      decidedBy?: string
      decidedName?: string
      createdAt: string
      decidedAt?: string | null
    }): void {
      insertStmt.run(
        a.id, a.agentId, a.nodeId, a.kind, a.detail, a.status, a.comment,
        a.decidedBy ?? '', a.decidedName ?? '', a.createdAt, a.decidedAt ?? null,
      )
    },
    /** 审批历史(重启后仍可查;cap 由调用方给,默认沿用内存 HISTORY_CAP 的量级) */
    list(limit = 200): ApprovalHistoryRow[] {
      return listStmt.all(limit as SQLInputValue) as unknown as ApprovalHistoryRow[]
    },
  }
}

// ===== S5:报警事件 =====

export interface AlarmEventRow {
  id: string
  nodeId: string
  nodeName: string
  metric: string
  value: number | null
  rule: string
  threshold: number | null
  ackedBy: string
  ackedAt: string | null
  escalation: number
  notifiedJson: string
  createdAt: string
}

const ALARM_COLS = `id, node_id AS nodeId, node_name AS nodeName, metric, value, rule, threshold,
  acked_by AS ackedBy, acked_at AS ackedAt, escalation, notified_json AS notifiedJson, created_at AS createdAt`

export function createAlarmEventRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO alarm_events
       (id, node_id, node_name, metric, value, rule, threshold, escalation, notified_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', ?)`,
  )
  const ackStmt = db.prepare(
    `UPDATE alarm_events SET acked_by = ?, acked_at = ? WHERE id = ? AND acked_at IS NULL`,
  )
  const escalateStmt = db.prepare(
    `UPDATE alarm_events SET escalation = escalation + 1 WHERE id = ?`,
  )
  const notifyStmt = db.prepare(
    `UPDATE alarm_events SET notified_json = ? WHERE id = ?`,
  )
  const openStmt = db.prepare(
    `SELECT ${ALARM_COLS} FROM alarm_events WHERE acked_at IS NULL ORDER BY created_at DESC LIMIT ?`,
  )
  const listStmt = db.prepare(
    `SELECT ${ALARM_COLS} FROM alarm_events ORDER BY created_at DESC LIMIT ?`,
  )

  return {
    /** 报警产生(同 node+metric 未确认报警幂等去重,防止高频越限刷表) */
    raise(a: {
      id: string
      nodeId: string
      nodeName: string
      metric: string
      value: number | null
      rule: string
      threshold: number | null
      createdAt: string
    }): boolean {
      const open = db.prepare(
        `SELECT id FROM alarm_events WHERE node_id = ? AND metric = ? AND acked_at IS NULL LIMIT 1`,
      ).get(a.nodeId, a.metric)
      if (open) return false
      insertStmt.run(a.id, a.nodeId, a.nodeName, a.metric, a.value, a.rule, a.threshold, a.createdAt)
      return true
    },
    ack(id: string, byUserId: string, byName: string, at: string): boolean {
      return ackStmt.run(byUserId, at, id).changes > 0
    },
    escalate(id: string): void {
      escalateStmt.run(id)
    },
    recordNotify(id: string, notifiedJson: string): void {
      notifyStmt.run(notifiedJson, id)
    },
    listOpen(limit = 100): AlarmEventRow[] {
      return openStmt.all(limit as SQLInputValue) as unknown as AlarmEventRow[]
    },
    list(limit = 200): AlarmEventRow[] {
      return listStmt.all(limit as SQLInputValue) as unknown as AlarmEventRow[]
    },
  }
}

// ===== R1:审计日志 =====

export interface AuditEntry {
  actor: string
  actorName: string
  actorKind: 'user' | 'agent'
  action: string
  targetKind?: string
  targetId?: string
  detail?: Record<string, unknown>
  at?: string
}

export function createAuditRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT INTO audit_log (actor, actor_name, actor_kind, action, target_kind, target_id, detail_json, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  return {
    append(e: AuditEntry): void {
      insertStmt.run(
        e.actor, e.actorName ?? '', e.actorKind ?? 'user', e.action,
        e.targetKind ?? '', e.targetId ?? '', JSON.stringify(e.detail ?? {}),
        e.at ?? new Date().toISOString(),
      )
    },
    query(opts: { actor?: string, targetId?: string, action?: string, limit?: number }): Array<Record<string, unknown>> {
      const where: string[] = []
      const args: SQLInputValue[] = []
      if (opts.actor) {
        where.push('actor = ?')
        args.push(opts.actor)
      }
      if (opts.targetId) {
        where.push('target_id = ?')
        args.push(opts.targetId)
      }
      if (opts.action) {
        where.push('action = ?')
        args.push(opts.action)
      }
      const key = `${where.join('|')}`
      let stmt = stmtCache.get(key)
      if (!stmt) {
        const sql = `SELECT id, actor, actor_name AS actorName, actor_kind AS actorKind, action,
          target_kind AS targetKind, target_id AS targetId, detail_json AS detailJson, at
          FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`
        stmt = db.prepare(sql)
        stmtCache.set(key, stmt)
      }
      return stmt.all(...args, (opts.limit ?? 200) as SQLInputValue) as Array<Record<string, unknown>>
    },
  }
}

// ===== R3:高危管理操作复核 =====

export interface ApprovalRequestRow {
  id: string
  action: string
  targetId: string
  payloadJson: string
  summary: string
  requestedBy: string
  requestedName: string
  requestedAt: string
  status: string
  decidedBy: string
  decidedName: string
  decidedAt: string | null
  comment: string
}

const REQUEST_COLS = `id, action, target_id AS targetId, payload_json AS payloadJson, summary,
  requested_by AS requestedBy, requested_name AS requestedName, requested_at AS requestedAt,
  status, decided_by AS decidedBy, decided_name AS decidedName, decided_at AS decidedAt, comment`

export function createApprovalRequestRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT INTO approval_requests
       (id, action, target_id, payload_json, summary, requested_by, requested_name, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const decideStmt = db.prepare(
    `UPDATE approval_requests SET status = ?, decided_by = ?, decided_name = ?, decided_at = ?, comment = ?
     WHERE id = ? AND status = 'pending'`,
  )
  const getStmt = db.prepare(`SELECT ${REQUEST_COLS} FROM approval_requests WHERE id = ?`)
  const consumeStmt = db.prepare(
    `UPDATE approval_requests SET status = 'consumed' WHERE id = ? AND status = 'approved'`,
  )
  const pendingStmt = db.prepare(
    `SELECT ${REQUEST_COLS} FROM approval_requests WHERE status = 'pending' ORDER BY requested_at DESC`,
  )
  const listStmt = db.prepare(
    `SELECT ${REQUEST_COLS} FROM approval_requests ORDER BY requested_at DESC LIMIT ?`,
  )

  return {
    request(a: { id: string, action: string, targetId: string, payload: unknown, summary: string, byUserId: string, byName: string, at: string }): void {
      insertStmt.run(a.id, a.action, a.targetId, JSON.stringify(a.payload ?? {}), a.summary, a.byUserId, a.byName, a.at)
    },
    decide(id: string, approved: boolean, byUserId: string, byName: string, comment: string, at: string): ApprovalRequestRow | null {
      const res = decideStmt.run(approved ? 'approved' : 'denied', byUserId, byName, at, comment, id)
      if (res.changes === 0) return null
      return getStmt.get(id) as unknown as ApprovalRequestRow
    },
    get(id: string): ApprovalRequestRow | null {
      return (getStmt.get(id) ?? null) as ApprovalRequestRow | null
    },
    /** 批准记录消费(执行侧放行时一次性核销;幂等:重复消费返回 false) */
    consume(id: string): boolean {
      return consumeStmt.run(id).changes > 0
    },
    listPending(): ApprovalRequestRow[] {
      return pendingStmt.all() as unknown as ApprovalRequestRow[]
    },
    list(limit = 200): ApprovalRequestRow[] {
      return listStmt.all(limit as SQLInputValue) as unknown as ApprovalRequestRow[]
    },
  }
}
