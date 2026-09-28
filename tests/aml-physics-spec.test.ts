import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileDeclarativeProvider } from '../server/services/workshop/aml/twin/declarative-provider'
import { op, param, ref, validatePhysicsSpec, type PhysicsSpec } from '../server/services/workshop/aml/twin/physics-spec'

function spec(overrides: Partial<PhysicsSpec> = {}): PhysicsSpec {
  return {
    specVersion: 'physics-spec.v1', modelId: 'heat-model', sceneId: 'heat-scene',
    variables: [
      { id: 'x', role: 'state', unit: 'ratio', min: 0, max: 100, defaultValue: 10 },
      { id: 'u', role: 'control', unit: 'ratio', min: 0, max: 100 },
      { id: 'y', role: 'observation', unit: 'ratio', min: 0, max: 100 },
    ],
    parameters: [{ id: 'alpha', value: 0.5, min: 0, max: 1 }],
    states: [{ lhs: 'x_next', rhs: op('add', ref('x'), op('mul', param('alpha'), op('sub', ref('u'), ref('x')))) }],
    observations: [{ lhs: 'y', rhs: ref('x_next') }],
    constraints: [{ id: 'y', kind: 'hard_range', min: 0, max: 100 }],
    monotonicity: [], delays: [], sampling: { periodMs: 1000 },
    solver: { method: 'discrete_state_space', dtSec: 1, stabilityPolicy: 'reject_unstable' },
    provenance: { createdBy: 'test', evidence: ['unit-test'] },
    ...overrides,
  }
}

test('validates the safe AST and rejects unknown operators, variables, units and parameter bounds', () => {
  assert.equal(validatePhysicsSpec(spec()).valid, true)
  const bad = validatePhysicsSpec(spec({ states: [{ lhs: 'x_next', rhs: { op: 'eval' as never, args: [1] } }] }))
  assert.equal(bad.valid, false)
  assert.match(bad.errors.join('\n'), /不允许的算子/)
  const unknown = validatePhysicsSpec(spec({ observations: [{ lhs: 'y', rhs: ref('missing') }] }))
  assert.equal(unknown.valid, false)
  assert.match(unknown.errors.join('\n'), /未声明变量/)
  const outOfPrior = validatePhysicsSpec(spec({ parameters: [{ id: 'alpha', value: 2, min: 0, max: 1 }] }))
  assert.equal(outOfPrior.valid, false)
  assert.match(outOfPrior.errors.join('\n'), /先验边界/)
})

test('compiles a PhysicsModelProvider-compatible declarative provider', () => {
  const provider = compileDeclarativeProvider(spec())
  const initial = provider.initialize({ stateEstimate: { x: 10 }, controlValues: { u: 30 } })
  const step = provider.step({ state: initial, controls: { u: 30 }, dtSec: 1 })
  assert.equal(step.state.x, 20)
  assert.equal(step.observations.y, 20)
  const trajectory = provider.simulate(initial, [{ u: 30 }, { u: 30 }])
  assert.equal(trajectory.steps.length, 2)
  const constraints = provider.evaluateConstraints({ constraints: spec().constraints } as never, trajectory)
  assert.equal(constraints[0]?.passed, true)
  assert.equal(provider.manifest.backend, 'typescript')
})

test('supports the complete operator whitelist without dynamic evaluation', () => {
  const valid = validatePhysicsSpec(spec({
    variables: [
      { id: 'x', role: 'state', unit: 'ratio', min: 0.1, max: 10, defaultValue: 1 },
      { id: 'u', role: 'control', unit: 'ratio', min: 0.1, max: 10 },
      { id: 'y', role: 'observation', unit: 'ratio', min: 0, max: 10 },
    ],
    states: [{ lhs: 'x_next', rhs: op('clamp', op('max', op('min', op('pow', ref('x'), 1), ref('u')), op('exp', 0)), 0.1, 10) }],
    observations: [{ lhs: 'y', rhs: op('log', op('add', ref('x_next'), 1)) }],
  }))
  assert.equal(valid.valid, true)
})
