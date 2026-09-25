import type { DatabaseSync } from 'node:sqlite'
import { getAmlRuntime } from '../../aml/runtime'

export interface HybridChannelProfile {
  channelId: string
  profile: 'legacy' | 'hybrid_twin'
  capability: Record<string, unknown>
  sceneId?: string
  sceneVersion?: string
  sceneContract?: Record<string, unknown>
  objective?: Record<string, unknown>
  controlPolicy: 'recommendation_only' | 'hitl_governed' | 'bounded_auto'
}

function repo(db: DatabaseSync) {
  const upsert = db.prepare(`INSERT INTO aml_channel_profiles(channel_id,profile,capability_json,scene_id,scene_version,scene_contract_json,objective_json,control_policy,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET profile=excluded.profile, capability_json=excluded.capability_json, scene_id=excluded.scene_id, scene_version=excluded.scene_version, scene_contract_json=excluded.scene_contract_json, objective_json=excluded.objective_json, control_policy=excluded.control_policy, updated_at=excluded.updated_at`)
  const get = db.prepare(`SELECT channel_id AS channelId, profile, capability_json AS capabilityJson, scene_id AS sceneId, scene_version AS sceneVersion, scene_contract_json AS sceneContractJson, objective_json AS objectiveJson, control_policy AS controlPolicy FROM aml_channel_profiles WHERE channel_id=?`)
  return { upsert, get }
}

export function setHybridChannelProfile(input: Omit<HybridChannelProfile, 'channelId'> & { channelId: string, createdBy?: string }): HybridChannelProfile {
  const rt = getAmlRuntime()
  const now = new Date().toISOString()
  repo(rt.db).upsert.run(input.channelId, input.profile, JSON.stringify(input.capability ?? {}), input.sceneId ?? null, input.sceneVersion ?? null, JSON.stringify(input.sceneContract ?? {}), JSON.stringify(input.objective ?? {}), input.controlPolicy ?? 'recommendation_only', input.createdBy ?? 'system', now, now)
  return input
}

export function getChannelTwinProfile(channelId: string): HybridChannelProfile {
  try {
    const row = repo(getAmlRuntime().db).get.get(channelId) as Record<string, unknown> | undefined
    if (!row) return { channelId, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only' }
    return { channelId, profile: String(row.profile) === 'hybrid_twin' ? 'hybrid_twin' : 'legacy', capability: JSON.parse(String(row.capabilityJson ?? '{}')), sceneId: row.sceneId ? String(row.sceneId) : undefined, sceneVersion: row.sceneVersion ? String(row.sceneVersion) : undefined, sceneContract: JSON.parse(String(row.sceneContractJson ?? '{}')), objective: JSON.parse(String(row.objectiveJson ?? '{}')), controlPolicy: (['recommendation_only', 'hitl_governed', 'bounded_auto'] as const).includes(row.controlPolicy as never) ? row.controlPolicy as HybridChannelProfile['controlPolicy'] : 'recommendation_only' }
  }
  catch {
    return { channelId, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only' }
  }
}

export function isHybridTwinChannel(channelId: string): boolean {
  return getChannelTwinProfile(channelId).profile === 'hybrid_twin'
}
