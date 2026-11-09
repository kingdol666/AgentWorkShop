/**
 * 判据 DSL 数值扩展（WP-C4）：metric.within / lt / gt 的 fail-closed 语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { evaluateMetricCriterion } = await import('../server/services/workshop/projects/criteria-metrics')

test('within：|actual-target| ≤ tol 通过；超差失败', () => {
  const ok = evaluateMetricCriterion('metric.within:temp=220±0.5', { temp: 220.4 })
  assert.equal(ok.matched, true)
  assert.equal(ok.pass, true)
  assert.match(ok.detail, /实际 temp=220\.4/)

  const bad = evaluateMetricCriterion('metric.within:temp=220±0.5', { temp: 221 })
  assert.equal(bad.pass, false)
})

test('lt / gt：严格比较；大小写与全角冒号兼容', () => {
  assert.equal(evaluateMetricCriterion('metric.lt:iae=12', { iae: 11.9 }).pass, true)
  assert.equal(evaluateMetricCriterion('metric.lt:iae=12', { iae: 12 }).pass, false, '严格小于')
  assert.equal(evaluateMetricCriterion('METRIC.GT:flow=40', { flow: 40.1 }).pass, true)
  assert.equal(evaluateMetricCriterion('metric.gt：flow=40', { flow: 40.1 }).pass, true, '全角冒号')
})

test('fail-closed：缺 key / 非有限数 / 负容差取绝对值', () => {
  const missing = evaluateMetricCriterion('metric.within:temp=220±0.5', {})
  assert.equal(missing.matched, true)
  assert.equal(missing.pass, false)
  assert.match(missing.detail, /缺独立指标 temp/)

  const nan = evaluateMetricCriterion('metric.lt:iae=12', { iae: Number.NaN })
  assert.equal(nan.pass, false)

  assert.equal(evaluateMetricCriterion('metric.within:temp=220±-0.5', { temp: 220.3 }).pass, true, '负容差按绝对值')
})

test('非 metric 语法 → matched=false（交后续判据类型）', () => {
  assert.equal(evaluateMetricCriterion('artifact.present', {}).matched, false)
  assert.equal(evaluateMetricCriterion('自然语言验收标准', {}).matched, false)
  assert.equal(evaluateMetricCriterion('metric.within:temp', {}).matched, false, '语法不完整不算识别')
})
