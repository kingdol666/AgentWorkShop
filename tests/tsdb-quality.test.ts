/**
 * G2 时序数据质量(A1/A15/A16):
 *  - queryTagged raw 返回真实 state,cleanPoints 实际剔除坏点;
 *  - ingestedAt 首写胜出 + 同键更正被计数丢弃;
 *  - 逐节点分页无漏无重;迟到但新鲜样本不被事件时间误删。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-quality-'))

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { cleanPoints } = await import('../server/services/workshop/aml/clean')

const adapter = new SqliteTimeSeriesAdapter()
await adapter.init()

test('A15:queryTagged raw 返回真实 state;cleanPoints 实际剔除坏点', async () => {
  const now = Date.now()
  await adapter.writeSamples([
    { nodeId: 'n-bad', tsMs: now - 4000, value: 1, state: 'ok' },
    { nodeId: 'n-bad', tsMs: now - 3000, value: 2, state: 'alarm' },
    { nodeId: 'n-bad', tsMs: now - 2000, value: 3, state: 'offline' },
    { nodeId: 'n-bad', tsMs: now - 1000, value: 4, state: 'ok' },
  ])
  const tagged = await adapter.queryTagged({ nodeIds: ['n-bad'], fromMs: now - 10_000, toMs: now })
  const points = tagged.get('n-bad') ?? []
  assert.equal(points.length, 4)
  assert.deepEqual(points.map(p => p.state), ['ok', 'alarm', 'offline', 'ok'])
  const cleaned = cleanPoints(points.map(p => ({ at: p.at, value: p.value as number, state: p.state })), {})
  assert.equal(cleaned.counts.droppedState, 2)
  assert.equal(cleaned.values.length, 2)
})

test('A16:同键不同值 → 首值保留且 correctionDropped+1(不静默)', async () => {
  const now = Date.now()
  await adapter.writeSamples([{ nodeId: 'n-cor', tsMs: now - 1000, value: 10, state: 'ok' }])
  const before = adapter.stats().correctionDropped
  await adapter.writeSamples([{ nodeId: 'n-cor', tsMs: now - 1000, value: 99, state: 'alarm' }])
  const points = await adapter.query('n-cor', { fromMs: now - 10_000, toMs: now })
  assert.equal(points.length, 1)
  assert.equal(points[0]!.value, 10)
  assert.equal(points[0]!.state, 'ok')
  assert.equal(adapter.stats().correctionDropped, before + 1)
  // 同键同值重复写入不计更正
  await adapter.writeSamples([{ nodeId: 'n-cor', tsMs: now - 1000, value: 10, state: 'ok' }])
  assert.equal(adapter.stats().correctionDropped, before + 1)
})

test('A1:逐节点分页稳定 ASC、游标续读、无漏无重', async () => {
  const now = Date.now()
  const base = now - 60_000
  const rows = Array.from({ length: 25 }, (_, i) => ({ nodeId: 'n-page', tsMs: base + i * 1000, value: i, state: 'ok', ingestedAt: now }))
  await adapter.writeSamples(rows)
  const seen: number[] = []
  let afterTs: number | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = await adapter.queryTaggedPage('n-page', { afterTs, fromMs: base, toMs: now, limit: 7, withState: true })
    seen.push(...page.points.map(p => p.value as number))
    if (page.done) break
    afterTs = page.nextCursor ?? undefined
    assert.equal(page.points.every((p, i, arr) => i === 0 || p.at > arr[i - 1]!.at), true)
  }
  assert.deepEqual(seen, Array.from({ length: 25 }, (_, i) => i))
  assert.equal(new Set(seen).size, 25)
  // ingestedAt 随分页返回
  const p = await adapter.queryTaggedPage('n-page', { fromMs: base, limit: 1 })
  assert.equal(typeof p.points[0]!.ingestedAt, 'number')
})

test('A16 ④:旧数据 ingestedAt 缺失 → 分页点不伪造到达时间', async () => {
  const now = Date.now()
  // 直接走 writeSamples 会给 ingestedAt;这里模拟历史行(直接置 NULL)
  const db = (adapter as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
  db.prepare('UPDATE daq_samples SET ingested_at = NULL WHERE node_id = ?').run('n-page')
  const p = await adapter.queryTaggedPage('n-page', { fromMs: now - 120_000, limit: 5 })
  assert.equal(p.points.some(x => x.ingestedAt != null), false)
})

test('A16 ③:迟到但新鲜的样本不被事件时间误删', async () => {
  const dbPath = join(process.env.AW_HOME!, 'daq-timeseries.sqlite')
  void dbPath
  const now = Date.now()
  const ancient = now - 400 * 24 * 3600_000 // 远超保留期
  await adapter.writeSamples([
    { nodeId: 'n-late', tsMs: ancient, value: 1, state: 'ok', ingestedAt: now },
    { nodeId: 'n-late', tsMs: ancient - 1000, value: 2, state: 'ok', ingestedAt: ancient - 24 * 3600_000 },
  ])
  // 重开触发 sweepRetention(启动清理)
  await adapter.close()
  await adapter.init()
  const points = await adapter.query('n-late', { fromMs: ancient - 10_000, toMs: now })
  // 事件时间老但在期内入库 → 保留;两者都入库老 → 删除
  assert.equal(points.length, 1)
  assert.equal(points[0]!.value, 1)
})
