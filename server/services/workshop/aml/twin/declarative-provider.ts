import { sha256, type PhysicsModelManifest, type SceneContract } from './contracts'
import type { PhysicsInput, PhysicsModelProvider, PhysicsState, PhysicsStepResult, PhysicsTrajectory } from './physics-runtime'
import { evaluatePhysicsExpression, parsePhysicsSpec, type PhysicsEquationSpec, type PhysicsSpec } from './physics-spec'

export class DeclarativePhysicsProvider implements PhysicsModelProvider {
  readonly spec: PhysicsSpec
  readonly manifest: PhysicsModelManifest
  private readonly stateEquations: PhysicsEquationSpec[]
  private readonly observationEquations: PhysicsEquationSpec[]
  private readonly guardEquations: PhysicsEquationSpec[]
  private readonly parameters: Record<string, number>

  constructor(input: PhysicsSpec) {
    this.spec = parsePhysicsSpec(input)
    this.stateEquations = this.spec.states
    this.observationEquations = this.spec.observations
    this.guardEquations = this.spec.guards ?? []
    this.parameters = Object.fromEntries(this.spec.parameters.map(parameter => [parameter.id, parameter.value ?? parameter.defaultValue ?? 0]))
    this.manifest = {
      schemaVersion: 1,
      createdAt: this.spec.provenance.createdAt ?? new Date().toISOString(),
      createdBy: this.spec.provenance.createdBy,
      physicsModelId: this.spec.modelId,
      version: this.spec.version ?? '1.0.0',
      sceneId: this.spec.sceneId,
      backend: 'typescript',
      stateVariables: this.spec.variables.filter(variable => variable.role === 'state').map(variable => variable.id),
      controlVariables: this.spec.variables.filter(variable => variable.role === 'control').map(variable => variable.id),
      disturbanceVariables: this.spec.variables.filter(variable => variable.role === 'disturbance').map(variable => variable.id),
      parameters: Object.fromEntries(this.spec.parameters.map(parameter => [parameter.id, { value: parameter.value ?? parameter.defaultValue ?? 0, ...(parameter.min === undefined ? {} : { min: parameter.min }), ...(parameter.max === undefined ? {} : { max: parameter.max }), ...(parameter.unit ? { unit: parameter.unit } : {}) }])),
      parameterPriors: Object.fromEntries(this.spec.parameters.map(parameter => [parameter.id, { min: parameter.min ?? parameter.value ?? parameter.defaultValue ?? 0, max: parameter.max ?? parameter.value ?? parameter.defaultValue ?? 0 }])),
      sourceHash: sha256(this.spec),
    }
  }

  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState {
    const state: PhysicsState = {}
    for (const variable of this.spec.variables.filter(item => item.role === 'state')) state[variable.id] = snapshot.stateEstimate[variable.id] ?? snapshot.controlValues[variable.id] ?? variable.defaultValue ?? variable.min ?? 0
    return state
  }

  step(input: PhysicsInput): PhysicsStepResult {
    const dtSec = input.dtSec ?? this.spec.solver.dtSec
    const values = { ...input.state, ...input.controls, ...(input.disturbances ?? {}) }
    const context = { values, parameters: this.parameters, dtSec }
    const nextState: PhysicsState = { ...input.state }
    for (const equation of this.stateEquations) {
      const base = equation.lhs.endsWith('_next') ? equation.lhs.slice(0, -5) : equation.lhs
      const raw = this.safeEvaluate(equation, context)
      nextState[base] = this.spec.solver.method === 'ode' ? (input.state[base] ?? 0) + dtSec * raw : raw
    }
    const outputValues = { ...values, ...nextState, ...Object.fromEntries(Object.entries(nextState).map(([key, value]) => [`${key}_next`, value])) }
    const outputContext = { values: outputValues, parameters: this.parameters, dtSec }
    const observations: Record<string, number> = {}
    const guards: Record<string, number> = {}
    for (const equation of this.observationEquations) observations[equation.lhs] = this.safeEvaluate(equation, outputContext)
    for (const equation of this.guardEquations) guards[equation.lhs] = this.safeEvaluate(equation, outputContext)
    return { state: nextState, observations, guards }
  }

  simulate(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances: Record<string, number> = {}): PhysicsTrajectory {
    let state = { ...initial }
    const steps: PhysicsStepResult[] = []
    const failures: string[] = []
    for (const control of controls) {
      const result = this.step({ state, controls: control, disturbances, dtSec: this.spec.solver.dtSec })
      if ([...Object.values(result.state), ...Object.values(result.observations), ...Object.values(result.guards)].some(value => !Number.isFinite(value))) failures.push('PHYSICS_NON_FINITE')
      for (const variable of this.spec.variables) {
        const value = result.state[variable.id] ?? result.observations[variable.id] ?? result.guards[variable.id]
        if (value !== undefined && ((variable.min !== undefined && value < variable.min) || (variable.max !== undefined && value > variable.max))) failures.push(`PHYSICS_BOUND:${variable.id}`)
      }
      state = result.state
      steps.push(result)
    }
    return { steps, failures: [...new Set(failures)] }
  }

  evaluateConstraints(scene: SceneContract, trajectory: PhysicsTrajectory): Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }> {
    const constraints = scene.constraints.length > 0 ? scene.constraints : this.spec.constraints
    return constraints.map((constraint) => {
      let seen = false
      for (let index = 0; index < trajectory.steps.length; index++) {
        const step = trajectory.steps[index]
        if (!step) continue
        const value = step.observations[constraint.id] ?? step.guards[constraint.id] ?? step.state[constraint.id]
        if (value === undefined) continue
        seen = true
        if (constraint.kind === 'hard_range' && ((constraint.min !== undefined && value < constraint.min) || (constraint.max !== undefined && value > constraint.max))) return { id: constraint.id, passed: false, detail: `${constraint.id}=${value} 越界`, firstViolationStep: index }
      }
      if (!seen) return { id: constraint.id, passed: false, detail: `约束 ${constraint.id} 无法映射到轨迹，失败关闭` }
      return { id: constraint.id, passed: true, detail: '全轨迹通过' }
    })
  }

  private safeEvaluate(equation: PhysicsEquationSpec, context: { values: Record<string, number>, parameters: Record<string, number>, dtSec: number }): number {
    try {
      return evaluatePhysicsExpression(equation.rhs, context)
    }
    catch { return Number.NaN }
  }
}

export class GenericDeclarativeProvider extends DeclarativePhysicsProvider {}
export function compileDeclarativeProvider(spec: PhysicsSpec): PhysicsModelProvider {
  return new DeclarativePhysicsProvider(spec)
}
export const compilePhysicsSpec = compileDeclarativeProvider
export const createDeclarativePhysicsProvider = compileDeclarativeProvider
