/** Product-scoped DAQ query enforcement through an optional trusted execution scope. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-daq-product-scope-'))
delete process.env.AW_BENCH_MODE
delete process.env.DAQ_TSDB_URL

const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getTsdb } = await import('../server/services/workshop/daq/storage')
const { toolDaqQuery, toolDaqFrames, filterTaggedSessionRows } = await import('../server/services/workshop/agents/industrial/daq-tools')
const { exportDaqDataset } = await import('../server/services/workshop/agents/industrial/daq-export')

const AGENT = 'ag-daq-product-scope-test'
const NOW = Date.now()
const repo = getDaqNodeRepo()
repo.insert(new DaqNode({ id: 'dn-product-scope', templateRef: 'thickness-scan', name: '产品隔离温度', lineId: 'ln-product-scope', driver: 'mock' }))
repo.insert(new DaqNode({ id: 'dn-product-scope-other-line', templateRef: 'daq-temp-tc', name: '其他线温度', lineId: 'ln-other', driver: 'mock' }))
getAgentNodeBindingRepo().bind(AGENT, 'dn-product-scope', 'daq', 'auto')
getAgentNodeBindingRepo().bind(AGENT, 'dn-product-scope-other-line', 'daq', 'auto')

const tsdb = getTsdb()
await tsdb.query('warmup-product-scope', { fromMs: 0, toMs: NOW, limit: 1 })
await tsdb.writeSamples([
  { nodeId: 'dn-product-scope', lineId: 'ln-product-scope', productId: 'prod-fixed', tsMs: NOW - 240_000, value: 111, state: 'ok' },
  { nodeId: 'dn-product-scope', lineId: 'ln-product-scope', productId: 'prod-other', tsMs: NOW - 120_000, value: 999, state: 'ok' },
])

await tsdb.writeFrames([
  { nodeId: 'dn-product-scope', tsMs: NOW - 220_000, kind: 'vector', lineId: 'ln-product-scope', productId: 'prod-fixed', recipeId: 'recipe-fixed', runId: 'run-fixed', points: 2, meta: { points: [111, 112] }, metrics: {} },
  { nodeId: 'dn-product-scope', tsMs: NOW - 180_000, kind: 'vector', lineId: 'ln-product-scope', productId: 'prod-other', recipeId: 'recipe-other', runId: 'run-other', points: 2, meta: { points: [999, 1000] }, metrics: {} },
  { nodeId: 'dn-product-scope', tsMs: NOW - 150_000, kind: 'vector', lineId: 'ln-product-scope', productId: null, recipeId: null, runId: null, points: 2, meta: { points: [777, 778] }, metrics: {} },
])

const scope = { sessionId: 'sess-fixed', productId: 'prod-fixed', lineId: 'ln-product-scope', bindingSnapshotHash: 'snapshot-hash', bindingSnapshotRevision: 1, recipes: [] }
const queryWindow = { from: new Date(NOW - 600_000).toISOString(), to: new Date(NOW).toISOString() }

test('scoped query rejects a forged product selector', async () => {
  const r = await toolDaqQuery(AGENT, {
    node_id: 'dn-product-scope',
    product_id: 'prod-other',
    scope: 'all',
    ...queryWindow,
  }, scope)

  assert.equal(r.isError, true)
  assert.match(r.text, /product_id.*prod-fixed|prod-fixed.*product_id/i)
})

test('scoped query rejects a node from another trusted line', async () => {
  const r = await toolDaqQuery(AGENT, {
    node_id: 'dn-product-scope-other-line',
    scope: 'all',
    ...queryWindow,
  }, scope)

  assert.equal(r.isError, true)
  assert.match(r.text, /固定产线|不属于.*产线/i)
})

test('scope=all remains filtered to the trusted session product', async () => {
  const r = await toolDaqQuery(AGENT, {
    node_id: 'dn-product-scope',
    scope: 'all',
    ...queryWindow,
  }, scope)

  assert.equal(r.isError, undefined, r.text)
  // 用词边界匹配数值:epoch 毫秒时间戳里可能天然含有 111/999 数字串
  assert.match(r.text, /\b111\b/)
  assert.doesNotMatch(r.text, /\b999\b/)
})

test('scoped export uses tagged scalar and frame reads and never falls back to untagged readers', async () => {
  const scope = { sessionId: 'sess-fixed', lineId: 'ln-product-scope', productId: 'prod-fixed' }
  let plainReadCalled = false
  const result = await exportDaqDataset({
    targets: ['dn-product-scope'],
    nodeOf: id => ({ id, name: 'Vector', unit: '', lineId: 'ln-product-scope', signalKind: 'vector' }),
    readPoints: async () => {
      plainReadCalled = true
      return [{ at: NOW - 1, value: 999, state: 'ok' }]
    },
    readTaggedPage: async () => [{ at: NOW - 2, value: 111, state: 'ok', lineId: 'ln-product-scope', productId: 'prod-fixed' }],
    readFrames: async () => {
      plainReadCalled = true
      return [{ at: NOW - 1, kind: 'vector' as const, points: [999], lineId: 'ln-product-scope', productId: 'prod-other' }]
    },
    readTaggedFrames: async (_id, query) => {
      assert.equal(query.lineId, scope.lineId)
      assert.equal(query.productId, scope.productId)
      return [{ at: NOW - 3, kind: 'vector' as const, points: [111], lineId: scope.lineId, productId: scope.productId }]
    },
    fromMs: NOW - 10,
    toMs: NOW,
    rootDir: mkdtempSync(join(tmpdir(), 'aw-daq-scope-export-')),
    sessionScope: scope,
  })
  assert.equal(plainReadCalled, false)
  const frames = readFileSync(join(result.dir, 'frames', 'dn-product-scope.csv'), 'utf8')
  assert.match(frames, /\b111\b/)
  assert.doesNotMatch(frames, /\b999\b/)
})

test('scoped export refuses to fall back when a tagged reader is unavailable', async () => {
  let plainReadCalled = false
  await assert.rejects(() => exportDaqDataset({
    targets: ['dn-product-scope'],
    nodeOf: id => ({ id, name: 'Scalar', unit: '', lineId: 'ln-product-scope' }),
    readPoints: async () => {
      plainReadCalled = true
      return []
    },
    fromMs: NOW - 10,
    toMs: NOW,
    rootDir: mkdtempSync(join(tmpdir(), 'aw-daq-scope-export-missing-tagged-')),
    sessionScope: { sessionId: 'sess-fixed', lineId: 'ln-product-scope', productId: 'prod-fixed' },
  }), /SESSION_EXPORT_TAGGED_QUERY_UNAVAILABLE/)
  assert.equal(plainReadCalled, false)
})

test('Session frame handler rejects missing snapshot scope and only returns the fixed product frames', async () => {
  const noScope = await toolDaqFrames(AGENT, { node_id: 'dn-product-scope', ...queryWindow })
  assert.equal(noScope.isError, undefined, noScope.text)
  assert.match(noScope.text, /轮廓|111|999/, 'legacy non-session calls retain line-level frame access')

  const scoped = await toolDaqFrames(AGENT, { node_id: 'dn-product-scope', ...queryWindow }, scope)
  assert.equal(scoped.isError, undefined, scoped.text)
  assert.match(scoped.text, /\b111\b/)
  assert.doesNotMatch(scoped.text, /\b999\b|\b777\b/)
})

test('tagged frame adapter enforces line/product in SQL; untagged legacy frames fail closed in Session tools', async () => {
  const tagged = await tsdb.queryTaggedFrames!('dn-product-scope', {
    fromMs: NOW - 600_000,
    toMs: NOW,
    lineId: 'ln-product-scope',
    productId: 'prod-fixed',
  })
  assert.equal(tagged.length, 1)
  assert.equal(tagged[0]!.productId, 'prod-fixed')
  assert.deepEqual(filterTaggedSessionRows([
    { lineId: 'ln-product-scope', productId: 'prod-fixed', at: 1 },
    { lineId: 'ln-product-scope', productId: 'prod-other', at: 2 },
    { lineId: null, productId: null, at: 3 },
  ], scope), [{ lineId: 'ln-product-scope', productId: 'prod-fixed', at: 1 }])
})

test('legacy scope=all without trusted scope still spans products', async () => {
  const r = await toolDaqQuery(AGENT, {
    node_id: 'dn-product-scope',
    scope: 'all',
    ...queryWindow,
  })

  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /111/)
  assert.match(r.text, /999/)
})
