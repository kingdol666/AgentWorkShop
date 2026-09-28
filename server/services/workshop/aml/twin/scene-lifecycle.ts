import type { SceneContract } from './contracts'
import { sceneSemanticHash, type SceneDraft } from './scene-builder'

export type PersistedSceneStatus = 'draft' | 'frozen'

export interface SceneDraftMetadata {
  status?: PersistedSceneStatus
  contractHash?: string
  evidence?: Record<string, unknown>
  inferredRelations?: unknown[]
  approvedBy?: string
  approvedAt?: string
}

export type SceneWithDraftMetadata = SceneContract & { draftMeta?: SceneDraftMetadata }

export interface FrozenSceneResult {
  scene: SceneWithDraftMetadata
  contractHash: string
  status: 'frozen'
  approvedBy: string
  approvedAt: string
}

export function sceneStatus(scene: SceneWithDraftMetadata): PersistedSceneStatus {
  return scene.draftMeta?.status === 'frozen' ? 'frozen' : 'draft'
}

export function sceneContractHash(scene: SceneWithDraftMetadata): string {
  const { draftMeta: _draftMeta, ...contract } = scene
  return sceneSemanticHash(contract)
}

export function freezeSceneDraft(input: SceneWithDraftMetadata, approvedBy: string, approvedAt = new Date().toISOString()): FrozenSceneResult {
  if (!approvedBy.trim()) throw new Error('SCENE_APPROVER_REQUIRED')
  const contractHash = sceneContractHash(input)
  const scene: SceneWithDraftMetadata = {
    ...input,
    draftMeta: {
      ...(input.draftMeta ?? {}),
      status: 'frozen',
      contractHash,
      approvedBy,
      approvedAt,
    },
  }
  return { scene, contractHash, status: 'frozen', approvedBy, approvedAt }
}

export function assertFrozenScene(input: unknown): SceneContract {
  if (!input || typeof input !== 'object') throw new Error('SCENE_CONTRACT_REQUIRED')
  const scene = input as SceneWithDraftMetadata
  if (sceneStatus(scene) !== 'frozen') throw new Error('SCENE_CONTRACT_NOT_FROZEN')
  return scene
}

export function asSceneDraft(input: unknown): SceneDraft {
  if (!input || typeof input !== 'object') throw new Error('SCENE_CONTRACT_REQUIRED')
  return input as SceneDraft
}
