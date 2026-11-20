/**
 * 旧经验行 → 不可变版本回填(Task 2)。
 *
 * 表结构在 SCHEMA_SQL(v4)内创建;此处只做「幂等回填 + 迁移标记」,全部走
 * 预编译语句(无动态 SQL 拼接),单事务内完成;失败整体回滚并抛出,
 * 迁移失败时服务不得开放治理读写(fail-closed)。
 *
 * 回填规则:
 *  - 每个既有 kind='experience' 且尚无版本指针的行生成一个版本(stable id,重跑不重复);
 *  - 历史 status='retired' → lifecycle='retired';其余一律 'legacy-unverified'
 *    —— 无可解析且与原主张绑定的来源/环境/产品上下文时,即使历史是 validated
 *    也不继承部署许可;deployment 恒 'none'。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const LEGACY_ROWS_SQL = `
  SELECT m.id, m.content, m.evidence_json, m.scope_kind, m.scope_key, m.status, m.created_at, m.outcome
    FROM agent_memories m
   WHERE m.kind = 'experience'
     AND NOT EXISTS (SELECT 1 FROM experience_heads h WHERE h.experience_id = m.id)
`

const INSERT_VERSION_SQL = `
  INSERT INTO experience_versions
    (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
     evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json,
     idempotency_key, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, '[]', ?, ?)
`

const INSERT_HEAD_SQL = `
  INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(experience_id) DO NOTHING
`

const MARK_MIGRATION_SQL = `
  INSERT INTO aw_migration_ledger(version, name, fingerprint, applied_at)
  VALUES (9002, 'experience-version-store', 'experience-version-store:v1', ?)
  ON CONFLICT(version) DO NOTHING
`

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface LegacyRow {
  id: string
  content: string
  evidence_json: string
  scope_kind: string
  scope_key: string
  status: string
  created_at: string
  outcome: string
}

export function migrateExperienceVersionStore(db: DatabaseSync): void {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const legacy = db.prepare(LEGACY_ROWS_SQL).all() as unknown as LegacyRow[]
    const insertVersion = db.prepare(INSERT_VERSION_SQL)
    const insertHead = db.prepare(INSERT_HEAD_SQL)
    for (const row of legacy) {
      const lifecycle = row.status === 'retired' ? 'retired' : 'legacy-unverified'
      const versionId = `ev-legacy-${row.id}`
      const evidence = row.evidence_json || '[]'
      const claim = {
        productId: '',
        recipeRevision: '',
        variable: '',
        unit: '',
        direction: 'stable',
        condition: '',
        polarity: row.outcome === 'negative' ? 'refute' : 'support',
      }
      insertVersion.run(
        versionId, row.id, `co-legacy-${row.id}`, row.scope_kind || 'session', row.scope_key || '',
        JSON.stringify(claim), row.content, sha256(row.content), evidence, sha256(evidence),
        lifecycle, row.created_at, `legacy-backfill:${row.id}`, row.created_at,
      )
      insertHead.run(row.id, versionId, row.created_at)
    }
    db.prepare(MARK_MIGRATION_SQL).run(new Date().toISOString())
    db.prepare('COMMIT').run()
  }
  catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    }
    catch { /* 已回滚 */ }
    throw err
  }
}
