import { type PhysicsModelManifest, type SceneContract, sha256 } from './contracts'

export interface PhysicsState { [key: string]: number }
export interface PhysicsInput { state: PhysicsState, controls: Record<string, number>, disturbances?: Record<string, number>, dtSec?: number }
export interface PhysicsStepResult { state: PhysicsState, observations: Record<string, number>, guards: Record<string, number> }
export interface PhysicsTrajectory { steps: PhysicsStepResult[], failures: string[] }

export interface PhysicsModelProvider {
  readonly manifest: PhysicsModelManifest
  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState
  step(input: PhysicsInput): PhysicsStepResult
  simulate(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances?: Record<string, number>): PhysicsTrajectory
  evaluateConstraints(scene: SceneContract, trajectory: PhysicsTrajectory): Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }>
}

/**
 * 注塑第一版低阶灰箱模型：热状态/压力滞后/保压时间到质量指标。
 * 这是安全的离线/VirtualTrial 模型，不拥有任何 DAQ/DCW 网络能力。
 */
export class InjectionGreyboxProvider implements PhysicsModelProvider {
  readonly manifest: PhysicsModelManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy: 'aml-twin-runtime',
    physicsModelId: 'injection-greybox-v1',
    version: '1.0.0',
    sceneId: 'injection-hold-control',
    backend: 'typescript',
    stateVariables: ['melt_temperature', 'cavity_pressure', 'fill_fraction'],
    controlVariables: ['hold_pressure', 'hold_time', 'melt_temperature_setpoint'],
    disturbanceVariables: ['ambient_temperature', 'material_batch_factor'],
    parameters: {
      pressureGain: { value: 0.10, min: 0.02, max: 0.30, unit: 'g/bar' },
      pressureTauSec: { value: 5, min: 1, max: 30, unit: 's' },
      thermalTauSec: { value: 25, min: 5, max: 120, unit: 's' },
      weightBase: { value: 31.8, min: 20, max: 50, unit: 'g' },
      weightTempGain: { value: 0.015, min: -0.1, max: 0.1, unit: 'g/degC' },
    },
    parameterPriors: {
      pressureGain: { min: 0.02, max: 0.30 },
      pressureTauSec: { min: 1, max: 30 },
      thermalTauSec: { min: 5, max: 120 },
      weightBase: { min: 20, max: 50 },
      weightTempGain: { min: -0.1, max: 0.1 },
    },
  }

  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState {
    return {
      melt_temperature: snapshot.stateEstimate.melt_temperature ?? snapshot.controlValues.melt_temperature_setpoint ?? 247,
      cavity_pressure: snapshot.stateEstimate.cavity_pressure ?? snapshot.controlValues.hold_pressure ?? 65,
      fill_fraction: snapshot.stateEstimate.fill_fraction ?? 1,
    }
  }

  step(input: PhysicsInput): PhysicsStepResult {
    const dt = Math.max(0.1, input.dtSec ?? 1)
    const u = input.controls
    const d = input.disturbances ?? {}
    const p = this.manifest.parameters
    const cavityPressure = input.state.cavity_pressure ?? 60
    const meltTemperature = input.state.melt_temperature ?? 247
    const fillFraction = input.state.fill_fraction ?? 1
    const pressureTauSec = p.pressureTauSec?.value ?? 5
    const thermalTauSec = p.thermalTauSec?.value ?? 25
    const weightBase = p.weightBase?.value ?? 31.8
    const pressureGain = p.pressureGain?.value ?? 0.10
    const weightTempGain = p.weightTempGain?.value ?? 0.015
    const pressure = cavityPressure + (dt / pressureTauSec) * ((u.hold_pressure ?? cavityPressure) - cavityPressure)
    const temp = meltTemperature + (dt / thermalTauSec) * ((u.melt_temperature_setpoint ?? meltTemperature) - meltTemperature) + (d.ambient_temperature ?? 23) * 0.0005
    const fill = Math.min(1, Math.max(0, fillFraction + dt * 0.05))
    const batch = d.material_batch_factor ?? 1
    const weight = weightBase + pressureGain * (pressure - 60) + weightTempGain * (temp - 247) + (batch - 1) * 0.25
    const flash = Math.max(0, (pressure - 78) * 0.12)
    const sink = Math.max(0, (70 - pressure) * 0.035 + (temp - 250) * 0.02)
    return {
      state: { melt_temperature: temp, cavity_pressure: pressure, fill_fraction: fill },
      observations: { weight, flash_rate: flash, sink_rate: sink, melt_temperature: temp, cavity_pressure: pressure },
      guards: { pressure, temperature: temp, fill_fraction: fill },
    }
  }

  simulate(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances: Record<string, number> = {}): PhysicsTrajectory {
    let state = { ...initial }
    const steps: PhysicsStepResult[] = []
    const failures: string[] = []
    for (const control of controls) {
      const result = this.step({ state, controls: control, disturbances, dtSec: 1 })
      if (Object.values(result.observations).some(v => !Number.isFinite(v))) failures.push('PHYSICS_NON_FINITE')
      state = result.state
      steps.push(result)
    }
    return { steps, failures }
  }

  evaluateConstraints(scene: SceneContract, trajectory: PhysicsTrajectory): Array<{ id: string, passed: boolean, detail: string, firstViolationStep?: number }> {
    // 失败关闭(fail-closed):约束 id 必须能映射到轨迹观测量/守卫量。
    // 旧行为对映射不到的 id 直接跳过并返回「全轨迹通过」(value == null 分支),
    // 于是 scene_json 里写成 part_weight / 质量窗口 这类 id 时,硬约束门禁形同虚设
    // —— 实测被真实 Agent 团队两次抓出:预测 weight 30.3 g 明显低于窗口下界仍报通过。
    const known = [...new Set([
      ...Object.keys(trajectory.steps.at(-1)?.observations ?? {}),
      ...Object.keys(trajectory.steps.at(-1)?.guards ?? {}),
    ])]
    if (trajectory.steps.length === 0) {
      return scene.constraints.map(constraint => ({ id: constraint.id, passed: false, detail: '空轨迹:未执行任何校验' }))
    }
    return scene.constraints.map((constraint) => {
      let unmapped = true
      for (let i = 0; i < trajectory.steps.length; i++) {
        const obs = trajectory.steps[i]?.observations ?? {}
        const value = obs[constraint.id] ?? trajectory.steps[i]?.guards[constraint.id]
        if (value == null) continue
        unmapped = false
        if (constraint.kind === 'hard_range' && ((constraint.min != null && value < constraint.min) || (constraint.max != null && value > constraint.max))) {
          return { id: constraint.id, passed: false, detail: `${constraint.id}=${value} 越过 ${constraint.min ?? '-∞'}~${constraint.max ?? '∞'}`, firstViolationStep: i }
        }
      }
      if (unmapped) return { id: constraint.id, passed: false, detail: `约束 ${constraint.id} 无法映射到观测量/守卫量(可用:${known.join(', ') || '无'}),按失败关闭处理` }
      return { id: constraint.id, passed: true, detail: '全轨迹通过' }
    })
  }
}

export function defaultInjectionScene(createdBy = 'aml-twin-runtime'): SceneContract {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy,
    sceneId: 'injection-hold-control',
    sceneVersion: '1.0.0',
    lineId: 'line-injection-01',
    productId: 'product-injection-a',
    recipeId: 'recipe-injection-a',
    phases: ['startup', 'filling', 'holding', 'cooling', 'completed'],
    controls: [
      { id: 'hold_pressure', role: 'control', physicalMeaning: '保压压力设定', unit: 'bar', min: 50, max: 90, maxStep: 2 },
      { id: 'hold_time', role: 'control', physicalMeaning: '保压时间设定', unit: 's', min: 4, max: 14, maxStep: 0.5 },
      { id: 'melt_temperature_setpoint', role: 'control', physicalMeaning: '熔体温度设定', unit: 'degC', min: 235, max: 260, maxStep: 2 },
    ],
    states: [
      { id: 'melt_temperature', role: 'state', physicalMeaning: '熔体温度状态', unit: 'degC' },
      { id: 'cavity_pressure', role: 'state', physicalMeaning: '模腔压力状态', unit: 'bar' },
    ],
    disturbances: [{ id: 'material_batch_factor', role: 'disturbance', physicalMeaning: '材料批次因子', unit: 'ratio' }],
    observations: [
      { id: 'weight', role: 'target', physicalMeaning: '制品重量', unit: 'g', min: 31, max: 34 },
      { id: 'flash_rate', role: 'guard', physicalMeaning: '飞边率', unit: '%' },
      { id: 'sink_rate', role: 'guard', physicalMeaning: '缩痕率', unit: '%' },
    ],
    guards: [],
    constraints: [
      { id: 'weight', kind: 'hard_range', min: 31, max: 34 },
      { id: 'flash_rate', kind: 'hard_range', min: 0, max: 1.0 },
      { id: 'sink_rate', kind: 'hard_range', min: 0, max: 1.0 },
      { id: 'pressure', kind: 'hard_range', min: 50, max: 90 },
      { id: 'temperature', kind: 'hard_range', min: 235, max: 260 },
    ],
    physicsProfileId: 'injection-greybox-v1',
    objectiveProfileIds: ['weight-quality'],
    writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: { hold_pressure: 2, hold_time: 0.5, melt_temperature_setpoint: 2 } },
  }
}

export function smallStepCandidates(scene: SceneContract, baseline: Record<string, number>): Array<Record<string, number>> {
  const out = [{ ...baseline }]
  for (const control of scene.controls) {
    const current = baseline[control.id]
    if (current == null || !Number.isFinite(current) || !control.maxStep) continue
    for (const sign of [-1, 1]) {
      const value = Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, current + sign * control.maxStep))
      out.push({ ...baseline, [control.id]: value })
    }
  }
  return out
}

export function providerFingerprint(provider: PhysicsModelProvider): string {
  return sha256(provider.manifest)
}
