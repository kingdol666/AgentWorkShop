import type { DatabaseSync } from 'node:sqlite'
import { sha256, type RecommendationCertificate, type SceneContract, type TwinSnapshot, type VirtualTrial } from './contracts'

export function createTwinRepo(db: DatabaseSync) {
  const upsertSceneStmt = db.prepare(`INSERT INTO twin_scenes(scene_id,scene_version,schema_version,contract_json,contract_hash,line_id,product_id,recipe_id,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scene_id,scene_version) DO UPDATE SET contract_json=excluded.contract_json, contract_hash=excluded.contract_hash, updated_at=excluded.updated_at`)
  const insertSnapshotStmt = db.prepare(`INSERT OR IGNORE INTO twin_snapshots(id,scene_id,scene_version,line_id,product_id,recipe_id,phase,snapshot_hash,watermark_ms,freshness_json,payload_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertTrialStmt = db.prepare(`INSERT OR IGNORE INTO twin_trials(id,snapshot_id,twin_model_id,objective_id,candidate_executed,status,result_json,result_hash,created_by,created_at) VALUES(?,?,?,?,0,?,?,?,?,?)`)
  const insertRecStmt = db.prepare(`INSERT OR IGNORE INTO twin_recommendations(id,trial_id,certificate_hash,status,certificate_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`)
  // 绑定值直接来自调用方(scene_json/snapshot_json 都是外部输入):对象/undefined 会以
  // "Provided value cannot be bound to SQLite parameter N" 这种驱动级报错冒出来(实测踩过),
  // 这里统一收敛成字符串/有限数字,让参数形状问题不再污染错误面。
  const text = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : String(v))
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    upsertScene(scene: SceneContract, createdBy: string): void {
      const now = new Date().toISOString()
      upsertSceneStmt.run(text(scene.sceneId), text(scene.sceneVersion), num(scene.schemaVersion), JSON.stringify(scene), sha256(scene), text(scene.lineId), text(scene.productId), text(scene.recipeId), 'draft', text(createdBy), text(scene.createdAt) || now, now)
    },
    insertSnapshot(snapshot: TwinSnapshot): void {
      insertSnapshotStmt.run(text(snapshot.snapshotId), text(snapshot.sceneId), text(snapshot.sceneVersion), text(snapshot.lineId), text(snapshot.productId), text(snapshot.recipeId), text(snapshot.phase), text(snapshot.snapshotHash), num(snapshot.daqWatermark), JSON.stringify(snapshot.dataQuality ?? {}), JSON.stringify(snapshot), text(snapshot.createdBy), text(snapshot.createdAt))
    },
    insertTrial(trial: VirtualTrial, twinModelId?: string): void {
      insertTrialStmt.run(text(trial.trialId), text(trial.snapshotId), text(twinModelId ?? trial.modelId), text(trial.objectiveId), 'completed', JSON.stringify(trial), sha256(trial), text(trial.createdBy), text(trial.createdAt))
    },
    insertRecommendation(certificate: RecommendationCertificate, createdBy: string, expiresAt?: string): void {
      insertRecStmt.run(text(certificate.recommendationId), text(certificate.trialId), text(certificate.certificateHash), text(certificate.status).toLowerCase(), JSON.stringify(certificate), expiresAt ?? null, text(createdBy), text(certificate.createdAt))
    },
  }
}
