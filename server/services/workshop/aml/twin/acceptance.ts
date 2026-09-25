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
