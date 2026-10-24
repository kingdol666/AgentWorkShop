/**
 * 运行时守卫求值(本体是否真正在运行中发挥作用的核心证据)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { evaluateGuards, extractGuardSet } = await import('../server/services/workshop/ontology/guards')
const { parseDraftDoc } = await import('../server/services/workshop/ontology/contracts')
const { compileOntology } = await import('../server/services/workshop/ontology/compiler')
const { buildDoc } = await import('./ontology-fixture')

function guardsFromFixture() {
  const result = compileOntology(parseDraftDoc(buildDoc()), {
    ontologyId: 'ont-pva', version: 1, scope: { lineId: 'ln-pva-01' }, createdAt: '2026-10-24T00:00:00.000Z',
  })
  return result.artifacts.controlGuard.guards
}

test('温区未稳 + 提速 → 阻断(block_recommendation)', () => {
  const guards = guardsFromFixture()
  const result = evaluateGuards(guards, {
    values: { 'st.thermal_ready': false },
    deltas: { 'st.line_speed': 1.5 },
    scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' },
  })
  assert.equal(result.blocked, true)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0]!.reason, 'condition_met')
  assert.match(result.violations[0]!.message, /温区未稳定,禁止提速/)
})

test('温区未稳但降速/不动 → 放行(只禁正向增量)', () => {
  const guards = guardsFromFixture()
  const down = evaluateGuards(guards, { values: { 'st.thermal_ready': false }, deltas: { 'st.line_speed': -2 }, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' } })
  assert.equal(down.blocked, false)
  assert.equal(down.ok, true)
  const still = evaluateGuards(guards, { values: { 'st.thermal_ready': false }, deltas: {}, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' } })
  assert.equal(still.blocked, false)
})

test('温区已稳 + 提速 → 放行', () => {
  const guards = guardsFromFixture()
  const result = evaluateGuards(guards, { values: { 'st.thermal_ready': true }, deltas: { 'st.line_speed': 3 }, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' } })
  assert.equal(result.blocked, false)
  assert.equal(result.ok, true)
  assert.equal(result.evaluated, 1)
})

test('fail-closed:状态未知且打算提速 → 阻断(不得默认认为可以提速)', () => {
  const guards = guardsFromFixture()
  const result = evaluateGuards(guards, { values: {}, deltas: { 'st.line_speed': 1 }, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' } })
  assert.equal(result.blocked, true)
  assert.equal(result.violations[0]!.reason, 'state_unknown')
  // 状态未知但不动作 → 不阻断
  const idle = evaluateGuards(guards, { values: {}, deltas: {}, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' } })
  assert.equal(idle.blocked, false)
  assert.equal(idle.skipped, 1)
})

test('scope 不匹配(跨配方/跨线)→ 跳过该守卫', () => {
  const guards = guardsFromFixture()
  const otherRecipe = evaluateGuards(guards, { values: { 'st.thermal_ready': false }, deltas: { 'st.line_speed': 5 }, scope: { lineId: 'ln-pva-01', recipeId: 'rc-B' } })
  assert.equal(otherRecipe.blocked, false)
  assert.equal(otherRecipe.skipped, 1)
  const otherLine = evaluateGuards(guards, { values: { 'st.thermal_ready': false }, deltas: { 'st.line_speed': 5 }, scope: { lineId: 'ln-other' } })
  assert.equal(otherLine.blocked, false)
})

test('annotate 级守卫记录违规但不阻断', () => {
  const annotate = [{
    id: 'guard-x', ruleId: 'R-X',
    when: { variableKey: 'x', op: 'eq' as const, value: true },
    forbid: { kind: 'positive_increment' as const, variableKey: 'y' },
    scope: { lineId: '', recipeId: '', conditionId: '' },
    onViolate: 'annotate' as const,
    message: '提示:建议复核',
  }]
  const result = evaluateGuards(annotate, { values: { x: true }, deltas: { y: 1 } })
  assert.equal(result.blocked, false)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
})

test('extractGuardSet 从编译快照取守卫(缺省空集不抛错)', () => {
  const compiled = JSON.parse(JSON.stringify({
    artifacts: compileOntology(parseDraftDoc(buildDoc()), { ontologyId: 'o', version: 1 }).artifacts,
  })) as unknown
  assert.equal(extractGuardSet(compiled).length, 1)
  assert.deepEqual(extractGuardSet({}), [])
  assert.deepEqual(extractGuardSet(null), [])
  assert.deepEqual(extractGuardSet({ artifacts: { controlGuard: { guards: [{ bad: true }] } } }), [])
})

test('多条守卫:任一 block 级违规即 blocked,违规全部列出', () => {
  const guards = [
    ...guardsFromFixture(),
    {
      id: 'guard-z', ruleId: 'R-Z',
      when: { variableKey: 'cv.thickness', op: 'gt' as const, value: 52 },
      forbid: { kind: 'nonzero_increment' as const, variableKey: 'pv.melt_pressure' },
      scope: { lineId: '', recipeId: '', conditionId: '' },
      onViolate: 'block_recommendation' as const,
      message: '膜厚超窗,禁止继续调压',
    },
  ]
  const result = evaluateGuards(guards, {
    values: { 'st.thermal_ready': false, 'cv.thickness': 53 },
    deltas: { 'st.line_speed': 1, 'pv.melt_pressure': -0.5 },
  })
  assert.equal(result.blocked, true)
  assert.equal(result.violations.length, 2)
  assert.deepEqual(result.violations.map(v => v.ruleId).sort(), ['R-GUARD', 'R-Z'])
})
