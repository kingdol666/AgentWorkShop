/**
 * queryTaggedPage 批次标签过滤契约(2026-10-29 串味修复回归锁):
 *   - 训练分页此前只按时间窗取数(不过滤 product/recipe/run),Timescale 部署上
 *     产品隔离退化为"时间窗推断";修复后分页与 queryTagged 语义等价。
 *   - 契约:提供任一标签即等值过滤(等值天然排除未打标 NULL 行);
 *     全部留空 = 纯时间窗原始分页(可用性水位等全量观测语义不变)。
 *   - fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口。
 * 夹具:AW_HOME 指临时目录,SqliteTimeSeriesAdapter 真库真查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-tagged-page-'))
delete process.env.AW_BENCH_MODE

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')

const BASE = 1_700_000_000_000
const runA = Array.from({ length: 4 }, (_, i) => ({
  nodeId: 'n-tag', tsMs: BASE + i * 1000, value: i, state: 'ok',
  lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', runId: 'rr-a',
}))
const runB = Array.from({ length: 3 }, (_, i) => ({
  nodeId: 'n-tag', tsMs: BASE + 10_000 + i * 1000, value: 100 + i, state: 'ok',
  lineId: 'ln-1', productId: 'pd-2', recipeId: 'rc-2', runId: 'rr-b',
}))
const untagged = Array.from({ length: 2 }, (_, i) => ({
  nodeId: 'n-tag', tsMs: BASE + 20_000 + i * 1000, value: 900 + i, state: 'ok',
  lineId: null, productId: null, recipeId: null, runId: null,
}))

async function freshAdapter() {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  await a.writeSamples([...runA, ...runB, ...untagged] as never[])
  return a
}

test('契约:按 productId 等值过滤,未打标行与异产品行都不出现', async () => {
  const a = await freshAdapter()
  const page = await a.queryTaggedPage!('n-tag', { productId: 'pd-1' })
  assert.equal(page.points.length, 4)
  assert.ok(page.points.every(p => p.value < 100), '只能含 run-A 的值')
})

test('契约:按 runId / recipeId 过滤各自只中目标批次', async () => {
  const a = await freshAdapter()
  const byRun = await a.queryTaggedPage!('n-tag', { runId: 'rr-b' })
  assert.equal(byRun.points.length, 3)
  assert.ok(byRun.points.every(p => p.value >= 100 && p.value < 200))
  const byRecipe = await a.queryTaggedPage!('n-tag', { recipeId: 'rc-1' })
  assert.equal(byRecipe.points.length, 4)
})

test('契约:lineId 过滤含两个批次但排除未打标段', async () => {
  const a = await freshAdapter()
  const page = await a.queryTaggedPage!('n-tag', { lineId: 'ln-1' })
  assert.equal(page.points.length, 7)
})

test('契约:全留空 = 原始时间窗(含未打标行),分页/游标语义不变', async () => {
  const a = await freshAdapter()
  const all = await a.queryTaggedPage!('n-tag', { limit: 100 })
  assert.equal(all.points.length, 9)
  const page1 = await a.queryTaggedPage!('n-tag', { limit: 2 })
  assert.equal(page1.points.length, 2)
  const page2 = await a.queryTaggedPage!('n-tag', { limit: 100, afterTs: page1.nextCursor! })
  assert.equal(page1.points.length + page2.points.length, 9, '游标续页无漏无重')
})

test('契约:过滤 + 分页组合 = 只取目标批次的全部点(游标续读不串批)', async () => {
  const a = await freshAdapter()
  const collected: number[] = []
  let afterTs: number | undefined
  for (;;) {
    const page = await a.queryTaggedPage!('n-tag', { productId: 'pd-1', limit: 3, afterTs })
    collected.push(...page.points.map(p => p.value))
    if (page.done || page.nextCursor == null) break
    afterTs = page.nextCursor
  }
  assert.deepEqual(collected.sort((x, y) => x - y), [0, 1, 2, 3])
})

test('fetchNodeSeries(AML 训练取数)必须把三元组透传给分页接口', async () => {
  const { fetchNodeSeries } = await import('../server/services/workshop/aml/dataset-builder')
  const seen: Array<Record<string, unknown>> = []
  const stub = {
    queryTaggedPage: async (_nodeId: string, q: Record<string, unknown>) => {
      seen.push(q)
      return { nodeId: _nodeId, points: [], nextCursor: null, done: true }
    },
  }
  const pts = await fetchNodeSeries(stub as never, 'n-x', {
    lineId: 'ln-9', productId: 'pd-9', recipeId: 'rc-9', runId: 'rr-9', fromMs: 1, toMs: 2,
  })
  assert.equal(pts.length, 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.productId, 'pd-9')
  assert.equal(seen[0]!.recipeId, 'rc-9')
  assert.equal(seen[0]!.runId, 'rr-9')
  assert.equal(seen[0]!.lineId, 'ln-9')
})
