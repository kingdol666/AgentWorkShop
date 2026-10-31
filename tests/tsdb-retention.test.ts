/**
 * 分层保留策略单测(纯函数):
 *  - 原始保留期内走 raw;超出后按桶宽选 1m/1h 聚合;跨边界走 mixed;
 *  - 聚合未启用时绝不"假装有历史";
 *  - 混合窗口按桶起点合并,raw 优先,超限保留最新段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOUR_ROLLUP_MS,
  MINUTE_ROLLUP_MS,
  mergeHistoryPoints,
  normalizeRetention,
  planHistoryQuery,
  rawCutoffMs,
} from '../server/services/workshop/daq/storage/retention'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const H = 3_600_000
const policy = { rawRetentionH: 720, minuteRetentionH: 8760, hourRetentionH: 0 }

test('保留期归一:非法值回退、raw 最小 1h、hour 允许 0(永久)', () => {
  const base = { rawRetentionH: 720, minuteRetentionH: 8760, hourRetentionH: 24 }
  assert.deepEqual(normalizeRetention({}, base), base)
  assert.equal(normalizeRetention({ rawRetentionH: 0 }, base).rawRetentionH, 1)
  assert.equal(normalizeRetention({ rawRetentionH: 'x' as unknown as number }, base).rawRetentionH, 720)
  assert.equal(normalizeRetention({ hourRetentionH: 0 }, base).hourRetentionH, 0)
  assert.equal(normalizeRetention({ minuteRetentionH: 999_999 }, base).minuteRetentionH, 87_600)
  assert.equal(rawCutoffMs(NOW, 720), NOW - 720 * H)
})

test('窗口在原始保留期内 → raw(即使桶宽 ≥1h)', () => {
  const p = planHistoryQuery({ fromMs: NOW - 24 * H, toMs: NOW, bucketMs: HOUR_ROLLUP_MS, nowMs: NOW, policy, hasRollup: true })
  assert.equal(p.source, 'raw')
  assert.equal(p.mixed, false)
  assert.equal(p.rollupResMs, null)
})

test('窗口早于原始保留期 → 1 分钟聚合;跨边界 → mixed', () => {
  const p = planHistoryQuery({ fromMs: NOW - 40 * 24 * H, toMs: NOW, bucketMs: MINUTE_ROLLUP_MS, nowMs: NOW, policy, hasRollup: true })
  assert.equal(p.source, 'minute')
  assert.equal(p.mixed, true)
  assert.equal(p.rollupResMs, MINUTE_ROLLUP_MS)
  assert.equal(p.rollupToMs, NOW - 720 * H)
  assert.match(p.note, /跨越原始样本保留边界/)
})

test('完全落在旧窗口 + 桶宽 ≥1h → 1 小时聚合(且不 mixed)', () => {
  const p = planHistoryQuery({ fromMs: NOW - 60 * 24 * H, toMs: NOW - 40 * 24 * H, bucketMs: HOUR_ROLLUP_MS, nowMs: NOW, policy, hasRollup: true })
  assert.equal(p.source, 'hour')
  assert.equal(p.mixed, false)
  assert.equal(p.rollupResMs, HOUR_ROLLUP_MS)
  assert.match(p.note, /1 小时聚合/)
})

test('桶宽 <1 分钟或聚合未启用 → 绝不用聚合冒充历史', () => {
  const narrow = planHistoryQuery({ fromMs: NOW - 40 * 24 * H, toMs: NOW, bucketMs: 1000, nowMs: NOW, policy, hasRollup: true })
  assert.equal(narrow.source, 'raw')
  const off = planHistoryQuery({ fromMs: NOW - 40 * 24 * H, toMs: NOW, bucketMs: MINUTE_ROLLUP_MS, nowMs: NOW, policy, hasRollup: false })
  assert.equal(off.source, 'raw')
  assert.equal(off.rollupResMs, null)
})

test('混合合并:按桶起点升序、同点 raw 优先、超限保留最新段', () => {
  const r = mergeHistoryPoints(
    [{ at: 1000, avg: 10 }, { at: 2000, avg: 20 }],
    [{ at: 2000, avg: 22 }, { at: 3000, avg: 30 }],
    10,
  )
  assert.deepEqual(r.points.map(p => [p.at, p.avg]), [[1000, 10], [2000, 22], [3000, 30]])
  assert.equal(r.truncated, false)
  const capped = mergeHistoryPoints([{ at: 1000, avg: 10 }, { at: 2000, avg: 20 }], [{ at: 3000, avg: 30 }], 2)
  assert.deepEqual(capped.points.map(p => p.at), [2000, 3000])
  assert.equal(capped.truncated, true)
})
