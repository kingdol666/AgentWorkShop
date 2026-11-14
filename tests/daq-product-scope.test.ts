/** Product-scoped DAQ query enforcement through an optional trusted execution scope. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
const { toolDaqQuery } = await import('../server/services/workshop/agents/industrial/daq-tools')

const AGENT = 'ag-daq-product-scope-test'
const NOW = Date.now()
const repo = getDaqNodeRepo()
repo.insert(new DaqNode({ id: 'dn-product-scope', templateRef: 'daq-temp-tc', name: '产品隔离温度', lineId: 'ln-product-scope', driver: 'mock' }))
repo.insert(new DaqNode({ id: 'dn-product-scope-other-line', templateRef: 'daq-temp-tc', name: '其他线温度', lineId: 'ln-other', driver: 'mock' }))
getAgentNodeBindingRepo().bind(AGENT, 'dn-product-scope', 'daq', 'auto')
getAgentNodeBindingRepo().bind(AGENT, 'dn-product-scope-other-line', 'daq', 'auto')

const tsdb = getTsdb()
await tsdb.query('warmup-product-scope', { fromMs: 0, toMs: NOW, limit: 1 })
await tsdb.writeSamples([
  { nodeId: 'dn-product-scope', lineId: 'ln-product-scope', productId: 'prod-fixed', tsMs: NOW - 240_000, value: 111, state: 'ok' },
  { nodeId: 'dn-product-scope', lineId: 'ln-product-scope', productId: 'prod-other', tsMs: NOW - 120_000, value: 999, state: 'ok' },
])

const scope = { sessionId: 'sess-fixed', productId: 'prod-fixed', lineId: 'ln-product-scope' }
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
  assert.match(r.text, /111/)
  assert.doesNotMatch(r.text, /999/)
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
