/**
 * 人工晋升、部署与撤销(Task 6)。
 *
 * 唯一提交门:请求必须是「具名审阅人 + 冻结评测 + 当前授权版本」,
 * 先写待发布与审计 outbox,确认送达后复查全部条件再做 CAS 发布。
 * 验证状态(lifecycle)不能代替部署状态(deployment);撤销先停注入。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EXPERIENCE_POLICY_VERSION } from './resolve'
import { getVersion, setVersionState } from './versions'
import { readLearningAuthorizationEpoch } from './trusted-context'

export interface ReleaseRequest {
  versionId: string
  evidenceSnapshotHash: string
  policyVersion: string
  evaluationRunId: string
  expectedEpoch: number
  reviewDecisionId: string
  requestedBy: string
  reviewedBy: string
}

export interface HostActor {
  actor: string
}

export type ReleaseResult
  = | { ok: true, state: 'pending' | 'deployed' | 'withdrawn', requestId?: string, reason: string }
    | { ok: false, state: 'rejected', reasons: string[] }

const tx = <T>(db: DatabaseSync, fn: () => T): T => {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const out = fn()
    db.prepare('COMMIT').run()
    return out
  }
  catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    }
    catch { /* 已回滚 */ }
    throw err
  }
}

function validateRequest(db: DatabaseSync, input: ReleaseRequest): string[] {
  const reasons: string[] = []
  const version = getVersion(db, input.versionId)
  if (!version) return [`UNKNOWN_VERSION: ${input.versionId}`]
  if (version.evidenceSnapshotHash !== input.evidenceSnapshotHash) reasons.push('EVIDENCE_SNAPSHOT_MISMATCH')
  if (version.lifecycle !== 'validated') reasons.push(`LIFECYCLE_NOT_VALIDATED: ${version.lifecycle}`)
  if (version.betaAncestors.length > 0) reasons.push('BETA_ANCESTOR_PRESENT')
  if (input.policyVersion !== EXPERIENCE_POLICY_VERSION) reasons.push('POLICY_VERSION_MISMATCH')
  if (input.expectedEpoch !== readLearningAuthorizationEpoch(db)) reasons.push('EPOCH_STALE')
  if (!input.reviewDecisionId.trim()) reasons.push('REVIEW_REQUIRED')
  // maker-checker:请求人与审阅人不得为同一主体
  if (!input.reviewedBy.trim() || input.reviewedBy === input.requestedBy) reasons.push('SELF_APPROVAL_FORBIDDEN')
  // 评测必须存在且为宿主来源
  const run = db.prepare('SELECT kind FROM harness_bench_runs WHERE id = ?').get(input.evaluationRunId) as { kind?: string } | undefined
  if (!run) reasons.push('EVALUATION_RUN_MISSING')
  else if (run.kind !== 'host-evaluation') reasons.push('CLIENT_BENCH_NOT_RELEASABLE')
  return reasons
}

/** 提交发布请求:先落待发布与审计 outbox(同一事务),此时部署状态不变 */
export function commitExperienceRelease(db: DatabaseSync, input: ReleaseRequest, actor: HostActor): ReleaseResult {
  const reasons = validateRequest(db, input)
  if (reasons.length > 0) return { ok: false, state: 'rejected', reasons }
  if (!actor.actor.trim()) return { ok: false, state: 'rejected', reasons: ['ACTOR_REQUIRED'] }
  return tx(db, () => {
    const requestId = `rel-${randomUUID().slice(0, 12)}`
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO experience_release_requests
        (id, version_id, evidence_snapshot_hash, policy_version, evaluation_run_id, expected_epoch,
         review_decision_id, requested_by, reviewed_by, state, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)`,
    ).run(requestId, input.versionId, input.evidenceSnapshotHash, input.policyVersion, input.evaluationRunId,
      input.expectedEpoch, input.reviewDecisionId, input.requestedBy, input.reviewedBy, now)
    db.prepare(
      `INSERT INTO experience_release_outbox(id, request_id, state, payload_json, attempts, created_at)
       VALUES (?, ?, 'pending', ?, 0, ?)`,
    ).run(`out-${randomUUID().slice(0, 12)}`, requestId, JSON.stringify({ versionId: input.versionId, actor: actor.actor }), now)
    return { ok: true, state: 'pending' as const, requestId, reason: 'AUDIT_PENDING: 审计未确认前不改变部署状态' }
  })
}

/**
 * 审计确认送达后复查并 CAS 发布。
 * 只有 outbox=acked 才进入发布;同一版本重复确认只允许一次状态推进。
 */
export function acknowledgeReleaseAudit(
  db: DatabaseSync,
  requestId: string,
  actor: HostActor,
): ReleaseResult {
  return tx(db, () => {
    const req = db.prepare(
      `SELECT id, version_id AS versionId, evidence_snapshot_hash AS hash, policy_version AS policy,
              evaluation_run_id AS runId, expected_epoch AS epoch, review_decision_id AS review,
              requested_by AS requestedBy, reviewed_by AS reviewedBy, state
         FROM experience_release_requests WHERE id = ?`,
    ).get(requestId) as {
      id: string
      versionId: string
      hash: string
      policy: string
      runId: string
      epoch: number
      review: string
      requestedBy: string
      reviewedBy: string
      state: string
    } | undefined
    if (!req) return { ok: false, state: 'rejected' as const, reasons: ['RELEASE_REQUEST_MISSING'] }
    db.prepare(`UPDATE experience_release_outbox SET state = 'acked', acked_at = ?, attempts = attempts + 1 WHERE request_id = ? AND state != 'acked'`)
      .run(new Date().toISOString(), requestId)
    const reasons = validateRequest(db, {
      versionId: req.versionId, evidenceSnapshotHash: req.hash, policyVersion: req.policy,
      evaluationRunId: req.runId, expectedEpoch: req.epoch, reviewDecisionId: req.review,
      requestedBy: req.requestedBy, reviewedBy: req.reviewedBy,
    })
    if (reasons.length > 0) {
      db.prepare(`UPDATE experience_release_requests SET state = 'rejected', reason = ?, decided_at = ? WHERE id = ?`)
        .run(reasons.join(';'), new Date().toISOString(), requestId)
      return { ok: false, state: 'rejected' as const, reasons }
    }
    const version = getVersion(db, req.versionId)!
    // 同一部署域只允许一版 active:撤下其他 active(撤销先停注入)
    const siblings = db.prepare(
      `SELECT version_id AS versionId FROM experience_versions
        WHERE scope_kind = ? AND scope_key = ? AND deployment = 'active' AND version_id != ?`,
    ).all(version.scope.kind, version.scope.key, version.versionId) as Array<{ versionId: string }>
    for (const s of siblings) setVersionState(db, s.versionId, { deployment: 'withdrawn' }, actor.actor)
    // CAS:已 active 的版本不再重复激活(并发确认只产生一次推进)
    const changed = db.prepare(
      `UPDATE experience_versions SET deployment = 'active' WHERE version_id = ? AND deployment != 'active'`,
    ).run(version.versionId).changes
    if (Number(changed) !== 1) {
      return { ok: false, state: 'rejected' as const, reasons: ['RELEASE_CAS_FAILED: 并发确认或已激活'] }
    }
    db.prepare(`INSERT INTO experience_version_audit(id, experience_id, version_id, action, actor, created_at)
      VALUES (?, ?, ?, 'release', ?, ?)`)
      .run(`eva-${version.versionId}-rel-${randomUUID().slice(0, 8)}`, version.experienceId, version.versionId, actor.actor, new Date().toISOString())
    db.prepare(`UPDATE experience_release_requests SET state = 'deployed', decided_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), requestId)
    return { ok: true, state: 'deployed' as const, requestId, reason: 'RELEASED' }
  })
}

/** 撤销:立即停注入(部署 withdrawn);生命周期保持不变(事实不被改写) */
export function withdrawExperienceRelease(db: DatabaseSync, versionId: string, actor: HostActor, reason: string): ReleaseResult {
  const version = getVersion(db, versionId)
  if (!version) return { ok: false, state: 'rejected', reasons: ['UNKNOWN_VERSION'] }
  setVersionState(db, versionId, { deployment: 'withdrawn' }, actor.actor)
  db.prepare(`INSERT INTO experience_version_audit(id, experience_id, version_id, action, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`eva-${versionId}-w-${randomUUID().slice(0, 8)}`, version.experienceId, versionId, `withdraw:${reason}`.slice(0, 120), actor.actor, new Date().toISOString())
  return { ok: true, state: 'withdrawn', reason: 'WITHDRAWN: 新回合不再注入该版本' }
}
