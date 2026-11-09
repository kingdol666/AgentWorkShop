/**
 * PR17 M4 调度内核仓储 —— Progress Ledger / Plan Versions / Effects(outbox) / Health。
 *
 * plan §2.3 S2/S3/S5/S6/S7/S11 + §3.1 DDL；不变量 11/12：
 *  - ledger 只追加，(project_id, seq) 唯一；
 *  - plan_versions 每 (project_id, version) 一行且不可变；同一时刻最多一个 approved；
 *  - effects (project_id, dedupe_key) 唯一，状态只能向前。
 * 时间戳沿用 project_* 表 TEXT ISO-8601 UTC 口径（字典序比较成立）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ProgressLedgerAppend {
  projectId: string
  planVersion: number
  stepNo: number
  triggerType: 'tick' | 'event' | 'owner' | 'watchdog'
  summary?: string
  facts?: Array<Record<string, unknown>>
  assessment?: Record<string, unknown>
  nextAction?: string
  evidence?: Array<Record<string, unknown>>
  decisionId?: string | null
  traceId?: string
}

export interface ProjectEffectEnqueueInput {
  projectId: string
  dedupeKey: string
  kind: 'notify' | 'mailbox' | 'reconcile' | 'task_callback'
  payload?: Record<string, unknown>
  traceId?: string
}

export interface ProjectEffectRow {
  id: string
  projectId: string
  dedupeKey: string
  kind: string
  payloadJson: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'dead'
  attempts: number
  nextRetryAt: string | null
  lastError: string
  traceId: string
  createdAt: string
  updatedAt: string
}

export interface ProjectHealthRow {
  projectId: string
  component: string
  status: 'ok' | 'degraded' | 'failed' | 'stale'
  lastError: string
  consecutiveFailures: number
  lastHeartbeatAt: string
  updatedAt: string
}

export interface PlanVersionRow {
  projectId: string
  version: number
  planJson: string
  sha256: string
  status: 'draft' | 'approved' | 'superseded' | 'rejected'
  approvedBy: string | null
  approvedAt: string | null
  supersedes: number | null
  createdAt: string
}

const LEDGER_COLS = `id, project_id AS projectId, seq, plan_version AS planVersion, step_no AS stepNo,
  trigger_type AS triggerType, summary, facts_json AS factsJson, assessment_json AS assessmentJson,
  next_action AS nextAction, evidence_json AS evidenceJson, decision_id AS decisionId, trace_id AS traceId, created_at AS createdAt`

const EFFECT_COLS = `id, project_id AS projectId, dedupe_key AS dedupeKey, kind, payload_json AS payloadJson,
  status, attempts, next_retry_at AS nextRetryAt, last_error AS lastError, trace_id AS traceId,
  created_at AS createdAt, updated_at AS updatedAt`

const HEALTH_COLS = `project_id AS projectId, component, status, last_error AS lastError,
  consecutive_failures AS consecutiveFailures, last_heartbeat_at AS lastHeartbeatAt, updated_at AS updatedAt`

const PLANV_COLS = `project_id AS projectId, version, plan_json AS planJson, sha256, status,
  approved_by AS approvedBy, approved_at AS approvedAt, supersedes, created_at AS createdAt`

const now = () => new Date().toISOString()

export function createProjectKernelRepo(db: DatabaseSync) {
  return {
    // ===== Progress Ledger（append-only；不变量 11）=====
    ledger: {
      append(input: ProgressLedgerAppend): number {
        const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM project_progress_ledger WHERE project_id = ?').get(input.projectId) as { s: number }).s + 1
        db.prepare(
          `INSERT INTO project_progress_ledger
             (id, project_id, seq, plan_version, step_no, trigger_type, summary, facts_json, assessment_json, next_action, evidence_json, decision_id, trace_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), input.projectId, seq, input.planVersion, input.stepNo,
          input.triggerType, input.summary ?? '',
          JSON.stringify(input.facts ?? []),
          JSON.stringify(input.assessment ?? {}),
          input.nextAction ?? '',
          JSON.stringify(input.evidence ?? []),
          input.decisionId ?? null,
          input.traceId ?? '',
          now(),
        )
        return seq
      },
      list(projectId: string, limit = 50) {
        return db.prepare(`SELECT ${LEDGER_COLS} FROM project_progress_ledger WHERE project_id = ? ORDER BY seq DESC LIMIT ?`)
          .all(projectId, Math.max(1, Math.min(200, limit))) as Array<{
          id: string
          projectId: string
          seq: number
          planVersion: number
          stepNo: number
          triggerType: string
          summary: string
          factsJson: string
          assessmentJson: string
          nextAction: string
          evidenceJson: string
          decisionId: string | null
          traceId: string
          createdAt: string
        }>
      },
      count(projectId: string): number {
        return (db.prepare('SELECT COUNT(*) AS n FROM project_progress_ledger WHERE project_id = ?').get(projectId) as { n: number }).n
      },
      lastAt(projectId: string): string | null {
        return (db.prepare('SELECT MAX(created_at) AS at FROM project_progress_ledger WHERE project_id = ?').get(projectId) as { at: string | null }).at
      },
    },

    // ===== Plan Versions（不可变 + 单 approved；不变量 12）=====
    planVersions: {
      /** 幂等写入 draft 版本行（同键已存在则不动 —— 不可变语义）。 */
      upsert(projectId: string, version: number, planJson: string, sha256: string, supersedes: number | null = null): void {
        db.prepare(
          `INSERT INTO project_plan_versions (project_id, version, plan_json, sha256, status, approved_by, approved_at, supersedes, created_at)
           VALUES (?, ?, ?, ?, 'draft', NULL, NULL, ?, ?)
           ON CONFLICT(project_id, version) DO NOTHING`,
        ).run(projectId, version, planJson, sha256, supersedes, now())
      },
      get(projectId: string, version: number) {
        return db.prepare(`SELECT ${PLANV_COLS} FROM project_plan_versions WHERE project_id = ? AND version = ?`).get(projectId, version) as PlanVersionRow | undefined
      },
      list(projectId: string, limit = 20) {
        return db.prepare(`SELECT ${PLANV_COLS} FROM project_plan_versions WHERE project_id = ? ORDER BY version DESC LIMIT ?`)
          .all(projectId, Math.max(1, Math.min(100, limit))) as unknown as PlanVersionRow[]
      },
      markApproved(projectId: string, version: number, approvedBy: string): boolean {
        return db.prepare(`UPDATE project_plan_versions SET status='approved', approved_by=?, approved_at=? WHERE project_id=? AND version=? AND status='draft'`)
          .run(approvedBy, now(), projectId, version).changes > 0
      },
      markRejected(projectId: string, version: number): boolean {
        return db.prepare(`UPDATE project_plan_versions SET status='rejected' WHERE project_id=? AND version=? AND status='draft'`)
          .run(projectId, version).changes > 0
      },
      /** 不变量 12：批准新版本时把旧 approved 收编为 superseded。 */
      supersedeOthers(projectId: string, keepVersion: number): void {
        db.prepare(`UPDATE project_plan_versions SET status='superseded' WHERE project_id=? AND status='approved' AND version != ?`)
          .run(projectId, keepVersion)
      },
      getApproved(projectId: string) {
        return db.prepare(`SELECT ${PLANV_COLS} FROM project_plan_versions WHERE project_id = ? AND status = 'approved'`).get(projectId) as PlanVersionRow | undefined
      },
    },

    // ===== Effects（outbox；状态只能向前）=====
    effects: {
      /** 幂等入队：同 (project, dedupeKey) 已存在则返回已有行。 */
      enqueue(input: ProjectEffectEnqueueInput): { id: string, inserted: boolean } {
        const existing = db.prepare('SELECT id FROM project_effects WHERE project_id = ? AND dedupe_key = ?')
          .get(input.projectId, input.dedupeKey) as { id: string } | undefined
        if (existing) return { id: existing.id, inserted: false }
        const id = randomUUID()
        const t = now()
        db.prepare(
          `INSERT INTO project_effects (id, project_id, dedupe_key, kind, payload_json, status, attempts, next_retry_at, last_error, trace_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, '', ?, ?, ?)`,
        ).run(id, input.projectId, input.dedupeKey, input.kind, JSON.stringify(input.payload ?? {}), input.traceId ?? '', t, t)
        return { id, inserted: true }
      },
      findById(id: string) {
        return db.prepare(`SELECT ${EFFECT_COLS} FROM project_effects WHERE id = ?`).get(id) as ProjectEffectRow | undefined
      },
      due(nowIso: string, limit = 20): ProjectEffectRow[] {
        return db.prepare(
          `SELECT ${EFFECT_COLS} FROM project_effects WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT ?`,
        ).all(nowIso, limit) as unknown as ProjectEffectRow[]
      },
      claim(id: string): boolean {
        return db.prepare(`UPDATE project_effects SET status='running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .run(now(), id).changes > 0
      },
      markDone(id: string): boolean {
        return db.prepare(`UPDATE project_effects SET status='done', last_error='', next_retry_at=NULL, updated_at=? WHERE id=? AND status='running'`)
          .run(now(), id).changes > 0
      },
      /** 失败退避：留在 pending 并设 next_retry_at。 */
      markRetry(id: string, error: string, nextRetryAt: string): boolean {
        return db.prepare(`UPDATE project_effects SET status='pending', last_error=?, next_retry_at=?, updated_at=? WHERE id=? AND status='running'`)
          .run(error, nextRetryAt, now(), id).changes > 0
      },
      markDead(id: string, error: string): boolean {
        return db.prepare(`UPDATE project_effects SET status='dead', last_error=?, next_retry_at=NULL, updated_at=? WHERE id=? AND status='running'`)
          .run(error, now(), id).changes > 0
      },
      /**
       * 崩溃恢复:把上次进程 claim 后未收口的 running 行退回 pending。
       *
       * claim → markDone/markRetry/markDead 之间进程退出,行会永久停在 running:
       * due() 只选 pending、mark* 只认 running,再没有任何路径会碰它 —— 该 effect
       * 永不重放(mailbox/task_callback 卡死;enqueue 又按 dedupe_key 返回同一行)。
       * attempts 保留:已达 3 次的下次失败直接 dead + 升级,不会无限重放。
       */
      resetRunningToPending(): number {
        return db.prepare(
          `UPDATE project_effects SET status='pending', next_retry_at=NULL, updated_at=? WHERE status='running'`,
        ).run(now()).changes as number
      },
      /** S3 合并语义：新事件并入 pending 的 mailbox effect payload（推理期到达的事件进下一批）。 */
      mergeIntoPendingMailbox(projectId: string, eventIds: string[]): boolean {
        const row = db.prepare(
          `SELECT id, payload_json AS payloadJson FROM project_effects WHERE project_id = ? AND kind = 'mailbox' AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
        ).get(projectId) as { id: string, payloadJson: string } | undefined
        if (!row) return false
        const payload = JSON.parse(row.payloadJson || '{}') as { events?: string[] }
        payload.events = [...new Set([...(payload.events ?? []), ...eventIds])]
        db.prepare('UPDATE project_effects SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), now(), row.id)
        return true
      },
      listByStatus(projectId: string, statuses: string[], limit = 100): ProjectEffectRow[] {
        const ph = statuses.map(() => '?').join(',')
        return db.prepare(`SELECT ${EFFECT_COLS} FROM project_effects WHERE project_id = ? AND status IN (${ph}) ORDER BY created_at ASC LIMIT ?`)
          .all(projectId, ...statuses, limit) as unknown as ProjectEffectRow[]
      },
      countByStatus(projectId: string): Record<string, number> {
        const rows = db.prepare('SELECT status, COUNT(*) AS n FROM project_effects WHERE project_id = ? GROUP BY status').all(projectId) as Array<{ status: string, n: number }>
        return Object.fromEntries(rows.map(r => [r.status, r.n]))
      },
    },

    // ===== Health（HealthBoard；S7）=====
    health: {
      /** 组件心跳 upsert：ok 归零连续失败计数，非 ok 累加。 */
      heartbeat(projectId: string, component: string, ok: boolean, error = ''): void {
        const t = now()
        db.prepare(
          `INSERT INTO project_health (project_id, component, status, last_error, consecutive_failures, last_heartbeat_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(project_id, component) DO UPDATE SET
             status = excluded.status,
             last_error = excluded.last_error,
             consecutive_failures = CASE WHEN excluded.status = 'ok' THEN 0 ELSE project_health.consecutive_failures + 1 END,
             last_heartbeat_at = excluded.last_heartbeat_at,
             updated_at = excluded.updated_at`,
        ).run(projectId, component, ok ? 'ok' : 'degraded', error, t, t)
      },
      get(projectId: string, component: string) {
        return db.prepare(`SELECT ${HEALTH_COLS} FROM project_health WHERE project_id = ? AND component = ?`).get(projectId, component) as ProjectHealthRow | undefined
      },
      list(projectId: string) {
        return db.prepare(`SELECT ${HEALTH_COLS} FROM project_health WHERE project_id = ? ORDER BY component ASC`).all(projectId) as unknown as ProjectHealthRow[]
      },
      /** Watchdog dead-man：启动时把上次运行遗留的非 ok 行标记 stale。 */
      markAllStale(projectId: string): void {
        db.prepare(`UPDATE project_health SET status='stale', updated_at=? WHERE project_id=? AND status != 'stale'`).run(now(), projectId)
      },
    },
  }
}

export type ProjectKernelRepo = ReturnType<typeof createProjectKernelRepo>
