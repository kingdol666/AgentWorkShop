/**
 * WP4 容量可配回归：resolveDispatchLimits 的缺省值与钳制（plan §3 WP4）。
 * 缺省必须与改造前硬编码一致（4/2），perChannel 恒为 1（每实例 Channel 单根硬约束）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDispatchLimits, DISPATCH_LIMITS_BOUNDS } from '../server/services/workshop/projects/dispatch-limits'

test('DL-1 缺省：undefined/空对象 → 4/2（与改造前行为一致）', () => {
  assert.deepEqual(resolveDispatchLimits(undefined), { perChannel: 1, perProject: 4, perTick: 2 })
  assert.deepEqual(resolveDispatchLimits(null), { perChannel: 1, perProject: 4, perTick: 2 })
  assert.deepEqual(resolveDispatchLimits({}), { perChannel: 1, perProject: 4, perTick: 2 })
})

test('DL-2 配置生效 + 钳制边界', () => {
  assert.deepEqual(resolveDispatchLimits({ dispatch_per_project: 8, dispatch_per_tick: 4 }), { perChannel: 1, perProject: 8, perTick: 4 })
  // 下界
  assert.deepEqual(resolveDispatchLimits({ dispatch_per_project: 0, dispatch_per_tick: -1 }), { perChannel: 1, perProject: 1, perTick: 1 })
  // 上界
  assert.deepEqual(resolveDispatchLimits({ dispatch_per_project: 999, dispatch_per_tick: 999 }), {
    perChannel: 1,
    perProject: DISPATCH_LIMITS_BOUNDS.perProject.max,
    perTick: DISPATCH_LIMITS_BOUNDS.perTick.max,
  })
  // 非数字回退缺省；字符串数字可解析
  assert.deepEqual(resolveDispatchLimits({ dispatch_per_project: 'abc', dispatch_per_tick: '6' }), { perChannel: 1, perProject: 4, perTick: 6 })
  // 小数取整
  assert.deepEqual(resolveDispatchLimits({ dispatch_per_project: 5.9, dispatch_per_tick: 3.2 }), { perChannel: 1, perProject: 5, perTick: 3 })
})

test('DL-3 perChannel 恒为 1（不可配置）', () => {
  const limits = resolveDispatchLimits({ dispatch_per_project: 16, dispatch_per_tick: 8 })
  assert.equal(limits.perChannel, 1)
})
