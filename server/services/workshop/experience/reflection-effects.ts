/**
 * 持久化反射与经验管理面(Task 7)。
 *
 * 反射失败不阻塞主线,但"崩溃即漏学"不可接受:终态/评审/干预判读先随来源事务
 * 登记到持久 outbox(幂等键去重),再由判读器补扫生成经验版本。失败有界重试,
 * 超限进死信(quarantined/failed),不静默丢弃。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createExperienceVersion, getVersion } from './versions'
import type { VersionDraft } from './types'

export interface ReflectionEvent {
  sourceKind: 'task-terminal' | 'review' | 'intervention'
  sourceId: string
  idempotencyKey: string
  draft: VersionDraft
}

export interface DrainOptions {
  maxAttempts?: number
  limit?: number
  now?: () => number
  /** 判读前的授权/环境校验(宿主提供);false 则隔离该条 */
  authorize?: (event: ReflectionEvent) => boolean
}

export interface ReflectionDrainReport {
  processed: number
  reflected: number
  failed: number
  quarantined: number
  versionIds: string[]
}

/** 随来源事务登记(与业务写同一事务时由调用方传入 db 并包裹事务) */
export function enqueueReflection(db: DatabaseSync, event: ReflectionEvent): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO experience_reflection_outbox
      (id, source_kind, source_id, idempotency_key, state, payload_json, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).run(`rfl-${randomUUID().slice(0, 12)}`, event.sourceKind, event.sourceId, event.idempotencyKey,
    JSON.stringify(event.draft), now, now)
}

/**
 * 补扫并生成经验版本。幂等:同幂等键重复 drain 只产生一个版本(版本层 replay 再兜底)。
 * 无授权/环境不可信 → quarantined;解析/契约错误超过重试上限 → failed。
 */
export function drainReflectionEffects(db: DatabaseSync, options: DrainOptions = {}): ReflectionDrainReport {
  const maxAttempts = options.maxAttempts ?? 3
  const limit = options.limit ?? 50
  const nowMs = options.now?.() ?? Date.now()
  const report: ReflectionDrainReport = { processed: 0, reflected: 0, failed: 0, quarantined: 0, versionIds: [] }
  const rows = db.prepare(
    `SELECT id, source_kind AS sourceKind, source_id AS sourceId, idempotency_key AS key, payload_json AS payload, attempts
       FROM experience_reflection_outbox
      WHERE state = 'pending' AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at LIMIT ?`,
  ).all(new Date(nowMs).toISOString(), limit) as unknown as Array<{
    id: string
    sourceKind: ReflectionEvent['sourceKind']
    sourceId: string
    key: string
    payload: string
    attempts: number
  }>

  for (const row of rows) {
    report.processed++
    const lease = new Date(nowMs + 60_000).toISOString()
    db.prepare('UPDATE experience_reflection_outbox SET lease_until = ?, updated_at = ? WHERE id = ?')
      .run(lease, new Date(nowMs).toISOString(), row.id)
    let draft: VersionDraft
    try {
      draft = JSON.parse(row.payload) as VersionDraft
    }
    catch {
      db.prepare(`UPDATE experience_reflection_outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
        .run('PAYLOAD_UNPARSEABLE', new Date(nowMs).toISOString(), row.id)
      report.failed++
      continue
    }
    const event: ReflectionEvent = { sourceKind: row.sourceKind, sourceId: row.sourceId, idempotencyKey: row.key, draft }
    if (options.authorize && !options.authorize(event)) {
      db.prepare(`UPDATE experience_reflection_outbox SET state = 'quarantined', last_error = ?, updated_at = ? WHERE id = ?`)
        .run('TRUSTED_CONTEXT_UNAVAILABLE', new Date(nowMs).toISOString(), row.id)
      report.quarantined++
      continue
    }
    try {
      const existing = db.prepare(
        `SELECT version_id AS versionId FROM experience_versions WHERE experience_id = ? AND idempotency_key = ? LIMIT 1`,
      ).get(draft.experienceId, draft.idempotencyKey) as { versionId?: string } | undefined
      let versionId = existing?.versionId
      if (!versionId) {
        const head = db.prepare('SELECT version_id AS versionId FROM experience_heads WHERE experience_id = ?')
          .get(draft.experienceId) as { versionId?: string } | undefined
        versionId = createExperienceVersion(db, draft, head?.versionId ?? null).versionId
      }
      if (!getVersion(db, versionId)) throw new Error('VERSION_MISSING_AFTER_WRITE')
      db.prepare(`UPDATE experience_reflection_outbox SET state = 'reflected', last_error = '', updated_at = ? WHERE id = ?`)
        .run(new Date(nowMs).toISOString(), row.id)
      report.reflected++
      if (!report.versionIds.includes(versionId)) report.versionIds.push(versionId)
    }
    catch (err) {
      const attempts = row.attempts + 1
      const state = attempts >= maxAttempts ? 'failed' : 'pending'
      db.prepare(`UPDATE experience_reflection_outbox SET state = ?, attempts = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .run(state, attempts, err instanceof Error ? err.message.slice(0, 200) : String(err), new Date(nowMs).toISOString(), row.id)
      report.failed++
    }
  }
  return report
}

export interface ExperiencePanelDetail {
  memoryId: string
  versionId: string | null
  lifecycle: string
  deployment: string
  claimOriginTime: string | null
  betaAncestors: string[]
  auditActions: string[]
}

/**
 * 运维面:从一次「使用」追到证据与版本(产品/设计对象维度)。
 * 未授权调用方不应拿到该 DTO(权限由 REST 层把关);这里只做只读投影。
 */
export function experiencePanelDetail(db: DatabaseSync, memoryId: string): ExperiencePanelDetail {
  const head = db.prepare(
    `SELECT v.version_id AS versionId, v.lifecycle, v.deployment, v.claim_origin_time AS origin, v.beta_ancestors_json AS beta
       FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
      WHERE h.experience_id = ?`,
  ).get(memoryId) as { versionId: string, lifecycle: string, deployment: string, origin: string, beta: string } | undefined
  if (!head) {
    return { memoryId, versionId: null, lifecycle: 'unversioned', deployment: 'none', claimOriginTime: null, betaAncestors: [], auditActions: [] }
  }
  const audit = db.prepare(
    'SELECT action FROM experience_version_audit WHERE version_id = ? ORDER BY created_at DESC LIMIT 20',
  ).all(head.versionId) as Array<{ action: string }>
  return {
    memoryId,
    versionId: head.versionId,
    lifecycle: head.lifecycle,
    deployment: head.deployment,
    claimOriginTime: head.origin,
    betaAncestors: JSON.parse(head.beta || '[]') as string[],
    auditActions: audit.map(a => a.action),
  }
}
