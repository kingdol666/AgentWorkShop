/**
 * 帧 meta / metrics 递归净化(2026-11-15 测评 P2 回归):
 *  - 丢弃 __proto__/constructor/prototype 键(原型污染);
 *  - 丢弃 NaN/Infinity/null 化数字;
 *  - 限深/限数组/限字符串,循环引用不抛错;
 *  - metrics 只保留有限数值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { sanitizeFrameMeta, sanitizeFrameMetrics } = await import('../server/services/workshop/daq/frame-meta')

test('meta:危险键与非有限数字被丢弃', () => {
  // Object.fromEntries 用 CreateDataProperty,能把 __proto__ 落成**自有**键(JSON.parse 的 NaN 也不合法)
  const meta = Object.fromEntries([
    ['__proto__', { polluted: true }],
    ['constructor', { x: 1 }],
    ['prototype', {}],
    ['ok', 1],
    ['bad', Number.NaN],
    ['inf', Number.POSITIVE_INFINITY],
    ['nested', Object.fromEntries([['__proto__', { x: 1 }], ['keep', 2]])],
  ])
  const clean = sanitizeFrameMeta(meta)
  assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'constructor'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'prototype'), false)
  assert.equal(clean.ok, 1)
  assert.equal('bad' in clean, false)
  assert.equal('inf' in clean, false)
  assert.deepEqual(clean.nested, { keep: 2 })
})

test('meta:循环引用不抛错且被截断', () => {
  const root: Record<string, unknown> = { name: 'root' }
  root.self = root
  const clean = sanitizeFrameMeta(root)
  assert.equal(clean.name, 'root')
  assert.equal('self' in clean, false)
})

test('meta:数组/字符串受上限约束', () => {
  const clean = sanitizeFrameMeta({ points: Array.from({ length: 1000 }, (_, i) => i), text: 'x'.repeat(2000) })
  assert.equal((clean.points as number[]).length, 256)
  assert.equal((clean.text as string).length, 512)
})

test('metrics:只保留有限数值,数字字符串转数值', () => {
  const clean = sanitizeFrameMetrics({ a: 1, b: '2.5', c: Number.NaN, d: Infinity, e: { x: 1 }, f: 'oops', __proto__: 9 })
  assert.deepEqual(clean, { a: 1, b: 2.5 })
})

test('非对象输入返回空对象', () => {
  assert.deepEqual(sanitizeFrameMeta(null), {})
  assert.deepEqual(sanitizeFrameMeta('x'), {})
  assert.deepEqual(sanitizeFrameMetrics([1, 2]), {})
})
