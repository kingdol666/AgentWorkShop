/**
 * H4(2026-11-03):监督回合中止 → cancel 决策映射的纯函数单测。
 *
 * 背景:P4 修复把 abortTurn 的空决策改成显式 cancel,但当时只能靠类型/lint 验证。
 * 这里钉死语义边界:
 *  - 显式外部取消 → 有在办任务时必须产生 cancel(带原因);
 *  - **硬超时 → 无决策**(2026-11-10 修订):慢回合是常态,超时只说明本轮监督没跑完;
 *    取消任务属治理决定(owner/deadline),不是超时的副作用。旧语义把它当硬中止,
 *    叠加 360s 硬编码,导致项目 root 每 6 分钟被"取消"一次、40 分钟不推进。
 *  - 无在办任务 → 无决策(不能凭空 cancel);
 *  - watchdog / 其他原因 → 无决策(watchdog 只记录信号,不杀回合)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abortToCancelDecision, isHardAbortReason } from '../server/services/workshop/agents/omp-agent/supervision-decision'

test('external cancel + 在办任务 → cancel 决策(带原因与任务 id)', () => {
  const d = abortToCancelDecision({ reason: 'external cancel', activeTaskId: 'task-1' })
  assert.ok(d)
  assert.equal(d.kind, 'cancel')
  assert.equal(d.taskId, 'task-1')
  assert.match(d.reason ?? '', /external cancel/)
  assert.match(d.reason ?? '', /重新派发/)
})

test('hard timeout(任意毫秒数)→ 无决策(慢回合不取消任务)', () => {
  assert.equal(abortToCancelDecision({ reason: 'hard timeout(1800000ms)', activeTaskId: 'task-2' }), null)
})

test('无在办任务 → 无决策(不得凭空 cancel)', () => {
  assert.equal(abortToCancelDecision({ reason: 'external cancel', activeTaskId: null }), null)
  assert.equal(abortToCancelDecision({ reason: 'external cancel' }), null)
  assert.equal(abortToCancelDecision({ reason: 'external cancel', activeTaskId: '   ' }), null)
})

test('watchdog / 非硬中止原因 → 无决策(慢回合不误杀)', () => {
  assert.equal(abortToCancelDecision({ reason: 'watchdog', activeTaskId: 'task-3' }), null)
  assert.equal(abortToCancelDecision({ reason: 'runtime stop', activeTaskId: 'task-3' }), null)
  // 前缀必须完整匹配,不能把自定义文案里夹带 "hard timeout" 当成硬超时
  assert.equal(abortToCancelDecision({ reason: 'not-hard timeout', activeTaskId: 'task-3' }), null)
})

test('isHardAbortReason 只认显式外部取消(硬超时已从收口语义移除)', () => {
  assert.equal(isHardAbortReason('external cancel'), true)
  assert.equal(isHardAbortReason('hard timeout(1000ms)'), false)
  assert.equal(isHardAbortReason('hard'), false)
  assert.equal(isHardAbortReason(''), false)
})
