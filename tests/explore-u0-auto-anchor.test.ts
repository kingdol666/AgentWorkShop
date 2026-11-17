import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-u0-anchor-test-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { toolOptimizationExplore } = await import('../server/services/workshop/agents/industrial/optimization-tools')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')

const db = openWorkshopDb(join(process.env.AW_HOME, 'u0-anchor.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare('INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (\'\', \'u0 anchor test\', \'\', 1, ?, ?)').run(now, now)
setHybridChannelProfile({ channelId: '', profile: 'aml_optimization', capability: {}, controlPolicy: 'hitl_governed' })

for (const [scene, setup] of [
  ['readValue fallback', { value: null as number | null, readValue: 148 as number | null, readNowOk: false, readNowValue: null as number | null }],
  ['live readNow fallback', { value: null as number | null, readValue: null as number | null, readNowOk: true, readNowValue: 145 as number | null }],
  ['no anchor fail-closed', { value: null as number | null, readValue: null as number | null, readNowOk: false, readNowValue: null as number | null }],
]) {
  test(`optimization explore u0 auto-anchor: ${scene}`, async (t) => {
    const agentId = `ag-u0-${scene.replace(/\s+/g, '-')}`
    const node = new DcwNode({ id: `dw-u0-${agentId}`, templateRef: 'dcw-temp-sp', driver: 'mock', min: 60, max: 200, unit: 'C', decimals: 1 })
    node.value = setup.value
    node.readValue = setup.readValue
    const repo = getAgentNodeBindingRepo()
    repo.bind(agentId, node.id, 'dcw', 'manual')
    repo.bind(agentId, `dq-${agentId}`, 'daq', 'auto')
    const controller = getDcwController()
    t.mock.method(controller, 'byId', (id: string) => id === node.id ? node : undefined)
    const readNow = t.mock.method(controller, 'readNow', async () => ({
      ok: setup.readNowOk, value: setup.readNowValue, raw: setup.readNowValue,
      message: setup.readNowOk ? 'read ok' : 'driver unreachable', at: new Date().toISOString(),
    }))
    const write = t.mock.method(controller, 'write', async (_id: string, value: number) => {
      node.applyWriteResult(value, true, 'local mock ACK', new Date().toISOString())
      return { ok: true, raw: value, ack: 'readback-verified' as const, readback: value, message: 'local mock ACK' }
    })
    t.mock.method(getDaqController(), 'samples', async () => [{ value: 150 }])
    const approvals = getToolApprovals()
    const request = approvals.request.bind(approvals)
    t.mock.method(approvals, 'request', (id: string, nodeId: string, kind: string, detail: string) => {
      const result = request(id, nodeId, kind, detail, { timeoutMs: 20 })
      const pending = approvals.listPending(id).find(a => a.nodeId === nodeId)
      if (pending) approvals.decide(pending.id, true, '允许')
      return result
    })
    // Fast-forward only the process-settling delay; approval timers use their real 20 ms timeout.
    const setTimeout = globalThis.setTimeout
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      setTimeout(callback, delay === 10_000 ? 0 : delay, ...args))

    const result = await toolOptimizationExplore(agentId, { control_node_id: node.id, target_node_id: `dq-${agentId}`, direction: 'down', step: 2, settle_seconds: 10 })

    if (scene === 'no anchor fail-closed') {
      assert.equal(result.isError, true)
      assert.match(result.text, /锚定值|owner/)
      assert.equal(write.mock.callCount(), 0, 'unanchored exploration must never reach the write adapter')
      assert.equal(readNow.mock.callCount(), 1, 'fail-closed path must attempt exactly one live readback')
    }
    else {
      const expectedU0 = scene === 'readValue fallback' ? 148 : 145
      const row = db.prepare('SELECT * FROM optimization_explorations WHERE agent_id = ?').get(agentId) as { control_before: number, control_after: number } | undefined
      assert.ok(row, 'anchored exploration must leave a durable row')
      assert.equal(row.control_before, expectedU0, 'u0 must come from the readback anchor, not the 0-coercion degenerate corner')
      assert.equal(row.control_after, expectedU0 - 2, 'proposed value must be u0 ± step within tuning bounds')
      assert.equal(write.mock.callCount(), 1)
      assert.equal(result.isError, undefined)
      if (scene === 'live readNow fallback') assert.equal(readNow.mock.callCount(), 1, 'live fallback must read exactly once')
      else assert.equal(readNow.mock.callCount(), 0, 'existing readValue must be used without a live read')
    }
  })
}
