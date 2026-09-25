import type { DatabaseSync } from 'node:sqlite'
import { sha256, type RecommendationCertificate, type SceneContract, type TwinSnapshot, type VirtualTrial } from './contracts'

export function createTwinRepo(db: DatabaseSync) {
  const upsertSceneStmt = db.prepare(`INSERT INTO twin_scenes(scene_id,scene_version,schema_version,contract_json,contract_hash,line_id,product_id,recipe_id,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scene_id,scene_version) DO UPDATE SET contract_json=excluded.contract_json, contract_hash=excluded.contract_hash, updated_at=excluded.updated_at`)
  const insertSnapshotStmt = db.prepare(`INSERT OR IGNORE INTO twin_snapshots(id,scene_id,scene_version,line_id,product_id,recipe_id,phase,snapshot_hash,watermark_ms,freshness_json,payload_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertTrialStmt = db.prepare(`INSERT OR IGNORE INTO twin_trials(id,snapshot_id,twin_model_id,objective_id,candidate_executed,status,result_json,result_hash,created_by,created_at) VALUES(?,?,?,?,0,?,?,?,?,?)`)
  const insertRecStmt = db.prepare(`INSERT OR IGNORE INTO twin_recommendations(id,trial_id,certificate_hash,status,certificate_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`)
  return {
    upsertScene(scene: SceneContract, createdBy: string): void {
      const now = new Date().toISOString()
      upsertSceneStmt.run(scene.sceneId, scene.sceneVersion, scene.schemaVersion, JSON.stringify(scene), sha256(scene), scene.lineId, scene.productId ?? '', scene.recipeId ?? '', 'draft', createdBy, scene.createdAt || now, now)
    },
    insertSnapshot(snapshot: TwinSnapshot): void {
      insertSnapshotStmt.run(snapshot.snapshotId, snapshot.sceneId, snapshot.sceneVersion, snapshot.lineId, snapshot.productId ?? '', snapshot.recipeId ?? '', snapshot.phase, snapshot.snapshotHash, snapshot.daqWatermark, JSON.stringify(snapshot.dataQuality), JSON.stringify(snapshot), snapshot.createdBy, snapshot.createdAt)
    },
    insertTrial(trial: VirtualTrial, twinModelId?: string): void {
      insertTrialStmt.run(trial.trialId, trial.snapshotId, twinModelId ?? trial.modelId, trial.objectiveId, 'completed', JSON.stringify(trial), sha256(trial), trial.createdBy, trial.createdAt)
    },
    insertRecommendation(certificate: RecommendationCertificate, createdBy: string, expiresAt?: string): void {
      insertRecStmt.run(certificate.recommendationId, certificate.trialId, certificate.certificateHash, certificate.status.toLowerCase(), JSON.stringify(certificate), expiresAt ?? null, createdBy, certificate.createdAt)
    },
  }
}
