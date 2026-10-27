/**
 * 实时窗口取数(tail)契约单测 —— 2026-10-27 MQTT 审计配套回归锁。
 *
 * 病根:query()/queryTagged() 的 limit 截断的是窗口**最旧**段(导出/AML 历史链路的既定
 * 契约)。实时面(/samples、daq_query、EDA)直接复用同一调用,窗口超 limit 时"最新"
 * 实为最旧段 —— 20 分钟窗口 limit=1 返回 20 分钟前的点,Agent 却当作当前值。
 *
 * 锁定的行为:
 *  ① 桶窗口被 limit 截断 → 返回**末尾** limit 个桶(仍严格升序);
 *  ② 未截断(桶数 ≤ limit) → 原样返回,不丢稀疏段;
 *  ③ 稀疏数据(桶间有空洞) → 仍取末尾 limit 个非空桶;
 *  ④ 多节点 queryTaggedLatest → 每节点各取末尾 limit 个;
 *  ⑤ 旧契约(query 默认)不变:窗口超 limit 仍返回最旧段(导出/训练集依赖)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-tail-test-'))
delete process.env.AW_BENCH_MODE

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { queryLatest, queryTaggedLatest, freshnessOf } = await import('../server/services/workshop/daq/storage/latest-window')

const BASE = 1_700_000_000_000

test('tail:桶窗口超 limit 时返回末尾 limit 个桶(升序)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  // 12 个 1s 样本,2s 桶 → 6 个桶;limit=2 应取最后两个桶(值 10/11)
  await a.writeSamples(Array.from({ length: 12 }, (_, i) => ({ nodeId: 'n-tail', tsMs: BASE + i * 1000, value: i, state: 'ok' })))
  const pts = await queryLatest(a, 'n-tail', { fromMs: BASE - 1, toMs: BASE + 60_000, bucketMs: 2000, limit: 2 })
  assert.equal(pts.length, 2)
  assert.ok(pts[0]!.at < pts[1]!.at, '仍严格升序')
  assert.equal(pts[0]!.avg, 8.5, '倒数第二个桶 = (8+9)/2')
  assert.equal(pts[1]!.avg, 10.5, '最后一个桶 = (10+11)/2')
  assert.equal(pts[1]!.cnt, 2)
})

test('tail:桶数 ≤ limit 时原样全量返回(稀疏窗口不丢历史段)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples(Array.from({ length: 4 }, (_, i) => ({ nodeId: 'n-few', tsMs: BASE + i * 10_000, value: i, state: 'ok' })))
  const pts = await queryLatest(a, 'n-few', { fromMs: BASE - 1, toMs: BASE + 60_000, bucketMs: 2000, limit: 100 })
  assert.equal(pts.length, 4)
  assert.deepEqual(pts.map(p => p.avg), [0, 1, 2, 3])
})

test('tail:桶间有空洞时仍取末尾 limit 个非空桶', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  // 只有 3 个相距很远的非空桶(中间大段无数据);limit=2 必须取最后两个桶,
  // 不能因为「最后 2s 窗口内只有 1 个桶」而少返回。
  const rows = [
    { nodeId: 'n-gap', tsMs: BASE, value: 1, state: 'ok' },
    { nodeId: 'n-gap', tsMs: BASE + 3_600_000, value: 2, state: 'ok' },
    { nodeId: 'n-gap', tsMs: BASE + 7_200_000, value: 3, state: 'ok' },
  ]
  await a.writeSamples(rows)
  const pts = await queryLatest(a, 'n-gap', { fromMs: BASE - 1, toMs: BASE + 7_200_000 + 1, bucketMs: 1000, limit: 2 })
  assert.equal(pts.length, 2)
  assert.deepEqual(pts.map(p => p.avg), [2, 3])
})

test('tail:limit=1 返回窗口内最后一个桶(不是最旧)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples(Array.from({ length: 10 }, (_, i) => ({ nodeId: 'n-one', tsMs: BASE + i * 1000, value: i, state: 'ok' })))
  const pts = await queryLatest(a, 'n-one', { fromMs: BASE - 1, toMs: BASE + 60_000, bucketMs: 1000, limit: 1 })
  assert.equal(pts.length, 1)
  assert.equal(pts[0]!.avg, 9)
})

test('tail:多节点每节点各取末尾 limit 个(queryTaggedLatest)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples([
    ...Array.from({ length: 6 }, (_, i) => ({ nodeId: 'n-a', tsMs: BASE + i * 1000, value: i, state: 'ok' })),
    ...Array.from({ length: 6 }, (_, i) => ({ nodeId: 'n-b', tsMs: BASE + i * 1000, value: 100 + i, state: 'ok' })),
  ])
  const m = await queryTaggedLatest(a, { nodeIds: ['n-a', 'n-b'], fromMs: BASE - 1, toMs: BASE + 60_000, bucketMs: 2000, limit: 2 })
  // 每节点 3 个桶:0/2/4s。末尾两个桶 = (2,3) 与 (4,5)
  assert.deepEqual(m.get('n-a')!.map(p => p.avg), [2.5, 4.5])
  assert.deepEqual(m.get('n-b')!.map(p => p.avg), [102.5, 104.5])
})

test('旧契约不变:query() 默认仍取窗口最旧段(导出/训练集依赖)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples(Array.from({ length: 12 }, (_, i) => ({ nodeId: 'n-old', tsMs: BASE + i * 1000, value: i, state: 'ok' })))
  const pts = await a.query('n-old', { fromMs: BASE - 1, toMs: BASE + 60_000, bucketMs: 2000, limit: 2 })
  assert.deepEqual(pts.map(p => p.avg), [0.5, 2.5])
})

test('freshnessOf:返回最后一点的时间与滞后', async () => {
  const pts = [{ at: 1000, avg: 1 }, { at: 5000, avg: 2 }]
  const f = freshnessOf(pts, 8000)
  assert.equal(f.latestAt, 5000)
  assert.equal(f.ageMs, 3000)
  assert.equal(freshnessOf([], 8000).latestAt, null)
})
