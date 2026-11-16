/**
 * 消息看门狗判定纯函数回归(2026-11-16 复现回归)。
 *
 * 旧实现:固定 600s 从 claim 起算、不区分活动、HITL 人工等待也算停滞 ——
 * 实测把 16 分钟健康治理回合(含 4 分钟 HITL)连续 abort+重投 3 次直到 dead。
 * 新语义钉死:
 *  - 有 harness 活动就重置窗口(慢模型逐回合 40s-4min 不再误杀);
 *  - 有挂起 HITL 审批 → 永不 fire(人工裁决是合法等待);
 *  - 运行时 stopped → 永不 fire;
 *  - 真无活动超阈值才 fire。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { shouldFireMessageWatchdog, MESSAGE_WATCHDOG_TICK_MS } = await import('../server/services/workshop/runtime/agent-runtime/message-watchdog')

const base = { state: 'busy', lastActivityAt: 0, now: 600_000, stallMs: 600_000, hasPendingApprovals: false }

test('无活动超过阈值且无挂起审批 → fire', () => {
  assert.equal(shouldFireMessageWatchdog(base), true)
})

test('阈值内有 harness 活动 → 不 fire(活动窗口语义)', () => {
  assert.equal(shouldFireMessageWatchdog({ ...base, lastActivityAt: 600_000 - 1 }), false)
  // 事件每来一个就重置:16 分钟回合只要持续有事件就永不 fire(旧固定死线会 fire)
  assert.equal(shouldFireMessageWatchdog({ ...base, lastActivityAt: 60_000, now: 610_000 }), false)
})

test('有挂起 HITL 审批 → 永不 fire(人工等待不是停滞)', () => {
  assert.equal(shouldFireMessageWatchdog({ ...base, hasPendingApprovals: true }), false)
  // 即使远超阈值:有人在裁,等待窗口顺延而不是杀回合
  assert.equal(shouldFireMessageWatchdog({ ...base, now: 3_600_000, hasPendingApprovals: true }), false)
})

test('运行时 stopped → 永不 fire', () => {
  assert.equal(shouldFireMessageWatchdog({ ...base, state: 'stopped' }), false)
})

test('巡检节奏独立于阈值(30s tick,阈值可配置)', () => {
  assert.equal(MESSAGE_WATCHDOG_TICK_MS, 30_000)
  assert.equal(shouldFireMessageWatchdog({ ...base, stallMs: 60_000, now: 60_001, lastActivityAt: 0 }), true)
  assert.equal(shouldFireMessageWatchdog({ ...base, stallMs: 60_000, now: 59_999, lastActivityAt: 0 }), false)
})
