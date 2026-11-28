/**
 * 本体证据词表收敛（批次 D，2026-11-26）。
 *
 * 历史回灌写的是 `observed/observed_weak/observed_unassessed`，而校验器只认
 * `candidate_influence|observed_correlation|validated_control`；rank=-1 会让规则
 * 永远过不了 `reviewed→validated`。这里一次性映射到合法枚举（幂等）。
 */
import type { DatabaseSync } from 'node:sqlite'

export function migrateOntologyEvidenceVocabulary(db: DatabaseSync): void {
  db.prepare(`UPDATE ontology_evidence SET level = 'observed_correlation' WHERE level IN ('observed', 'observed_strong')`).run()
  db.prepare(`UPDATE ontology_evidence SET level = 'candidate_influence' WHERE level IN ('observed_weak', 'observed_unassessed')`).run()
}
