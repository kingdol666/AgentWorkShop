import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DcwNode } from '../server/services/workshop/dcw/dcw-node'

const make = () => new DcwNode({
  id: `dw-attempt-${Math.random().toString(16).slice(2)}`,
  templateRef: 'dcw-pressure-sp', driver: 'mock', min: 0, max: 100, unit: 'bar', decimals: 1, stepLimit: 5,
})

test('失败写只记尝试时间:不更新 lastWriteAt/value,状态 error', () => {
  const n = make()
  n.applyWriteResult(50, false, 'OPC UA 连接失败', '2026-10-29T00:00:01.000+08:00')
  assert.equal(n.lastAttemptAt, '2026-10-29T00:00:01.000+08:00')
  assert.equal(n.lastWriteAt, null)
  assert.equal(n.lastAckAt, null)
  assert.equal(n.value, null)
  assert.equal(n.state, 'error')
  assert.match(String(n.lastError), /连接失败/)
})

test('成功写同时更新尝试/成功/ACK 三个时间', () => {
  const n = make()
  n.applyWriteResult(50, true, '写入并回读一致', '2026-10-29T00:00:02.000+08:00')
  assert.equal(n.lastAttemptAt, '2026-10-29T00:00:02.000+08:00')
  assert.equal(n.lastWriteAt, '2026-10-29T00:00:02.000+08:00')
  assert.equal(n.lastAckAt, '2026-10-29T00:00:02.000+08:00')
  assert.equal(n.value, 50)
  assert.equal(n.state, 'ok')
})

test('成功后再失败:lastWriteAt 保持上次成功时间,设备确认值不被失败指令污染', () => {
  const n = make()
  n.applyWriteResult(50, true, 'ok', '2026-10-29T00:00:02.000+08:00')
  n.applyWriteResult(52, false, 'timeout', '2026-10-29T00:00:09.000+08:00')
  assert.equal(n.lastWriteAt, '2026-10-29T00:00:02.000+08:00')
  assert.equal(n.lastAttemptAt, '2026-10-29T00:00:09.000+08:00')
  assert.equal(n.value, 50)
  assert.equal(n.state, 'error')
})

test('持久化往返保留 lastAttemptAt;旧快照(仅有 lastWriteAt)自动补尝试时间', () => {
  const n = make()
  n.applyWriteResult(40, true, 'ok', '2026-10-29T00:01:00.000+08:00')
  n.applyWriteResult(41, false, 'offline', '2026-10-29T00:01:05.000+08:00')
  const restored = DcwNode.fromRow(JSON.parse(JSON.stringify(n.toRow())))
  assert.equal(restored.lastWriteAt, '2026-10-29T00:01:00.000+08:00')
  assert.equal(restored.lastAttemptAt, '2026-10-29T00:01:05.000+08:00')

  const legacy = DcwNode.fromRow({ ...n.toRow(), lastAttemptAt: undefined })
  assert.equal(legacy.lastWriteAt, '2026-10-29T00:01:00.000+08:00')
  assert.equal(legacy.lastAttemptAt, '2026-10-29T00:01:00.000+08:00')
})
