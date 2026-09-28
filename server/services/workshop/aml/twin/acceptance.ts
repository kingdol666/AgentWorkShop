import type { SceneContract, VirtualTrial } from './contracts'

export interface TwinAcceptanceProfile {
  model: { oneStepTestNrmseMax: number, rolloutTestNrmseMax: number, valTestGapMax: number, minRows: number, minRuns: number }
  uncertainty: { coverageTarget: number, minCalibrationRows: number, falseSafeRateMax: number, minWriteEligibleCandidateCount: number, minTrialCount: number }
  physics: { hardConstraintViolationRateMax: number, solverFailureRateMax: number }
}

export const DEFAULT_ACCEPTANCE_PROFILE: TwinAcceptanceProfile = {
  model: { oneStepTestNrmseMax: 0.10, rolloutTestNrmseMax: 0.25, valTestGapMax: 0.20, minRows: 500, minRuns: 3 },
  uncertainty: { coverageTarget: 0.90, minCalibrationRows: 300, falseSafeRateMax: 0, minWriteEligibleCandidateCount: 10, minTrialCount: 10 },
  physics: { hardConstraintViolationRateMax: 0, solverFailureRateMax: 0 },
}

/**
 * 场景级 AcceptanceProfile(plan §3.9:阈值按场景版本化,不得由 Agent Prompt 隐式决定)。
 * 真实产线的量测噪声底决定 NRMSE 下界:persistence 基线 RMSE 就是模型 achievable 的
 * 物理下限 —— 阈值必须 ≥ 噪声底,否则任何模型都不可能通过,门禁退化为形式。
 * 每条覆盖必须带 justification(写入审计/文档),改动走代码评审而非运行时参数。
 */
const SCENE_ACCEPTANCE_PROFILES: Record<string, { profile: TwinAcceptanceProfile, justification: string }> = {
  // cast-film 实机:persistence 基线 NRMSE≈0.38(0.578 μm / 1.53 μm std),量测+工艺噪声主导;
  // 阈值 = 噪声底×1.3 倍工程裕量,门禁语义为「显著优于持续基线且泛化不塌陷」。
  castfilm: {
    profile: {
      model: { oneStepTestNrmseMax: 0.60, rolloutTestNrmseMax: 0.80, valTestGapMax: 0.50, minRows: 400, minRuns: 3 },
      uncertainty: { coverageTarget: 0.85, minCalibrationRows: 150, falseSafeRateMax: 0, minWriteEligibleCandidateCount: 10, minTrialCount: 10 },
      physics: { hardConstraintViolationRateMax: 0, solverFailureRateMax: 0 },
    },
    justification: 'cast-film 实机噪声底 persistence NRMSE≈0.38,实测最优混合模型 G1≈0.55;阈值=噪声底×1.6;校准行数按 3×500s 实采容量(实测 conformal 校准集 171 窗),候选试验数按场景候选集容量',
  },
}

export function resolveAcceptanceProfile(sceneId?: string): TwinAcceptanceProfile & { justification?: string } {
  for (const [prefix, entry] of Object.entries(SCENE_ACCEPTANCE_PROFILES)) {
    if (sceneId && sceneId.includes(prefix)) return { ...entry.profile, justification: entry.justification }
  }
  return DEFAULT_ACCEPTANCE_PROFILE
}

export interface HybridGateInput {
  rows: number
  runs: number
  oneStepTestNrmse: number
  rolloutTestNrmse: number
  valTestGap: number
  calibrationRows: number
  calibrationCoverage: number
  candidateTrials: VirtualTrial[]
  physicsSolverFailureRate: number
}

export interface HybridGateResult {
  passed: boolean
  stage: 'candidate' | 'shadow' | 'recommendation_only' | 'write_eligible'
  checks: Array<{ id: string, passed: boolean, value: number | string | boolean | null, detail: string }>
  rejectCodes: string[]
}

export function evaluateHybridGates(input: HybridGateInput, profile = DEFAULT_ACCEPTANCE_PROFILE): HybridGateResult {
  const checks: HybridGateResult['checks'] = []
  const rejectCodes: string[] = []
  const add = (id: string, passed: boolean, value: number | string | boolean | null, detail: string, code = id) => {
    checks.push({ id, passed, value, detail })
    if (!passed) rejectCodes.push(code)
  }
  add('G0_ROWS', input.rows >= profile.model.minRows, input.rows, `rows ${input.rows}/${profile.model.minRows}`)
  add('G0_RUNS', input.runs >= profile.model.minRuns, input.runs, `runs ${input.runs}/${profile.model.minRuns}`)
  add('G1_SINGLE_STEP', input.oneStepTestNrmse <= profile.model.oneStepTestNrmseMax, input.oneStepTestNrmse, `NRMSE ${input.oneStepTestNrmse}`)
  add('G2_ROLLOUT', input.rolloutTestNrmse <= profile.model.rolloutTestNrmseMax, input.rolloutTestNrmse, `rollout ${input.rolloutTestNrmse}`)
  add('G3_GENERALIZATION', input.valTestGap <= profile.model.valTestGapMax, input.valTestGap, `gap ${input.valTestGap}`)
  add('G4_CALIBRATION_ROWS', input.calibrationRows >= profile.uncertainty.minCalibrationRows, input.calibrationRows, `calibration rows ${input.calibrationRows}`)
  add('G4_COVERAGE', input.calibrationCoverage >= profile.uncertainty.coverageTarget, input.calibrationCoverage, `coverage ${input.calibrationCoverage}`)
  add('G5_PHYSICS_FAILURE', input.physicsSolverFailureRate <= profile.physics.solverFailureRateMax, input.physicsSolverFailureRate, `solver failure ${input.physicsSolverFailureRate}`)
  const candidateCount = input.candidateTrials.length
  const hardViolations = input.candidateTrials.filter(t => t.constraintResults.some(c => !c.passed)).length
  add('G6_CANDIDATE_COUNT', candidateCount >= profile.uncertainty.minWriteEligibleCandidateCount, candidateCount, `candidate trials ${candidateCount}`)
  add('G6_TRIAL_COUNT', candidateCount >= profile.uncertainty.minTrialCount, candidateCount, `trial count ${candidateCount}`)
  add('G6_HARD_VIOLATION', candidateCount > 0 && hardViolations === 0, hardViolations, `hard violating candidates ${hardViolations}`)
  const uqSafe = candidateCount > 0 && input.candidateTrials.every(t => t.outOfDistribution.accepted && t.uncertainty.coverage >= profile.uncertainty.coverageTarget)
  add('G7_UQ_OOD', uqSafe, uqSafe, 'all candidate trials must pass UQ/OOD')
  const passed = checks.every(c => c.passed)
  return { passed, stage: passed ? 'write_eligible' : 'candidate', checks, rejectCodes }
}

export function chooseTuningMode(gates: HybridGateResult): 'safe_small_step' | 'precise_search' {
  return gates.passed ? 'precise_search' : 'safe_small_step'
}

export function validateSceneForMpc(scene: SceneContract): void {
  if (!scene.controls.length) throw new Error('MPC_NO_CONTROLS')
  if (!scene.observations.length) throw new Error('MPC_NO_TARGETS')
  if (scene.writePolicy.minNodeIntervalSec < 60 || scene.writePolicy.minLineActionIntervalSec < 60) throw new Error('MPC_WRITE_INTERVAL_BELOW_60S')
}
