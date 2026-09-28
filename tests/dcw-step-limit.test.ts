import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DcwNode } from '../server/services/workshop/dcw/dcw-node'
import { assertStepLimit, limitsBreakdownOf } from '../server/services/workshop/dcw/param-limits'

function node(stepLimit?: number | null) {
  return new DcwNode({ id: `test-step-${Math.random().toString(16).slice(2)}`, templateRef: 'dcw-pressure-sp', driver: 'mock', min: 0, max: 100, unit: 'bar', decimals: 1, stepLimit })
}

test('DCW exploration uses finite node step limit and refuses oversize delta', () => {
  const n = node(2)
  n.value = 50
  const bd = limitsBreakdownOf(n)
  assert.equal(bd.stepLimit, 2)
  assert.equal(bd.stepLimitSource, 'node')
  assert.doesNotThrow(() => assertStepLimit(n, 52))
  assert.throws(() => assertStepLimit(n, 52.1), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'STEP_LIMIT_EXCEEDED')
    return true
  })
})

test('DCW exploration fails closed when step limit is explicitly cleared', () => {
  const n = node(null)
  n.value = 50
  const bd = limitsBreakdownOf(n)
  assert.equal(bd.stepLimit, null)
  assert.equal(bd.stepLimitSource, 'none')
  assert.throws(() => assertStepLimit(n, 50.1), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'EXPLORATION_SAFE_STEP_REQUIRED')
    return true
  })
})
