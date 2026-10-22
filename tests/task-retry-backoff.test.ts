/**
 * FAILED 任务重派回退窗(2026-10-19):
 * 防止调度器在 worker 尚未消费新 assign 时连续换 lease,导致 3 次重试
 * 在 0.4s 内全部变成「旧执行代次」丢弃、父任务被 CHILD_RETRIES_EXHAUSTED 收口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAILED_RETRY_BACKOFF_MS, failedRetryReady } from '../server/services/workshop/types/task'

test('FAILED retry backoff: 回退窗内不得重派,窗外放行', () => {
  assert.ok(FAILED_RETRY_BACKOFF_MS >= 1000, '回退窗至少 1s,否则重试会再次跑在 worker 消费之前')
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  assert.equal(failedRetryReady({ updatedAt: new Date(now - 100).toISOString() }, now), false)
  assert.equal(failedRetryReady({ updatedAt: new Date(now - FAILED_RETRY_BACKOFF_MS + 1).toISOString() }, now), false)
  assert.equal(failedRetryReady({ updatedAt: new Date(now - FAILED_RETRY_BACKOFF_MS).toISOString() }, now), true)
  assert.equal(failedRetryReady({ updatedAt: new Date(now - 5000).toISOString() }, now), true)
})

test('FAILED retry backoff: 非法 updatedAt 放行,避免历史脏数据永久卡死', () => {
  assert.equal(failedRetryReady({ updatedAt: 'not-a-time' }), true)
})
