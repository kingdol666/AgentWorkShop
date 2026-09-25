/* eslint-disable @stylistic/max-statements-per-line */
/**
 * External scene example: a tiny first-order thermal process. It intentionally
 * uses only ctx.twin, so it is a template for other industrial scenes.
 */
function provider() {
  return {
    manifest: {
      apiVersion: 'twin-provider.v1',
      providerId: 'thermal-demo-v1',
      version: '1.0.0',
      sceneId: 'thermal-demo',
      sceneKinds: ['thermal-demo'],
      backend: 'typescript',
      stateVariables: ['temperature'],
      controlVariables: ['temperature_setpoint'],
      disturbanceVariables: ['ambient_temperature'],
      parameters: {
        tauSec: { value: 20, min: 2, max: 120, unit: 's' },
        gain: { value: 1, min: 0.5, max: 1.5, unit: 'ratio' },
      },
      parameterPriors: { tauSec: { min: 2, max: 120 }, gain: { min: 0.5, max: 1.5 } },
      capabilities: { onlineStep: true, rollout: true, calibration: true, mpc: true },
    },
    initialize(snapshot) {
      return { temperature: Number(snapshot.stateEstimate?.temperature ?? snapshot.controlValues?.temperature_setpoint ?? 25) }
    },
    step(input) {
      const state = Number(input.state.temperature ?? 25)
      const target = Number(input.controls.temperature_setpoint ?? state)
      const ambient = Number(input.disturbances?.ambient_temperature ?? 25)
      const dt = Math.max(0.1, Number(input.dtSec ?? 1))
      const tau = 20
      const next = state + (1 - Math.exp(-dt / tau)) * (target - state) + 0.001 * (ambient - state)
      return { state: { temperature: next }, observations: { temperature: next }, guards: { temperature: next } }
    },
    simulate(initial, controls, disturbances = {}) {
      let state = { ...initial }; const steps = []; const failures = []
      for (const control of controls) {
        const result = this.step({ state, controls: control, disturbances, dtSec: 1 })
        if (!Number.isFinite(result.observations.temperature)) failures.push('PHYSICS_NON_FINITE')
        state = result.state; steps.push(result)
      }
      return { steps, failures }
    },
    evaluateConstraints(scene, trajectory) {
      return (scene.constraints ?? []).map((constraint) => {
        const key = constraint.id === 'temperature' ? 'temperature' : constraint.id
        const violation = trajectory.steps.findIndex((step) => {
          const value = step.observations[key] ?? step.guards[key]
          return constraint.kind === 'hard_range' && value != null && ((constraint.min != null && value < constraint.min) || (constraint.max != null && value > constraint.max))
        })
        return violation >= 0
          ? { id: constraint.id, passed: false, detail: `${constraint.id} 越界`, firstViolationStep: violation }
          : { id: constraint.id, passed: true, detail: '全轨迹通过' }
      })
    },
    health() { return { status: 'healthy', detail: 'external thermal demo provider ready' } },
  }
}

function scenePack() {
  return {
    sceneKind: 'thermal-demo',
    sceneSchemaVersion: '1.0.0',
    compile() {
      return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        createdBy: 'twin-thermal-demo',
        sceneId: 'thermal-demo',
        sceneVersion: '1.0.0',
        lineId: 'line-thermal-demo',
        productId: 'product-thermal-demo',
        recipeId: 'recipe-thermal-demo',
        phases: ['warmup', 'steady'],
        controls: [{ id: 'temperature_setpoint', role: 'control', physicalMeaning: '温度设定', unit: 'degC', min: 20, max: 180, maxStep: 5 }],
        states: [{ id: 'temperature', role: 'state', physicalMeaning: '过程温度', unit: 'degC' }],
        disturbances: [{ id: 'ambient_temperature', role: 'disturbance', physicalMeaning: '环境温度', unit: 'degC' }],
        observations: [{ id: 'temperature', role: 'target', physicalMeaning: '过程温度', unit: 'degC', min: 20, max: 180 }],
        guards: [],
        constraints: [{ id: 'temperature', kind: 'hard_range', min: 20, max: 180 }],
        physicsProfileId: 'thermal-demo-v1',
        objectiveProfileIds: [],
        writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: { temperature_setpoint: 5 } },
      }
    },
  }
}

export default {
  name: 'twin-thermal-demo',
  version: '1.0.0',
  description: '外部场景示例:一阶热过程 Twin Provider + ScenePack',
  auth: 'none',
  setup(ctx) {
    ctx.twin.registerPhysicsProvider(provider())
    ctx.twin.registerScenePack(scenePack())
    ctx.logger.info('外部 thermal-demo Twin Provider 已注册')
  },
}
