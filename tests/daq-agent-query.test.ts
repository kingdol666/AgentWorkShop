/**
 * Agent 数采取数测试(真实 SQLite 时序库 + 真实节点/绑定仓储):
 *  - 多字段(node_ids)+ ISO 起止时间(from/to);
 *  - 越权节点拒绝、跨产线过滤冲突拒绝、非法时间格式拒绝;
 *  - 旧参数(node_id + last_minutes)完全兼容;
 *  - 返回文本包含物理语义(节点名/单位)与数值,证明上层调用方式未变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-daq-agent-query-'))
delete process.env.AW_BENCH_MODE
delete process.env.DAQ_TSDB_URL

const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getTsdb } = await import('../server/services/workshop/daq/storage')
const { toolDaqQuery } = await import('../server/services/workshop/agents/industrial/daq-tools')

const AGENT = 'ag-daq-test'
const NOW = Date.now()
const repo = getDaqNodeRepo()
repo.insert(new DaqNode({ id: 'dn-a', templateRef: 'daq-temp-tc', name: '一号温度', lineId: 'ln-1', driver: 'mock' }))
repo.insert(new DaqNode({ id: 'dn-b', templateRef: 'daq-pressure-tx', name: '二号压力', lineId: 'ln-2', driver: 'mock' }))
getAgentNodeBindingRepo().bind(AGENT, 'dn-a', 'daq', 'auto')
getAgentNodeBindingRepo().bind(AGENT, 'dn-b', 'daq', 'auto')

const tsdb = getTsdb()
await tsdb.query('warmup', { fromMs: 0, toMs: NOW, limit: 1 })
await tsdb.writeSamples([
  { nodeId: 'dn-a', lineId: 'ln-1', tsMs: NOW - 300_000, value: 168, state: 'ok' },
  { nodeId: 'dn-a', lineId: 'ln-1', tsMs: NOW - 120_000, value: 169, state: 'ok' },
  { nodeId: 'dn-b', lineId: 'ln-2', tsMs: NOW - 300_000, value: 0.82, state: 'ok' },
])

const FROM = new Date(NOW - 600_000).toISOString()
const TO = new Date(NOW).toISOString()

test('node_ids + ISO 起止时间:两节点都返回物理语义与数值', async () => {
  const r = await toolDaqQuery(AGENT, {
    node_ids: ['dn-a', 'dn-b'],
    from: FROM,
    to: TO,
    bucket_ms: 60_000,
    scope: 'all',
    limit: 100,
  })
  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /一号温度/)
  assert.match(r.text, /二号压力/)
  assert.match(r.text, /169/)
  assert.match(r.text, /0\.82/)
  assert.match(r.text, /时间窗/)
})

test('旧参数 node_id + last_minutes 完全兼容', async () => {
  const r = await toolDaqQuery(AGENT, { node_id: 'dn-a', last_minutes: 30, scope: 'all' })
  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /一号温度/)
  assert.match(r.text, /169/)
})

test('越权节点拒绝,并列出可读节点', async () => {
  const r = await toolDaqQuery(AGENT, { node_id: 'dn-x', scope: 'all' })
  assert.equal(r.isError, true)
  assert.match(r.text, /无权查询节点 dn-x/)
  assert.match(r.text, /dn-a/)
})

test('node_ids 与 line_id 冲突拒绝(不能跨线拼查询)', async () => {
  const r = await toolDaqQuery(AGENT, { node_ids: ['dn-a', 'dn-b'], line_id: 'ln-1', scope: 'all' })
  assert.equal(r.isError, true)
  assert.match(r.text, /不属于产线 ln-1/)
})

test('非法时间格式拒绝(必须 ISO 8601 或 epoch 毫秒)', async () => {
  const r = await toolDaqQuery(AGENT, { node_ids: ['dn-a'], from: 'not-a-time', to: TO, scope: 'all' })
  assert.equal(r.isError, true)
  assert.match(r.text, /ISO 8601/)
})

test('起止时间倒置拒绝', async () => {
  const r = await toolDaqQuery(AGENT, { node_ids: ['dn-a'], from: TO, to: FROM, scope: 'all' })
  assert.equal(r.isError, true)
  assert.match(r.text, /时间窗非法/)
})
