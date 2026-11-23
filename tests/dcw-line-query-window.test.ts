/**
 * 产线数据查询的时间窗归一:起止缺省不得落到 [1970, now]。
 * 无窗口查询会对时序超表做全表聚合(共享 Timescale 实测 10-15s),任何登录用户都能触发。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LINE_QUERY_DEFAULT_WINDOW_MS, resolveLineQueryWindow } from '../server/services/workshop/dcw/line-query-window'

const NOW = Date.UTC(2026, 10, 23, 8, 0, 0)
const DAY = 24 * 3600_000

test('起止都缺省:最近 24h,以 now 为上界', () => {
  assert.equal(LINE_QUERY_DEFAULT_WINDOW_MS, DAY)
  assert.deepEqual(resolveLineQueryWindow(undefined, undefined, NOW), { fromMs: NOW - DAY, toMs: NOW })
})

test('只给 from:上界取 now(调用方要「某时刻至今」)', () => {
  assert.deepEqual(resolveLineQueryWindow(NOW - 3 * DAY, undefined, NOW), { fromMs: NOW - 3 * DAY, toMs: NOW })
})

test('只给 to:按 24h 向前补齐(调用方要「某时刻附近」)', () => {
  assert.deepEqual(resolveLineQueryWindow(undefined, NOW, NOW), { fromMs: NOW - DAY, toMs: NOW })
})

test('起止都给:原样使用,不截断也不交换(反向窗口与 SQL 同语义返回空)', () => {
  assert.deepEqual(resolveLineQueryWindow(NOW - 7 * DAY, NOW, NOW), { fromMs: NOW - 7 * DAY, toMs: NOW })
  assert.deepEqual(resolveLineQueryWindow(NOW, NOW - DAY, NOW), { fromMs: NOW, toMs: NOW - DAY })
})

test('缺省下界不为负', () => {
  assert.deepEqual(resolveLineQueryWindow(undefined, undefined, 1000), { fromMs: 0, toMs: 1000 })
})
