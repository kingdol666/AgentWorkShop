import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  classifyHarnessFailure,
  recordHarnessFailure,
  harnessBreakerActive,
  HARNESS_TERMINAL_CLASSES,
  HARNESS_FAIL_STREAK_LIMIT,
  HARNESS_FAIL_COOLDOWN_MS,
} = await import('../server/services/workshop/runtime/agent-runtime/harness-failure')

// 缺陷2修复(2026-10-30):LLM 预算耗尽等"重试无意义"的 harness 回合失败,
// 连续同类达阈值 → 熔断(任务落 FAILED + 停止重投),冷却后半开放行探测。
// 本文件测纯函数层(分类/连败串/熔断判定);接线在 agent-runtime/message.ts。

const T0 = 1_700_000_000_000

test('classify: 422/budget → budget;401/key → auth;404 → model;ECONN → network;其余 other', () => {
  assert.equal(classifyHarnessFailure('OMP_LLM_422', 'Budget has been exceeded! Current cost: 100.0, Max budget: 100.0'), 'budget')
  assert.equal(classifyHarnessFailure('OMP_LLM_ERROR', 'budget_exceeded param=422'), 'budget')
  assert.equal(classifyHarnessFailure('OMP_LLM_401', 'invalid api-key'), 'auth')
  assert.equal(classifyHarnessFailure('OMP_LLM_403', 'Forbidden'), 'auth')
  assert.equal(classifyHarnessFailure('OMP_LLM_404', 'model not found: gpt-x'), 'model')
  assert.equal(classifyHarnessFailure('RUN_ERROR', 'connect ECONNREFUSED 127.0.0.1:9'), 'network')
  assert.equal(classifyHarnessFailure('RPC_BROKEN', 'omp 子进程退出'), 'network')
  assert.equal(classifyHarnessFailure('OMP_LLM_ERROR', '未知错误'), 'other')
})

test('classify: network(可重试类)不参与熔断', () => {
  assert.equal(HARNESS_TERMINAL_CLASSES.has('network'), false)
  assert.equal(HARNESS_TERMINAL_CLASSES.has('other'), false)
})

test('streak: 同类累加,异类重置为 1', () => {
  let s = recordHarnessFailure(null, 'budget', T0)
  s = recordHarnessFailure(s, 'budget', T0 + 1000)
  assert.equal(s.count, 2)
  s = recordHarnessFailure(s, 'auth', T0 + 2000)
  assert.equal(s.cls, 'auth')
  assert.equal(s.count, 1)
})

test('breaker: 终态类达阈值且在冷却窗内生效;network 达阈值也不熔断', () => {
  let s = recordHarnessFailure(null, 'budget', T0)
  for (let i = 1; i < HARNESS_FAIL_STREAK_LIMIT - 1; i++) s = recordHarnessFailure(s, 'budget', T0 + i * 1000)
  assert.equal(s.count, HARNESS_FAIL_STREAK_LIMIT - 1)
  assert.equal(harnessBreakerActive(s, T0 + 2000), false, '阈值前不熔断')
  s = recordHarnessFailure(s, 'budget', T0 + 3000)
  assert.equal(s.count, HARNESS_FAIL_STREAK_LIMIT)
  assert.equal(harnessBreakerActive(s, T0 + 3000), true, '达阈值即熔断')
  assert.equal(harnessBreakerActive(s, T0 + 3000 + HARNESS_FAIL_COOLDOWN_MS - 1), true, '冷却窗内仍熔断')
  assert.equal(harnessBreakerActive(s, T0 + 3000 + HARNESS_FAIL_COOLDOWN_MS), false, '冷却窗后半开放行探测')
  // 半开探测再失败:立即重新熔断
  const s2 = recordHarnessFailure(s, 'budget', T0 + 3000 + HARNESS_FAIL_COOLDOWN_MS + 100)
  assert.equal(harnessBreakerActive(s2, T0 + 3000 + HARNESS_FAIL_COOLDOWN_MS + 100), true)
})

test('breaker: 熔断后异类(network)失败不再熔断,成功复位由调用方置 null', () => {
  let s = recordHarnessFailure(null, 'budget', T0)
  s = recordHarnessFailure(s, 'budget', T0 + 1000)
  s = recordHarnessFailure(s, 'budget', T0 + 2000)
  assert.equal(harnessBreakerActive(s, T0 + 2000), true)
  const s3 = recordHarnessFailure(s, 'network', T0 + 2100)
  assert.equal(harnessBreakerActive(s3, T0 + 2100), false, '异类重置后未达终态阈值')
})
