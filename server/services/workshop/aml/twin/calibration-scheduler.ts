import type { DatabaseSync } from 'node:sqlite'
import { createId } from './contracts'

export interface TwinCalibrationPolicy {
  policyVersion: string
  minNewRuns: number
  minNewRows: number
  cooldownSec: number
  maxConcurrentRuns: number
  shadowRequired: boolean
  approvalRequired: boolean
}

export interface TwinCalibrationSignal {
  sceneId: string
  lineId: string
  recipeId: string
  newRuns: number
  newRows: number
  driftScore?: number
  errorScore?: number
  reason: string
}

export function shouldTriggerCalibration(signal: TwinCalibrationSignal, policy: TwinCalibrationPolicy): boolean {
  return signal.newRuns >= policy.minNewRuns || signal.newRows >= policy.minNewRows || (signal.driftScore ?? 0) > 0.2 || (signal.errorScore ?? 0) > 0.15
}

export function requestCalibration(db: DatabaseSync, signal: TwinCalibrationSignal, policy: TwinCalibrationPolicy, createdBy: string): { accepted: boolean, reason: string, updateRunId?: string } {
  if (!shouldTriggerCalibration(signal, policy)) return { accepted: false, reason: 'TRIGGER_THRESHOLD_NOT_REACHED' }
  const dedupKey = `${signal.sceneId}:${signal.lineId}:${signal.recipeId}:${policy.policyVersion}`
  const active = db.prepare(`SELECT id,state,cooldown_until AS cooldownUntil FROM twin_update_runs WHERE dedup_key=? AND state IN ('queued','running','cooldown') ORDER BY created_at DESC LIMIT 1`).get(dedupKey) as { id?: string, state?: string, cooldownUntil?: string } | undefined
  if (active) return { accepted: false, reason: `ACTIVE_OR_COOLDOWN:${active.state}`, updateRunId: active.id }
  const id = createId('twin-update')
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO twin_update_runs(id,request_id,dedup_key,scene_id,line_id,recipe_id,state,cooldown_until,payload_json,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, dedupKey, signal.sceneId, signal.lineId, signal.recipeId, 'queued', new Date(Date.now() + policy.cooldownSec * 1000).toISOString(), JSON.stringify({ signal, policy, createdBy }), '', now)
  return { accepted: true, reason: 'QUEUED_FOR_AGENTTEAM_CALIBRATION', updateRunId: id }
}

export const DEFAULT_TWIN_CALIBRATION_POLICY: TwinCalibrationPolicy = {
  policyVersion: 'twin-calibration-v1',
  minNewRuns: 3,
  minNewRows: 500,
  cooldownSec: 3600,
  maxConcurrentRuns: 1,
  shadowRequired: true,
  approvalRequired: true,
}
