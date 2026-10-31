/**
 * 数采仓库层契约测试(真实 SQLite 适配器 + 统一门面):
 *  - 按 node_id 取数只返回该节点(节点隔离);
 *  - 按 line_id 过滤只返回该产线(产线隔离);
 *  - queryTaggedPage 游标分页无漏无重;
 *  - latest 返回各节点最新值;
 *  - tsdbQueryHistory 在无聚合后端退化为 raw,并带 coverage 说明;
 *  - tsdbLayoutInfo / tsdbRetentionInfo 反映当前后端与保留期。
 *
 * 这些断言锁定"仓库层实现变化不影响按节点/按产线取数语义"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-daq-storage-contract-'))
delete process.env.AW_BENCH_MODE
delete process.env.DAQ_TSDB_URL

const { getTsdb, tsdbQueryHistory, tsdbRetentionInfo, tsdbLayoutInfo } = await import('../server/services/workshop/daq/storage')

const NOW = Date.now()
const ROWS = [
  { nodeId: 'dn-a', lineId: 'ln-1', tsMs: NOW - 3000, value: 10, state: 'ok', productId: 'p1', recipeId: 'r1', runId: 'run1' },
  { nodeId: 'dn-a', lineId: 'ln-1', tsMs: NOW - 2000, value: 11, state: 'ok', productId: 'p1', recipeId: 'r1', runId: 'run1' },
  { nodeId: 'dn-b', lineId: 'ln-2', tsMs: NOW - 3000, value: 20, state: 'alarm' },
]

const tsdb = getTsdb()
// 预热:占位适配器的 init 是异步的,query 会惰性自愈;先读一次确保 db 就绪再写
await tsdb.query('warmup', { fromMs: 0, toMs: NOW, limit: 1 })
await tsdb.writeSamples(ROWS)

test('按 node_id 取数:只返回该节点,值与状态原样', async () => {
  const a = await tsdb.query('dn-a', { fromMs: NOW - 10_000, toMs: NOW, limit: 100 })
  assert.deepEqual(a.map(p => p.value), [10, 11])
  assert.deepEqual(a.map(p => p.state), ['ok', 'ok'])
  const b = await tsdb.query('dn-b', { fromMs: NOW - 10_000, toMs: NOW, limit: 100 })
  assert.equal(b.length, 1)
  assert.equal(b[0]!.value, 20)
  assert.equal(b[0]!.state, 'alarm')
})

test('queryTagged:按节点/产线过滤,批次标签与 state 同口径返回', async () => {
  const both = await tsdb.queryTagged({ nodeIds: ['dn-a', 'dn-b'], fromMs: NOW - 10_000, toMs: NOW })
  assert.deepEqual([...both.keys()].sort(), ['dn-a', 'dn-b'])
  assert.equal(both.get('dn-a')!.length, 2)
  assert.equal(both.get('dn-b')![0]!.state, 'alarm')

  const onLine = await tsdb.queryTagged({ lineId: 'ln-1', fromMs: NOW - 10_000, toMs: NOW })
  assert.deepEqual([...onLine.keys()], ['dn-a'], 'line_id=ln-1 不得返回 ln-2 的节点')

  const tagged = await tsdb.queryTagged({ productId: 'p1', recipeId: 'r1', runId: 'run1', fromMs: NOW - 10_000, toMs: NOW })
  assert.deepEqual([...tagged.keys()], ['dn-a'])
})

test('queryTaggedPage:游标严格大于 afterTs,翻页无漏无重', async () => {
  const p1 = await tsdb.queryTaggedPage!('dn-a', { fromMs: NOW - 10_000, toMs: NOW, limit: 1 })
  assert.equal(p1.points.length, 1)
  assert.equal(p1.done, false)
  assert.equal(p1.nextCursor, NOW - 3000)
  const p2 = await tsdb.queryTaggedPage!('dn-a', { fromMs: NOW - 10_000, toMs: NOW, limit: 1, afterTs: p1.nextCursor! })
  assert.equal(p2.points.length, 1)
  assert.equal(p2.points[0]!.at, NOW - 2000)
  // 契约:done 由"本页是否满 limit"判定;恰好满页时需再翻一页确认结束
  assert.equal(p2.done, false)
  const p3 = await tsdb.queryTaggedPage!('dn-a', { fromMs: NOW - 10_000, toMs: NOW, limit: 1, afterTs: p2.nextCursor! })
  assert.equal(p3.points.length, 0)
  assert.equal(p3.done, true)
  assert.equal(p3.nextCursor, null)
})

test('latest:各节点最新值(列表页兜底)', async () => {
  const latest = await tsdb.latest()
  assert.equal(latest.get('dn-a')!.value, 11)
  assert.equal(latest.get('dn-b')!.value, 20)
})

test('tsdbQueryHistory:无聚合后端退化为 raw,但有显式 coverage', async () => {
  const h = await tsdbQueryHistory('dn-a', {
    fromMs: NOW - 10_000,
    toMs: NOW,
    bucketMs: 60_000,
    lineId: 'ln-1',
    limit: 100,
  })
  assert.equal(h.resolution, 'raw')
  assert.equal(h.points.length, 1, '2 个样本落进同一 60s 桶')
  assert.equal(h.points[0]!.avg, 10.5)
  assert.equal(h.coverage.requestedFromMs, NOW - 10_000)
  assert.ok(h.coverage.rawFromMs < NOW)
  assert.match(h.coverage.note, /原始样本窗口|没有历史聚合/)
})

test('retentionInfo / layoutInfo:SQLite 后端如实报告(raw 720h、无聚合)', async () => {
  const info = tsdbRetentionInfo()
  assert.equal(info.rawRetentionH, 720)
  assert.equal(info.rollupEnabled, false)
  const layout = await tsdbLayoutInfo()
  assert.equal(layout.backend, 'sqlite-emulated')
  assert.equal(layout.layout, 'single')
  assert.equal(layout.rollup.enabled, false)
})
