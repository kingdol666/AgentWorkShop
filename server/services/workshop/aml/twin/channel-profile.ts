import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../../utils/errors'
import { getAmlRuntime } from '../../aml/runtime'

export type AmlChannelProfileKind = 'legacy' | 'hybrid_twin' | 'aml_training' | 'aml_optimization'
export type OptimizationMode = 'exploration' | 'aml'

export interface HybridChannelProfile {
  channelId: string
  profile: AmlChannelProfileKind
  capability: Record<string, unknown>
  sceneId?: string
  sceneVersion?: string
  sceneContract?: Record<string, unknown>
  objective?: Record<string, unknown>
  controlPolicy: 'recommendation_only' | 'hitl_governed' | 'bounded_auto'
  providerId?: string
  providerVersion?: string
  providerHash?: string
  scenePackId?: string
  providerGeneration?: number
  /** 工艺优化 Channel 绑定的 AML 模型(谱系+门禁校验通过后写入;解绑/探索模式为空) */
  boundModelId?: string
  boundAt?: string
  /** 工艺优化 Channel 子模式:exploration(真实写入探索,无 MPC) | aml(绑定模型,trial/bayes) */
  optimizationMode?: OptimizationMode
}

function repo(db: DatabaseSync) {
  const upsert = db.prepare(`INSERT INTO aml_channel_profiles(channel_id,profile,capability_json,scene_id,scene_version,scene_contract_json,objective_json,control_policy,provider_id,provider_version,provider_hash,scene_pack_id,provider_generation,bound_model_id,bound_at,optimization_mode,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET profile=excluded.profile, capability_json=excluded.capability_json, scene_id=excluded.scene_id, scene_version=excluded.scene_version, scene_contract_json=excluded.scene_contract_json, objective_json=excluded.objective_json, control_policy=excluded.control_policy, provider_id=excluded.provider_id, provider_version=excluded.provider_version, provider_hash=excluded.provider_hash, scene_pack_id=excluded.scene_pack_id, provider_generation=excluded.provider_generation, bound_model_id=excluded.bound_model_id, bound_at=excluded.bound_at, optimization_mode=excluded.optimization_mode, updated_at=excluded.updated_at`)
  const get = db.prepare(`SELECT channel_id AS channelId, profile, capability_json AS capabilityJson, scene_id AS sceneId, scene_version AS sceneVersion, scene_contract_json AS sceneContractJson, objective_json AS objectiveJson, control_policy AS controlPolicy, provider_id AS providerId, provider_version AS providerVersion, provider_hash AS providerHash, scene_pack_id AS scenePackId, provider_generation AS providerGeneration, bound_model_id AS boundModelId, bound_at AS boundAt, optimization_mode AS optimizationMode FROM aml_channel_profiles WHERE channel_id=?`)
  return { upsert, get }
}

export function setHybridChannelProfile(input: Omit<HybridChannelProfile, 'channelId'> & { channelId: string, createdBy?: string }): HybridChannelProfile {
  const rt = getAmlRuntime()
  const now = new Date().toISOString()
  repo(rt.db).upsert.run(input.channelId, input.profile, JSON.stringify(input.capability ?? {}), input.sceneId ?? null, input.sceneVersion ?? null, JSON.stringify(input.sceneContract ?? {}), JSON.stringify(input.objective ?? {}), input.controlPolicy ?? 'recommendation_only', input.providerId ?? null, input.providerVersion ?? null, input.providerHash ?? null, input.scenePackId ?? null, input.providerGeneration ?? null, input.boundModelId ?? null, input.boundAt ?? null, input.optimizationMode ?? null, input.createdBy ?? 'system', now, now)
  return input
}

export function getChannelTwinProfile(channelId: string): HybridChannelProfile {
  try {
    const row = repo(getAmlRuntime().db).get.get(channelId) as Record<string, unknown> | undefined
    if (!row) return { channelId, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only' }
    const profile = (['legacy', 'hybrid_twin', 'aml_training', 'aml_optimization'] as const).includes(row.profile as never) ? row.profile as AmlChannelProfileKind : 'legacy'
    const mode = row.optimizationMode === 'aml' || row.optimizationMode === 'exploration' ? (row.optimizationMode as OptimizationMode) : undefined
    return { channelId, profile, capability: JSON.parse(String(row.capabilityJson ?? '{}')), sceneId: row.sceneId ? String(row.sceneId) : undefined, sceneVersion: row.sceneVersion ? String(row.sceneVersion) : undefined, sceneContract: JSON.parse(String(row.sceneContractJson ?? '{}')), objective: JSON.parse(String(row.objectiveJson ?? '{}')), controlPolicy: (['recommendation_only', 'hitl_governed', 'bounded_auto'] as const).includes(row.controlPolicy as never) ? row.controlPolicy as HybridChannelProfile['controlPolicy'] : 'recommendation_only', providerId: row.providerId ? String(row.providerId) : undefined, providerVersion: row.providerVersion ? String(row.providerVersion) : undefined, providerHash: row.providerHash ? String(row.providerHash) : undefined, scenePackId: row.scenePackId ? String(row.scenePackId) : undefined, providerGeneration: row.providerGeneration != null ? Number(row.providerGeneration) : undefined, boundModelId: row.boundModelId ? String(row.boundModelId) : undefined, boundAt: row.boundAt ? String(row.boundAt) : undefined, optimizationMode: mode }
  }
  catch {
    return { channelId, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only' }
  }
}

export function isHybridTwinChannel(channelId: string): boolean {
  return getChannelTwinProfile(channelId).profile === 'hybrid_twin'
}

export function isTrainingChannel(channelId: string): boolean {
  return getChannelTwinProfile(channelId).profile === 'aml_training'
}

export function isOptimizationChannel(channelId: string): boolean {
  return getChannelTwinProfile(channelId).profile === 'aml_optimization'
}

/**
 * 孪生验证/寻优工具是否对该 Channel 放行:
 * hybrid_twin(旧全功能) 恒可;aml_optimization 须显式 aml 模式且已绑定模型。
 * 探索模式/未绑定 → 返回拒绝原因(工具层转「探索阶段」提示)。
 */
export function modelBackedToolPolicyFor(channelId: string): { allowed: boolean, reason?: string } {
  const p = getChannelTwinProfile(channelId)
  if (p.profile === 'hybrid_twin') return { allowed: true }
  if (p.profile !== 'aml_optimization') return { allowed: false, reason: 'PROFILE_NOT_OPTIMIZATION' }
  if (p.optimizationMode !== 'aml' || !p.boundModelId) return { allowed: false, reason: 'EXPLORATION_MODE_NO_MODEL' }
  return { allowed: true }
}

/**
 * 绑定模型校验(fail-closed):谱系(产线/产品/配方)与 Channel 场景一致 + Twin Gate 全过。
 * 违反 → 409;返回模型行供调用方续用。
 */
export function assertModelBindableToChannel(channelId: string, modelId: string): { modelId: string, label: string, stage: string } {
  const p = getChannelTwinProfile(channelId)
  if (p.profile !== 'aml_optimization') throw new AppError(409, 'AML_BIND_NOT_OPTIMIZATION', '仅工艺优化 Channel(aml_optimization)可绑定 AML 模型。')
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(modelId)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${modelId} 不存在。`)
  if (model.stage !== 'production' && model.stage !== 'shadow') throw new AppError(409, 'AML_MODEL_STAGE', `模型 ${modelId} 处于 ${model.stage} 阶段,仅 production/shadow 可绑定(先在 AML 界面或训练 Channel 晋升)。`)
  const dataset = rt.repo.dataset.get(model.datasetId)
  if (!dataset) throw new AppError(409, 'AML_MODEL_DATASET_MISSING', `模型 ${modelId} 的数据集不存在,无法校验谱系。`)
  const mismatch: string[] = []
  if (p.sceneId && dataset.lineId && dataset.lineId !== sceneLineId(p)) mismatch.push(`产线 ${dataset.lineId} ≠ 场景产线`)
  const metrics = (() => {
    try {
      return JSON.parse(model.metricsJson || '{}') as Record<string, unknown>
    }
    catch {
      return {}
    }
  })()
  const twin = metrics.twinEligibility as Record<string, unknown> | undefined
  if (twin?.recommendationEligible !== true || twin?.uqPassed !== true || twin?.oodPassed !== true || twin?.physicsPassed !== true) {
    throw new AppError(409, 'AML_MODEL_GATE_REQUIRED', `模型 ${modelId} 未通过场景级 Twin Gate(须先经 twin_gate_evaluate 全过),拒绝绑定。`)
  }
  if (mismatch.length > 0) throw new AppError(409, 'AML_MODEL_SCENE_MISMATCH', `模型谱系与 Channel 场景不一致:${mismatch.join(';')}(禁止跨配方投用)。`)
  return { modelId: model.id, label: model.label || model.id, stage: model.stage }
}

function sceneLineId(p: HybridChannelProfile): string {
  const contract = p.sceneContract as { lineId?: string } | undefined
  return contract?.lineId ?? ''
}
