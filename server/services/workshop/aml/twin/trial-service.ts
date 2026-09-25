import { createId, hashConstraintResults, sha256, type ObjectiveProfile, type RecommendationCertificate, type SceneContract, type TwinSnapshot, type VirtualTrial } from './contracts'
import { assertFreshSnapshot } from './snapshot-service'
import type { PhysicsModelProvider } from './physics-runtime'
import { evaluateEnsemble } from './uq-ood'

export interface TrialRequest {
  scene: SceneContract
  snapshot: TwinSnapshot
  modelId: string
  modelHash: string
  objective: ObjectiveProfile
  baselineControls: Record<string, number>
  candidateControls: Array<Record<string, number>>
  provider: PhysicsModelProvider
  uncertainty?: { predictions: Array<Record<string, number>>, coverage: number, inputDistance?: number, calibrationFresh?: boolean }
  createdBy: string
  nowMs?: number
}

function objectiveCost(objective: ObjectiveProfile, trajectory: Array<Record<string, number>>): number {
  const last = trajectory.at(-1) ?? {}
  let cost = 0
  for (const [key, target] of Object.entries(objective.targets)) {
    const weight = objective.weights[key] ?? 1
    cost += weight * ((last[key] ?? 0) - target) ** 2
  }
  return cost
}

export function runVirtualTrial(request: TrialRequest): VirtualTrial {
  assertFreshSnapshot(request.snapshot, request.nowMs ?? Date.now(), 60_000)
  const initial = request.provider.initialize({ stateEstimate: request.snapshot.stateEstimate, controlValues: request.snapshot.controlValues })
  const trajectory = request.provider.simulate(initial, request.candidateControls, request.snapshot.disturbances)
  const predicted = trajectory.steps.map(s => s.observations)
  const constraintResults = request.provider.evaluateConstraints(request.scene, trajectory)
  const predictions = request.uncertainty?.predictions ?? predicted.slice(0, 3)
  const uq = evaluateEnsemble({ predictions, calibrationCoverage: request.uncertainty?.coverage ?? 1 }, {
    coverageTarget: 0.90,
    distanceThreshold: 16,
    disagreementThreshold: 0.15,
    calibrationFresh: request.uncertainty?.calibrationFresh ?? true,
    inputDistance: request.uncertainty?.inputDistance ?? 0,
  })
  const baselineTrajectory = request.provider.simulate(initial, Array.from({ length: request.candidateControls.length }, () => request.baselineControls), request.snapshot.disturbances)
  const baseline = objectiveCost(request.objective, baselineTrajectory.steps.map(s => s.observations))
  const candidate = objectiveCost(request.objective, predicted)
  const trialBase = {
    schemaVersion: 1,
    createdAt: new Date(request.nowMs ?? Date.now()).toISOString(),
    createdBy: request.createdBy,
    trialId: createId('trial'),
    snapshotId: request.snapshot.snapshotId,
    modelId: request.modelId,
    objectiveId: request.objective.objectiveId,
    candidateControlTrajectory: request.candidateControls,
    predictedTrajectory: predicted,
    uncertainty: { maxStd: uq.maxStd, coverage: uq.coverage, ensembleSize: uq.ensembleSize },
    outOfDistribution: { distance: uq.distance, disagreement: uq.disagreement, accepted: uq.accepted, rejectCode: uq.rejectCode },
    constraintResults,
    baselineComparison: { baselineCost: baseline, candidateCost: candidate, improvement: baseline - candidate },
    candidateExecuted: false as const,
    provenance: { snapshotHash: request.snapshot.snapshotHash, modelHash: request.modelHash, objectiveHash: sha256(request.objective), constraintDigest: hashConstraintResults(constraintResults) },
  }
  return { ...trialBase, provenance: { ...trialBase.provenance, trialHash: sha256(trialBase) } }
}

export function issueRecommendationCertificate(trial: VirtualTrial, createdBy: string, modelHash: string, objectiveHash: string, nowMs = Date.now()): RecommendationCertificate | null {
  if (trial.candidateExecuted) return null
  if (trial.constraintResults.some(c => !c.passed)) return null
  if (!trial.outOfDistribution.accepted) return null
  if (trial.baselineComparison.improvement <= 0) return null
  const base = {
    schemaVersion: 1,
    createdAt: new Date(nowMs).toISOString(),
    createdBy,
    recommendationId: createId('rec'),
    trialId: trial.trialId,
    snapshotHash: String(trial.provenance.snapshotHash ?? ''),
    modelHash,
    objectiveHash,
    candidateControlTrajectory: trial.candidateControlTrajectory,
    constraintDigest: String(trial.provenance.constraintDigest ?? ''),
    uncertainty: trial.uncertainty,
    outOfDistribution: trial.outOfDistribution,
    candidateExecuted: false as const,
    status: 'ISSUED' as const,
  }
  return { ...base, certificateHash: sha256(base) }
}
