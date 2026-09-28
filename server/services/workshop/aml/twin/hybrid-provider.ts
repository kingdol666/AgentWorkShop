import { sha256, type SceneContract, type PhysicsModelManifest } from './contracts'
import type { PhysicsInput, PhysicsModelProvider, PhysicsState, PhysicsStepResult, PhysicsTrajectory } from './physics-runtime'

export type ResidualPrediction = Record<string, number>
export type ResidualPredictor = (input: { physics: PhysicsStepResult, state: PhysicsState, controls: Record<string, number>, disturbances: Record<string, number>, dtSec: number }) => ResidualPrediction

export interface HybridProviderOptions {
  residualModelId?: string
  residualModelVersion?: string
  residualScale?: number
  /** 默认只修正观测，不让未经验证的数据残差改变物理状态。 */
  applyToState?: boolean
}

export function boundResidual(value: number, scale: number): number {
  if (!Number.isFinite(value)) return 0
  const limit = Math.max(0, Number.isFinite(scale) ? scale : 0)
  return Math.min(limit, Math.max(-limit, value))
}

/**
 * 物理主干 + 有界残差 Provider。
 *
 * 物理 Provider 始终先执行；残差模型只能在边界内修正观测（可选地修正状态），
 * 且不拥有 DAQ/DCW 权限。VirtualTrial/MPC 只接收此 Provider 的 rollout。
 */
export class HybridPhysicsProvider implements PhysicsModelProvider {
  readonly manifest: PhysicsModelManifest
  private readonly base: PhysicsModelProvider
  private readonly predictor: ResidualPredictor
  private readonly residualScale: number
  private readonly applyToState: boolean

  constructor(base: PhysicsModelProvider, predictor: ResidualPredictor, options: HybridProviderOptions = {}) {
    this.base = base
    this.predictor = predictor
    this.residualScale = Math.max(0, options.residualScale ?? 0.25)
    this.applyToState = options.applyToState === true
    this.manifest = {
      ...base.manifest,
      physicsModelId: `hybrid-${base.manifest.physicsModelId}`,
      version: options.residualModelVersion ?? `${base.manifest.version}+residual`,
      backend: 'pytorch',
      sourceHash: sha256({ base: base.manifest, residualModelId: options.residualModelId ?? '', residualModelVersion: options.residualModelVersion ?? '', residualScale: this.residualScale, applyToState: this.applyToState }),
    }
  }

  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState {
    return this.base.initialize(snapshot)
  }

  step(input: PhysicsInput): PhysicsStepResult {
    const dtSec = input.dtSec ?? 1
    const disturbances = input.disturbances ?? {}
    const physics = this.base.step(input)
    const rawResidual = this.predictor({ physics, state: input.state, controls: input.controls, disturbances, dtSec })
    const residual = Object.fromEntries(Object.entries(rawResidual ?? {}).map(([key, value]) => [key, boundResidual(Number(value), this.residualScale)]))
    const observations = { ...physics.observations }
    for (const [key, delta] of Object.entries(residual)) observations[key] = (observations[key] ?? 0) + delta
    const state = this.applyToState
      ? Object.fromEntries(Object.entries(physics.state).map(([key, value]) => [key, Number(value) + (residual[key] ?? 0)]))
      : physics.state
    return { state, observations, guards: physics.guards }
  }

  simulate(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances: Record<string, number> = {}): PhysicsTrajectory {
    let state = { ...initial }
    const steps: PhysicsStepResult[] = []
    const failures: string[] = []
    for (const control of controls) {
      const result = this.step({ state, controls: control, disturbances, dtSec: 1 })
      if ([...Object.values(result.state), ...Object.values(result.observations), ...Object.values(result.guards)].some(value => !Number.isFinite(value))) failures.push('HYBRID_NON_FINITE')
      steps.push(result)
      state = result.state
    }
    return { steps, failures: [...new Set(failures)] }
  }

  evaluateConstraints(scene: SceneContract, trajectory: PhysicsTrajectory): Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }> {
    return this.base.evaluateConstraints(scene, trajectory)
  }
}

export function createHybridPhysicsProvider(base: PhysicsModelProvider, predictor: ResidualPredictor, options?: HybridProviderOptions): HybridPhysicsProvider {
  return new HybridPhysicsProvider(base, predictor, options)
}
