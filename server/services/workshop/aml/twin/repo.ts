import type { DatabaseSync } from 'node:sqlite'
import { sha256, type RecommendationCertificate, type TwinSnapshot, type VirtualTrial } from './contracts'
import { sceneContractHash, freezeSceneDraft, sceneStatus, type SceneWithDraftMetadata, type FrozenSceneResult } from './scene-lifecycle'

export interface TwinSceneRecord {
  sceneId: string
  sceneVersion: string
  schemaVersion: number
  contractJson: string
  contractHash: string
  lineId: string
  productId: string
  recipeId: string
  status: 'draft' | 'frozen' | string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export function createTwinRepo(db: DatabaseSync) {
  const upsertSceneStmt = db.prepare(`INSERT INTO twin_scenes(scene_id,scene_version,schema_version,contract_json,contract_hash,line_id,product_id,recipe_id,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scene_id,scene_version) DO UPDATE SET
      schema_version=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.schema_version ELSE excluded.schema_version END,
      contract_json=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.contract_json ELSE excluded.contract_json END,
      contract_hash=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.contract_hash ELSE excluded.contract_hash END,
      line_id=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.line_id ELSE excluded.line_id END,
      product_id=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.product_id ELSE excluded.product_id END,
      recipe_id=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.recipe_id ELSE excluded.recipe_id END,
      status=CASE WHEN twin_scenes.status='frozen' THEN 'frozen' ELSE excluded.status END,
      updated_at=CASE WHEN twin_scenes.status='frozen' THEN twin_scenes.updated_at ELSE excluded.updated_at END`)
  const getSceneStmt = db.prepare(`SELECT scene_id AS sceneId, scene_version AS sceneVersion, schema_version AS schemaVersion, contract_json AS contractJson, contract_hash AS contractHash, line_id AS lineId, product_id AS productId, recipe_id AS recipeId, status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM twin_scenes WHERE scene_id=? AND scene_version=?`)
  const getSnapshotStmt = db.prepare(`SELECT payload_json AS payloadJson FROM twin_snapshots WHERE id=?`)
  const freezeSceneStmt = db.prepare(`UPDATE twin_scenes SET contract_json=?, contract_hash=?, status='frozen', updated_at=? WHERE scene_id=? AND scene_version=? AND status='draft' AND contract_hash=?`)
  const insertSnapshotStmt = db.prepare(`INSERT OR IGNORE INTO twin_snapshots(id,scene_id,scene_version,line_id,product_id,recipe_id,phase,snapshot_hash,watermark_ms,freshness_json,payload_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertTrialStmt = db.prepare(`INSERT OR IGNORE INTO twin_trials(id,snapshot_id,twin_model_id,objective_id,candidate_executed,status,result_json,result_hash,created_by,created_at) VALUES(?,?,?,?,0,?,?,?,?,?)`)
  const insertRecStmt = db.prepare(`INSERT OR IGNORE INTO twin_recommendations(id,trial_id,certificate_hash,status,certificate_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`)
  // 绑定值直接来自调用方(scene_json/snapshot_json 都是外部输入):对象/undefined 会以
  // "Provided value cannot be bound to SQLite parameter N" 这种驱动级报错冒出来(实测踩过),
  // 这里统一收敛成字符串/有限数字,让参数形状问题不再污染错误面。
  const text = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : String(v))
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const readScene = (sceneId: string, sceneVersion: string): TwinSceneRecord | null => (getSceneStmt.get(text(sceneId), text(sceneVersion)) as TwinSceneRecord | undefined) ?? null
  return {
    getScene(sceneId: string, sceneVersion: string): TwinSceneRecord | null {
      return readScene(sceneId, sceneVersion)
    },
    getSnapshot(snapshotId: string): TwinSnapshot | null {
      const row = getSnapshotStmt.get(text(snapshotId)) as { payloadJson?: string } | undefined
      if (!row?.payloadJson) return null
      try {
        return JSON.parse(row.payloadJson) as TwinSnapshot
      }
      catch {
        return null
      }
    },
    upsertScene(scene: SceneWithDraftMetadata, createdBy: string): void {
      const now = new Date().toISOString()
      const status = sceneStatus(scene)
      upsertSceneStmt.run(text(scene.sceneId), text(scene.sceneVersion), num(scene.schemaVersion), JSON.stringify(scene), sceneContractHash(scene), text(scene.lineId), text(scene.productId), text(scene.recipeId), status, text(createdBy), text(scene.createdAt) || now, now)
    },
    freezeScene(sceneId: string, sceneVersion: string, approvedBy: string, expectedHash?: string): FrozenSceneResult {
      const row = readScene(sceneId, sceneVersion)
      if (!row) throw new Error('SCENE_NOT_FOUND')
      if (row.status === 'frozen') {
        const scene = JSON.parse(row.contractJson) as SceneWithDraftMetadata
        const existingApprovedBy = scene.draftMeta?.approvedBy ?? approvedBy
        const existingApprovedAt = scene.draftMeta?.approvedAt ?? row.updatedAt
        return { scene, contractHash: row.contractHash, status: 'frozen', approvedBy: existingApprovedBy, approvedAt: existingApprovedAt }
      }
      if (row.status !== 'draft') throw new Error(`SCENE_STATUS_NOT_FREEZABLE:${row.status}`)
      if (expectedHash && expectedHash !== row.contractHash) throw new Error('SCENE_HASH_MISMATCH')
      const draft = JSON.parse(row.contractJson) as SceneWithDraftMetadata
      const frozen = freezeSceneDraft(draft, approvedBy)
      const result = freezeSceneStmt.run(JSON.stringify(frozen.scene), sceneContractHash(frozen.scene), frozen.approvedAt, text(sceneId), text(sceneVersion), row.contractHash)
      if (Number(result.changes ?? 0) !== 1) throw new Error('SCENE_FREEZE_RACE')
      return frozen
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
