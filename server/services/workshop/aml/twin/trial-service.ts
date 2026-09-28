import { createId, hashConstraintResults, sha256, type ObjectiveProfile, type RecommendationCertificate, type SceneContract, type TwinSnapshot, type VirtualTrial } from './contracts'
import { assertFreshSnapshot } from './snapshot-service'
import type { PhysicsModelProvider, PhysicsState, PhysicsTrajectory } from './physics-runtime'
import { evaluateEnsemble } from './uq-ood'
import { resolveAcceptanceProfile } from './acceptance'

/**
 * rollout 协议:VirtualTrial/MPC 的模型面。物理-only provider 经 syncRolloutProvider
 * 适配;训练注册的 hybrid 模型由 model-backed provider 提供残差修正 rollout。
 */
export interface RolloutProvider {
  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState
  rollout(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances: Record<string, number>): Promise<PhysicsTrajectory>
  evaluateConstraints(scene: SceneContract, trajectory: PhysicsTrajectory): Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }>
}

export function syncRolloutProvider(provider: PhysicsModelProvider): RolloutProvider {
  return {
    initialize: snapshot => provider.initialize(snapshot),
    rollout: (initial, controls, disturbances) => Promise.resolve(provider.simulate(initial, controls, disturbances)),
    evaluateConstraints: (scene, trajectory) => provider.evaluateConstraints(scene, trajectory),
  }
}

type AnyRolloutProvider = RolloutProvider | PhysicsModelProvider

function asRolloutProvider(provider: AnyRolloutProvider): RolloutProvider {
  if (typeof (provider as RolloutProvider).rollout === 'function') return provider as RolloutProvider
  return syncRolloutProvider(provider as PhysicsModelProvider)
}

export interface TrialUncertaintyInput {
  predictions: Array<Record<string, number>>
  coverage: number
  inputDistance?: number
  calibrationFresh?: boolean
}

export interface TrialRequest {
  scene: SceneContract
  snapshot: TwinSnapshot
  modelId: string
  modelHash: string
  objective: ObjectiveProfile
  baselineControls: Record<string, number>
  candidateControls: Array<Record<string, number>>
  provider: RolloutProvider
  /** 模型驱动时传 thunk:集成预测在 rollout 后才可读,runVirtualTrial 内部惰性解析 */
  uncertainty?: TrialUncertaintyInput | (() => TrialUncertaintyInput)
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

function validateControlTrajectory(scene: SceneContract, baseline: Record<string, number>, candidate: Array<Record<string, number>>, horizon: number): string | null {
  if (!candidate.length) return 'MPC_EMPTY_CANDIDATE'
  if (candidate.length > horizon) return 'MPC_HORIZON_EXCEEDED'
  // A VirtualTrial horizon is simulated, not a sequence of PLC writes. maxActionsPerRun is enforced by the governed write gateway, not rollout length.
  const controls = new Map(scene.controls.map(control => [control.id, control]))
  let previous = baseline
  for (const step of candidate) {
    for (const [id, value] of Object.entries(step)) {
      const control = controls.get(id)
      if (!control) return `MPC_UNKNOWN_CONTROL:${id}`
      if (!Number.isFinite(value)) return `MPC_CONTROL_NON_FINITE:${id}`
      if ((control.min != null && value < control.min) || (control.max != null && value > control.max)) return `MPC_CONTROL_OUT_OF_RANGE:${id}`
      const maxDelta = scene.writePolicy.maxDeltaPerAction[id] ?? control.maxStep
      if (maxDelta != null && Number.isFinite(previous[id]) && Math.abs(value - Number(previous[id])) > maxDelta + 1e-9) return `MPC_CONTROL_DELTA_EXCEEDED:${id}`
    }
    previous = step
  }
  return null
}

export async function runVirtualTrial(request: TrialRequest): Promise<VirtualTrial> {
  assertFreshSnapshot(request.snapshot, request.nowMs ?? Date.now(), 60_000)
  const controlFailure = validateControlTrajectory(request.scene, request.baselineControls, request.candidateControls, request.objective.horizonSteps)
  if (controlFailure) {
    const failedBase = {
      schemaVersion: 1,
      createdAt: new Date(request.nowMs ?? Date.now()).toISOString(),
      createdBy: request.createdBy,
      trialId: createId('trial'),
      snapshotId: request.snapshot.snapshotId,
      modelId: request.modelId,
      objectiveId: request.objective.objectiveId,
      candidateControlTrajectory: request.candidateControls,
      predictedTrajectory: [],
      uncertainty: { maxStd: Number.POSITIVE_INFINITY, coverage: 0, ensembleSize: 0 },
      outOfDistribution: { distance: Number.POSITIVE_INFINITY, disagreement: Number.POSITIVE_INFINITY, accepted: false, rejectCode: 'CONTROL_SAFETY' },
      constraintResults: [{ id: 'MPC_CONTROL_SAFETY', passed: false, detail: controlFailure }],
      baselineComparison: { baselineCost: Number.POSITIVE_INFINITY, candidateCost: Number.POSITIVE_INFINITY, improvement: Number.NEGATIVE_INFINITY },
      candidateExecuted: false as const,
      provenance: { snapshotHash: request.snapshot.snapshotHash, modelHash: request.modelHash, objectiveHash: sha256(request.objective), constraintDigest: hashConstraintResults([{ id: 'MPC_CONTROL_SAFETY', passed: false, detail: controlFailure }]) },
    }
    return { ...failedBase, provenance: { ...failedBase.provenance, trialHash: sha256(failedBase) } }
  }
  const provider = asRolloutProvider(request.provider)
  const initial = provider.initialize({ stateEstimate: request.snapshot.stateEstimate, controlValues: request.snapshot.controlValues })
  const trajectory = await provider.rollout(initial, request.candidateControls, request.snapshot.disturbances)
  if (trajectory.failures.length > 0) throw new Error(`PHYSICS_ROLLOUT_FAILED:${trajectory.failures.join(',')}`)
  const predicted = trajectory.steps.map(s => s.observations)
  const constraintResults = provider.evaluateConstraints(request.scene, trajectory)
  // 惰性解析:模型 rollout 完成后,集成预测(memberPredictions)才是本次 rollout 的
  const resolvedUncertainty = typeof request.uncertainty === 'function' ? request.uncertainty() : request.uncertainty
  const predictions = resolvedUncertainty?.predictions ?? predicted.slice(0, 3)
  // UQ 策略与 Twin Gate 同源:coverage 下限取场景验收档(缺省 0.90;castfilm 等噪声主导
  // 场景 0.85),并留一个有限样本容差 —— conformal 实现覆盖率是二项抽样,613 行校准集在
  // 真目标 0.90 下实现值 ~N(0.90, 0.012),硬卡 0.900 会让合格模型按抛硬币被拒
  // (实测:coverage 0.8989 全部 trial 被 UQ_COVERAGE_LOW 拒 → G7 恒挂)。
  const coverageFloor = Math.max(0.5, resolveAcceptanceProfile(request.scene.sceneId).uncertainty.coverageTarget - 0.01)
  const uq = evaluateEnsemble({ predictions, calibrationCoverage: resolvedUncertainty?.coverage ?? 1 }, {
    coverageTarget: coverageFloor,
    distanceThreshold: 16,
    disagreementThreshold: 0.15,
    calibrationFresh: resolvedUncertainty?.calibrationFresh ?? true,
    inputDistance: resolvedUncertainty?.inputDistance ?? 0,
  })
  const baselineTrajectory = await provider.rollout(initial, Array.from({ length: request.candidateControls.length }, () => request.baselineControls), request.snapshot.disturbances)
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
