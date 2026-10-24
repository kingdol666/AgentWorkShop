/**
 * 量纲归一(共享叶子)单测:℃(U+2103) 缺口是 2026-10-24 计划点名的必修项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeUnit, dimensionOf, dimensionsCompatible, unitRelation, assertUnitTransformShape }
  = await import('../shared/dimensions')

test('℃(U+2103) 与 °C 都归一为 degc(旧实现只替换 ° 的缺口已修)', () => {
  assert.equal(normalizeUnit('℃'), 'degc')
  assert.equal(normalizeUnit('°C'), 'degc')
  assert.equal(normalizeUnit(' ° C '), 'degc')
  assert.equal(dimensionOf('℃'), 'temperature')
  assert.equal(dimensionOf('°C'), 'temperature')
  assert.equal(dimensionOf('degc'), 'temperature')
})

test('℉ 归一为 degf;大小写与空白容错', () => {
  assert.equal(normalizeUnit('℉'), 'degf')
  assert.equal(dimensionOf(' DEG F '), 'temperature')
  assert.equal(dimensionOf('MPa'), 'pressure')
  assert.equal(dimensionOf(' μm '), 'length')
})

test('未知单位自成一体,不与其它未知单位误配', () => {
  assert.equal(dimensionOf('widgets'), 'unit:widgets')
  assert.equal(dimensionsCompatible(dimensionOf('widgets'), dimensionOf('gizmos')), false)
  assert.equal(dimensionsCompatible(dimensionOf('widgets'), dimensionOf('widgets')), true)
})

test('复合单位原样保留;无量纲与 scalar 互认', () => {
  assert.equal(dimensionOf('kg/h'), 'compound:kg/h')
  assert.equal(dimensionsCompatible('dimensionless', 'scalar'), true)
  assert.equal(dimensionsCompatible('temperature', 'pressure'), false)
  assert.equal(dimensionsCompatible('*', 'temperature'), true)
})

test('unitRelation:同字面 same / 同量纲 convertible / 跨量纲 incompatible', () => {
  assert.deepEqual(unitRelation('bar', 'bar'), { kind: 'same' })
  assert.deepEqual(unitRelation('℃', '°C'), { kind: 'same' })
  assert.deepEqual(unitRelation('degc', 'k'), { kind: 'convertible' })
  assert.equal(unitRelation('bar', 'mm').kind, 'incompatible')
})

test('换算契约形状校验:scale=0 / NaN 一律拒绝(禁止兜底)', () => {
  assert.deepEqual(assertUnitTransformShape({ scale: 2, offset: 1 }), { scale: 2, offset: 1 })
  assert.throws(() => assertUnitTransformShape({ scale: 0, offset: 0 }), (err: { code?: string }) => err.code === 'UNIT_CONTRACT_INVALID')
  assert.throws(() => assertUnitTransformShape({ scale: Number.NaN, offset: 0 }), (err: { code?: string }) => err.code === 'UNIT_CONTRACT_INVALID')
  assert.throws(() => assertUnitTransformShape(undefined), (err: { code?: string }) => err.code === 'UNIT_CONTRACT_INVALID')
})
