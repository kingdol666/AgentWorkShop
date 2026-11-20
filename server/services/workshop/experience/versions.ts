/**
 * 不可变经验版本存储(Task 2)。
 *
 * 为什么需要独立存储:`agent_memories` 一行可被同键 upsert 原地改写(正文/scope/结论),
 * 已审标签会随旧证据留在新主张上。这里把「经验版本」与「当前指针」分开:
 *  - experience_versions:只插不改(内容哈希与证据快照哈希钉死);
 *  - experience_heads:每个 experienceId 的当前版本指针,CAS 推进;
 *  - 任何正文/证据/范围变化都创建新 candidate,旧版本哈希与引用永不变。
 *
 * 幂等:同 (experienceId, idempotencyKey, contentHash, evidenceSnapshotHash) 重放返回原版本;
 * 同幂等键但内容/证据变化 → 新版本(不是冲突);只有 expectedPreviousVersionId 与当前指针
 * 不一致才抛 EXPERIENCE_VERSION_CONFLICT。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  EXPERIENCE_VERSION_CONFLICT,
  ExperienceVersionConflictError,
  type EvidenceRef,
  type ExperienceVersion,
  type VersionDraft,
} from './types'

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface VersionRow {
  version_id: string
  experience_id: string
  claim_origin_id: string
  scope_kind: string
  scope_key: string
  claim_json: string
  content_hash: string
  evidence_snapshot_hash: string
  lifecycle: string
  deployment: string
  claim_origin_time: string
  beta_ancestors_json: string
  created_at: string
}

const toVersion = (row: VersionRow): ExperienceVersion => ({
  experienceId: row.experience_id,
  versionId: row.version_id,
  claimOriginId: row.claim_origin_id,
  scope: { kind: row.scope_kind as ExperienceVersion['scope']['kind'], key: row.scope_key },
  claim: JSON.parse(row.claim_json) as ExperienceVersion['claim'],
  contentHash: row.content_hash,
  evidenceSnapshotHash: row.evidence_snapshot_hash,
  lifecycle: row.lifecycle as ExperienceVersion['lifecycle'],
  deployment: row.deployment as ExperienceVersion['deployment'],
  claimOriginTime: row.claim_origin_time,
  betaAncestors: JSON.parse(row.beta_ancestors_json || '[]') as string[],
  createdAt: row.created_at,
})

const VERSION_COLS = `version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content_hash,
  evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, created_at`

/** 证据快照:按 id 排序的规范化 JSON(键序稳定),并剥离「复述注入」引用(它们不是新外部证据) */
const evidenceSnapshot = (evidence: readonly EvidenceRef[]): string => canonical(
  [...evidence]
    .map(e => ({ ...e, restatesVersionIds: [...(e.restatesVersionIds ?? [])].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id)),
)

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  }
  catch (err) {
    try {
      db.exec('ROLLBACK')
    }
    catch { /* 已回滚 */ }
    throw err
  }
}

export function headVersionId(db: DatabaseSync, experienceId: string): string | null {
  const row = db.prepare('SELECT version_id AS versionId FROM experience_heads WHERE experience_id = ?')
    .get(experienceId) as { versionId?: string } | undefined
  return row?.versionId ?? null
}

export function getVersion(db: DatabaseSync, versionId: string): ExperienceVersion | null {
  const row = db.prepare(`SELECT ${VERSION_COLS} FROM experience_versions WHERE version_id = ?`)
    .get(versionId) as VersionRow | undefined
  return row ? toVersion(row) : null
}

export function listVersions(db: DatabaseSync, experienceId: string): ExperienceVersion[] {
  const rows = db.prepare(`SELECT ${VERSION_COLS} FROM experience_versions WHERE experience_id = ? ORDER BY created_at ASC`)
    .all(experienceId) as unknown as VersionRow[]
  return rows.map(toVersion)
}

/**
 * 写入不可变版本并推进指针。
 * @param draft 版本草稿(结构化主张 + 证据快照 + 幂等键)
 * @param expectedPreviousVersionId 期望的上一版本 id;null 表示「此前必须无版本」
 */
export function createExperienceVersion(
  db: DatabaseSync,
  draft: VersionDraft,
  expectedPreviousVersionId: string | null,
): ExperienceVersion {
  if (!draft.experienceId.trim()) throw new Error('experienceId required')
  if (!draft.idempotencyKey.trim()) throw new Error('idempotencyKey required')
  const contentHash = sha256(draft.content)
  const evidenceSnapshotHash = sha256(evidenceSnapshot(draft.evidence))
  const betaAncestors = [...new Set([...(draft.betaAncestors ?? []), ...draft.evidence.flatMap(e => e.betaAncestors ?? [])])].sort()

  return tx(db, () => {
    const current = headVersionId(db, draft.experienceId)
    if (current !== expectedPreviousVersionId) {
      // 同幂等键+同哈希的重放即使指针已推进也返回原版本(重放不是冲突)
      const replay = db.prepare(
        `SELECT ${VERSION_COLS} FROM experience_versions
          WHERE experience_id = ? AND idempotency_key = ? AND content_hash = ? AND evidence_snapshot_hash = ?`,
      ).get(draft.experienceId, draft.idempotencyKey, contentHash, evidenceSnapshotHash) as VersionRow | undefined
      if (replay) return toVersion(replay)
      throw new ExperienceVersionConflictError(
        `${EXPERIENCE_VERSION_CONFLICT}: 期望上一版本 ${expectedPreviousVersionId ?? 'null'},实际 ${current ?? 'null'}`,
      )
    }
    const replay = db.prepare(
      `SELECT ${VERSION_COLS} FROM experience_versions
        WHERE experience_id = ? AND idempotency_key = ? AND content_hash = ? AND evidence_snapshot_hash = ?`,
    ).get(draft.experienceId, draft.idempotencyKey, contentHash, evidenceSnapshotHash) as VersionRow | undefined
    if (replay) return toVersion(replay)

    const now = new Date().toISOString()
    const versionId = `ev-${sha256(`${draft.experienceId}|${draft.idempotencyKey}|${contentHash}|${evidenceSnapshotHash}`).slice(0, 16)}`
    const claimOriginId = `co-${sha256(`${draft.experienceId}|${draft.claim.variable}|${draft.observedAt}`).slice(0, 16)}`
    db.prepare(
      `INSERT INTO experience_versions
        (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
         evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json,
         idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 'none', ?, ?, ?, ?)`,
    ).run(
      versionId, draft.experienceId, claimOriginId, draft.scope.kind, draft.scope.key,
      canonical(draft.claim), draft.content, contentHash, evidenceSnapshot(draft.evidence), evidenceSnapshotHash,
      draft.observedAt, JSON.stringify(betaAncestors), draft.idempotencyKey, now,
    )
    db.prepare(
      `INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(experience_id) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at`,
    ).run(draft.experienceId, versionId, now)
    db.prepare(
      `INSERT INTO experience_version_audit(id, experience_id, version_id, action, actor, created_at)
       VALUES (?, ?, ?, 'created', ?, ?)`,
    ).run(`eva-${versionId}`, draft.experienceId, versionId, 'host', now)
    return getVersion(db, versionId)!
  })
}

/** 生命周期/部署推进一律走审计写入(版本正文不改) */
export function setVersionState(
  db: DatabaseSync,
  versionId: string,
  patch: { lifecycle?: ExperienceVersion['lifecycle'], deployment?: ExperienceVersion['deployment'] },
  actor: string,
): ExperienceVersion {
  const current = getVersion(db, versionId)
  if (!current) throw new Error(`unknown version ${versionId}`)
  const lifecycle = patch.lifecycle ?? current.lifecycle
  const deployment = patch.deployment ?? current.deployment
  return tx(db, () => {
    db.prepare('UPDATE experience_versions SET lifecycle = ?, deployment = ? WHERE version_id = ?')
      .run(lifecycle, deployment, versionId)
    db.prepare(
      `INSERT INTO experience_version_audit(id, experience_id, version_id, action, actor, created_at)
       VALUES (?, ?, ?, 'state', ?, ?)`,
    ).run(`eva-${versionId}-st-${randomUUID().slice(0, 8)}`, current.experienceId, versionId, actor, new Date().toISOString())
    return getVersion(db, versionId)!
  })
}
