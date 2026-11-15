/**
 * Channel 配置变更重装判定(2026-11-15 测评 P0-2 回归):
 *  - 未装配 → skip(懒装配,不冷启动 harness);
 *  - 任一成员 busy → defer(不得拆在途回合);
 *  - 信箱 pending / HITL 挂起 → defer(不得让消息滞留到看门狗);
 *  - 全 idle 且无待处理 → now。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { channelRecycleDecision } = await import('../server/services/workshop/runtime/manager/recycle-policy')

test('未装配的 Channel 不做配置重装(懒装配下次按新配置 wire)', () => {
  assert.equal(channelRecycleDecision({ states: [], hasPendingMessages: false, hasPendingApprovals: false }), 'skip')
})

test('有成员 busy 时延迟重装', () => {
  assert.equal(channelRecycleDecision({ states: ['idle', 'busy'], hasPendingMessages: false, hasPendingApprovals: false }), 'defer')
})

test('有待消费消息时延迟重装', () => {
  assert.equal(channelRecycleDecision({ states: ['idle', 'idle'], hasPendingMessages: true, hasPendingApprovals: false }), 'defer')
})

test('有挂起 HITL 审批时延迟重装', () => {
  assert.equal(channelRecycleDecision({ states: ['idle'], hasPendingMessages: false, hasPendingApprovals: true }), 'defer')
})

test('全 idle 且无待处理工作 → 立即重装', () => {
  assert.equal(channelRecycleDecision({ states: ['idle', 'idle'], hasPendingMessages: false, hasPendingApprovals: false }), 'now')
})
