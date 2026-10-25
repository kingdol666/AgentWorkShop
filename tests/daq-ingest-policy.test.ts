/**
 * WP2 数采推送鉴权/回填窗策略(纯函数,不联网):
 *  - 回填窗默认 1h(不再是 ±7 天);env 可调并钳制到 7d 上限;
 *  - 超宽配置可被识别(启动/首请求告警依据);
 *  - 鉴权模式:token 已配置 → 校验头(不匹配=token-mismatch);未配置 → 会话 + 产线权限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'

const { DEFAULT_BACKFILL_MS, MAX_BACKFILL_MS, ingestBackfillWindowMs, isWideBackfillWindow, withinBackfillWindow, ingestAuthMode } = await import('../server/services/workshop/daq/ingest-policy')

test('回填窗:缺省 1h', () => {
  assert.equal(DEFAULT_BACKFILL_MS, 3600_000)
  assert.equal(ingestBackfillWindowMs({}), 3600_000)
  assert.equal(ingestBackfillWindowMs({ AW_DAQ_INGEST_BACKFILL_MS: 'bad' }), 3600_000)
  assert.equal(ingestBackfillWindowMs({ AW_DAQ_INGEST_BACKFILL_MS: '-5' }), 3600_000)
})

test('回填窗:env 可调,钳制到 [0, 7d]', () => {
  assert.equal(ingestBackfillWindowMs({ AW_DAQ_INGEST_BACKFILL_MS: String(30 * 60_000) }), 30 * 60_000)
  assert.equal(ingestBackfillWindowMs({ AW_DAQ_INGEST_BACKFILL_MS: String(30 * 24 * 3600_000) }), MAX_BACKFILL_MS)
  assert.equal(ingestBackfillWindowMs({ AW_DAQ_INGEST_BACKFILL_MS: '0' }), 0)
})

test('超宽回填窗识别(>1h 视为安全开关打开)', () => {
  assert.equal(isWideBackfillWindow({}), false)
  assert.equal(isWideBackfillWindow({ AW_DAQ_INGEST_BACKFILL_MS: String(2 * 3600_000) }), true)
  assert.equal(isWideBackfillWindow({ AW_DAQ_INGEST_BACKFILL_MS: String(7 * 24 * 3600_000) }), true)
})

test('时间窗判定:±窗内放行、窗外拒绝、非有限值拒绝', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  assert.equal(withinBackfillWindow(now + 1800_000, now, 3600_000), true)
  assert.equal(withinBackfillWindow(now - 1800_000, now, 3600_000), true)
  assert.equal(withinBackfillWindow(now + 3600_001, now, 3600_000), false)
  assert.equal(withinBackfillWindow(now - 7 * 24 * 3600_000, now, 3600_000), false)
  assert.equal(withinBackfillWindow(Number.NaN, now, 3600_000), false)
})

test('鉴权模式:token 配置后必须匹配;未配置走会话路径(需产线 operate 权限)', () => {
  assert.equal(ingestAuthMode({ configuredToken: 't0k', providedToken: 't0k' }), 'token')
  assert.equal(ingestAuthMode({ configuredToken: 't0k', providedToken: 'wrong' }), 'token-mismatch')
  assert.equal(ingestAuthMode({ configuredToken: 't0k', providedToken: undefined }), 'token-mismatch')
  assert.equal(ingestAuthMode({}), 'session')
  assert.equal(ingestAuthMode({ providedToken: 'anything' }), 'session')
})
