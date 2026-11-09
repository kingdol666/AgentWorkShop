/**
 * E5-lite 配对评测统计（WP-B2）：t 分布 / 配对差 / 成本差 / 配对不足。
 * 直接导入 bench 脚本的纯函数（CI 可跑，不需要平台或模拟器）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pairedStats, tTwoSidedP, mean, sd } = await import('../bench/experiment/harness-ab.mjs')

test('t 分布双侧 p：对齐已知真值（t=2.262,df=9 → 0.05；t=0 → 1）', () => {
  assert.ok(Math.abs(tTwoSidedP(2.262157, 9) - 0.05) < 0.002)
  assert.equal(tTwoSidedP(0, 5), 1)
  assert.equal(tTwoSidedP(Number.NaN, 5), 1)
  assert.equal(tTwoSidedP(2, 0), 1)
})

test('配对统计：一致改善 → p 极小、Δ>0、成本差按相对值', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({ seed: i, a: 110 + i * 0.1, b: 109 + i * 0.1, costA: 100, costB: 101 }))
  const st = pairedStats(pairs)
  assert.ok(st.pValue < 1e-6)
  assert.ok(st.primaryDelta > 0)
  assert.ok(Math.abs(st.costDelta - 0.01) < 1e-9)
  assert.equal(st.n, 10)
})

test('配对统计：无差 → p=1；一致劣化 → Δ<0；n<2 → pValue=null', () => {
  const same = Array.from({ length: 6 }, (_, i) => ({ seed: i, a: 5, b: 5 }))
  assert.equal(pairedStats(same).pValue, 1)

  const bad = Array.from({ length: 10 }, (_, i) => ({ seed: i, a: 100 + i, b: 101 + i }))
  assert.ok(pairedStats(bad).primaryDelta < 0)

  assert.equal(pairedStats([{ seed: 1, a: 1, b: 2 }]).pValue, null)
})

test('higherBetter：方向反转（越大越好时 B 更大为改善）', () => {
  const pairs = [{ seed: 1, a: 1, b: 2 }, { seed: 2, a: 1, b: 2 }]
  assert.ok(pairedStats(pairs, { higherBetter: true }).primaryDelta > 0)
  assert.ok(pairedStats(pairs).primaryDelta < 0)
})

test('基元：mean / sd 边界', () => {
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(sd([1]), 0)
  assert.equal(sd([1, 1, 1]), 0)
  assert.ok(Math.abs(sd([1, 2, 3]) - 1) < 1e-12)
})
