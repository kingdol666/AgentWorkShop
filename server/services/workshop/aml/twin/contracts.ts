import { createHash } from 'node:crypto'
import { z } from 'zod'

export type TwinRole = 'control' | 'state' | 'feature' | 'disturbance' | 'observation' | 'target' | 'guard'

export interface SceneVariable {
  id: string
  nodeId?: string
  role: TwinRole
  physicalMeaning: string
  unit: string
  min?: number
  max?: number
  maxStep?: number
  samplingPeriodMs?: number
  phaseScope?: string[]
}

export interface SceneContract {
  schemaVersion: number
  createdAt: string
  createdBy: string
  sceneId: string
  sceneVersion: string
  lineId: string
  productId?: string
  recipeId?: string
  phases: string[]
  controls: SceneVariable[]
  states: SceneVariable[]
  disturbances: SceneVariable[]
  observations: SceneVariable[]
  guards: SceneVariable[]
  constraints: Array<{ id: string, kind: 'hard_range' | 'max_delta' | 'rate' | 'custom', expression?: string, min?: number, max?: number }>
  physicsProfileId: string
  objectiveProfileIds: string[]
  writePolicy: {
    minNodeIntervalSec: number
    minLineActionIntervalSec: number
    maxActionsPerRun: number
    maxDeltaPerAction: Record<string, number>
  }
}

export interface NodeBindingSnapshot {
  schemaVersion: number
  createdAt: string
  createdBy: string
  snapshotId: string
  channelId: string
  bindingEpoch: string
  sceneId: string
  sceneVersion: string
  bindings: Array<{
    agentId: string
    agentRole: string
    nodeId: string
    kind: 'daq' | 'dcw'
    mode: 'auto' | 'manual'
    controlPolicy: 'recommendation_only' | 'hitl_governed' | 'bounded_auto'
    lineId: string
    physicalMeaning: string
    unit: string
    min?: number
    max?: number
    samplePeriodMs?: number
  }>
  snapshotHash: string
}

export interface PhysicsModelManifest {
  schemaVersion: number
  createdAt: string
  createdBy: string
  physicsModelId: string
  version: string
  sceneId: string
  backend: 'pytorch' | 'typescript'
  stateVariables: string[]
  controlVariables: string[]
  disturbanceVariables: string[]
  parameters: Record<string, { value: number, min?: number, max?: number, unit?: string }>
  parameterPriors: Record<string, { min: number, max: number }>
  sourceHash?: string
  artifactHash?: string
}

export interface TwinSnapshot {
  schemaVersion: number
  createdAt: string
  createdBy: string
  snapshotId: string
  sceneId: string
  sceneVersion: string
  lineId: string
  productId?: string
  recipeId?: string
  phase: string
  capturedAt: string
  daqWatermark: number
  sourceSequence?: string
  controlValues: Record<string, number>
  stateEstimate: Record<string, number>
  disturbances: Record<string, number>
  dataQuality: { fresh: boolean, completeness: number, staleNodeIds: string[], duplicateCount?: number }
  estimatorVersion: string
  bindingSnapshotHash?: string
  physicsModelVersion?: string
  residualModelVersion?: string
  snapshotHash: string
}

export interface ObjectiveProfile {
  schemaVersion: number
  createdAt: string
  createdBy: string
  objectiveId: string
  twinModelId?: string
  targets: Record<string, number>
  weights: Record<string, number>
  controlCosts: Record<string, number>
  horizonSteps: number
  trustRegion: Record<string, { min?: number, max?: number, maxDelta?: number }>
}

export interface VirtualTrial {
  schemaVersion: number
  createdAt: string
  createdBy: string
  trialId: string
  snapshotId: string
  modelId: string
  objectiveId: string
  candidateControlTrajectory: Array<Record<string, number>>
  predictedTrajectory: Array<Record<string, number>>
  uncertainty: { maxStd: number, coverage: number, ensembleSize: number }
  outOfDistribution: { distance: number, disagreement: number, accepted: boolean, rejectCode?: string }
  constraintResults: Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }>
  baselineComparison: { baselineCost: number, candidateCost: number, improvement: number }
  candidateExecuted: false
  provenance: Record<string, string>
}

export interface RecommendationCertificate {
  schemaVersion: number
  createdAt: string
  createdBy: string
  recommendationId: string
  trialId: string
  snapshotHash: string
  modelHash: string
  objectiveHash: string
  recipeHash?: string
  candidateControlTrajectory: Array<Record<string, number>>
  constraintDigest: string
  uncertainty: VirtualTrial['uncertainty']
  outOfDistribution: VirtualTrial['outOfDistribution']
  candidateExecuted: false
  status: 'ISSUED' | 'EXPIRED' | 'REVOKED'
  certificateHash: string
}

export const sceneContractSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().min(1),
  createdBy: z.string().min(1),
  sceneId: z.string().min(1),
  sceneVersion: z.string().min(1),
  lineId: z.string().min(1),
  productId: z.string().optional(),
  recipeId: z.string().optional(),
  phases: z.array(z.string().min(1)).min(1),
  controls: z.array(z.object({ id: z.string(), nodeId: z.string().optional(), role: z.literal('control'), physicalMeaning: z.string(), unit: z.string(), min: z.number().optional(), max: z.number().optional(), maxStep: z.number().positive().optional(), samplingPeriodMs: z.number().positive().optional(), phaseScope: z.array(z.string()).optional() })),
  states: z.array(z.any()),
  disturbances: z.array(z.any()),
  observations: z.array(z.any()),
  guards: z.array(z.any()),
  constraints: z.array(z.any()),
  physicsProfileId: z.string().min(1),
  objectiveProfileIds: z.array(z.string()),
  writePolicy: z.object({ minNodeIntervalSec: z.number().min(60), minLineActionIntervalSec: z.number().min(60), maxActionsPerRun: z.number().int().positive(), maxDeltaPerAction: z.record(z.number().positive()) }),
})

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value))
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function parseSceneContract(input: unknown): SceneContract {
  return sceneContractSchema.parse(input) as SceneContract
}

export function hashWithout(value: Record<string, unknown>, keys: string[]): string {
  const clone = Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
  return sha256(clone)
}

export function hashConstraintResults(results: unknown[]): string {
  return sha256(results)
}
