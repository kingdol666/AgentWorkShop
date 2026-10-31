import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PLATFORM_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-approval-optimization-test-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
const { requestManualApproval } = await import('../server/services/workshop/agents/industrial/manual-approval')
const { toolOptimizationExplore } = await import('../server/services/workshop/agents/industrial/optimization-tools')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'approval-optimization.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})
// No channel is supplied to the direct local call, so no running workshop service is needed.
const now = new Date().toISOString()
db.prepare('INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (\'\', \'Local approval test\', \'\', 1, ?, ?)').run(now, now)
setHybridChannelProfile({ channelId: '', profile: 'aml_optimization', capability: {}, controlPolicy: 'hitl_governed' })

for (const action of ['下发', '回退'] as const) {
  test(`manual approval: ${action} denial is an error with the original comment`, async (t) => {
    const approvals = getToolApprovals()
    t.mock.method(approvals, 'request', async () => ({ approved: false, comment: '先观察', id: 'ap-local-denied' }))
    const result = await requestManualApproval({ agentId: 'ag-denied', nodeId: 'dw-denied', detail: 'local test', action, verify: () => assert.fail('denied approval must not reauthorize') })
    assert.equal(result.ok, false)
    if (result.ok) assert.fail('approval must be denied')
    assert.equal(result.isError, true)
    assert.match(result.text, new RegExp(`拒绝了本次${action}。用户备注:先观察`))
  })
}

test('manual approval: an actual timeout is an error and retains expired history', async (t) => {
  const approvals = getToolApprovals()
  const request = approvals.request.bind(approvals)
  t.mock.method(approvals, 'request', (agentId, nodeId, kind, detail) => request(agentId, nodeId, kind, detail, { timeoutMs: 20 }))
  const result = await requestManualApproval({ agentId: 'ag-expired', nodeId: 'dw-expired', detail: 'local timeout', verify: () => assert.fail('expired approval must not reauthorize') })
  assert.equal(result.ok, false)
  if (result.ok) assert.fail('approval must expire')
  assert.equal(result.isError, true)
  assert.match(result.text, /未在时限内批准\(超时\)/)
  assert.equal(approvals.historyList().find(a => a.agentId === 'ag-expired')?.status, 'expired')
})

test('manual approval: duplicate pending and revoked authorization remain errors', async (t) => {
  const approvals = getToolApprovals()
  const pending = t.mock.method(approvals, 'hasPendingFor', () => true)
  const duplicate = await requestManualApproval({ agentId: 'ag-duplicate', nodeId: 'dw-duplicate', detail: 'local duplicate' })
  assert.equal(duplicate.ok, false)
  if (duplicate.ok) assert.fail('duplicate must be denied')
  assert.equal(duplicate.isError, true)
  pending.mock.restore()
  t.mock.method(approvals, 'request', async () => ({ approved: true, comment: '', id: 'ap-local-revoked' }))
  const revoked = await requestManualApproval({ agentId: 'ag-revoked', nodeId: 'dw-revoked', detail: 'local revoked', verify: () => false })
  assert.equal(revoked.ok, false)
  if (revoked.ok) assert.fail('revoked authorization must be denied')
  assert.equal(revoked.isError, true)
})

for (const decision of ['denied', 'expired', 'approved'] as const) {
  test(`optimization exploration: ${decision} preserves write status, response reads, and control values`, async (t) => {
    const agentId = `ag-explore-${decision}`
    const node = new DcwNode({ id: `dw-explore-${decision}`, templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, unit: 'C', decimals: 1 })
    node.value = 50
    const repo = getAgentNodeBindingRepo()
    repo.bind(agentId, node.id, 'dcw', 'manual')
    repo.bind(agentId, `dq-${decision}`, 'daq', 'auto')
    const controller = getDcwController()
    t.mock.method(controller, 'byId', id => id === node.id ? node : undefined)
    const write = t.mock.method(controller, 'write', async (_id, value) => {
      // The real shared domain object mutates exactly as the driver's success path does.
      node.applyWriteResult(value, true, 'local mock ACK', new Date().toISOString())
      return { ok: true, raw: value, ack: 'readback-verified' as const, readback: value, message: 'local mock ACK' }
    })
    const samples = t.mock.method(getDaqController(), 'samples', async () => [{ value: 100 + write.mock.callCount() * 2 }])
    const approvals = getToolApprovals()
    const request = approvals.request.bind(approvals)
    t.mock.method(approvals, 'request', (id, nodeId, kind, detail) => {
      const result = request(id, nodeId, kind, detail, { timeoutMs: 20 })
      if (decision !== 'expired') {
        const pending = approvals.listPending(id).find(a => a.nodeId === nodeId)!
        approvals.decide(pending.id, decision === 'approved', decision === 'approved' ? '允许测试' : '不同意测试')
      }
      return result
    })
    // Fast-forward only the process-settling delay; approval timers use their real 20 ms timeout.
    const setTimeout = globalThis.setTimeout
    let settleWaits = 0
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 10_000) settleWaits += 1
      return setTimeout(callback, delay === 10_000 ? 0 : delay, ...args)
    })

    const result = await toolOptimizationExplore(agentId, { control_node_id: node.id, target_node_id: `dq-${decision}`, direction: 'up', step: 1, settle_seconds: 10 })
    const row = db.prepare('SELECT * FROM optimization_explorations WHERE agent_id = ?').get(agentId)!
    assert.ok(row, 'the exploration must leave a durable row in the temporary database')
    const approved = decision === 'approved'
    assert.equal(result.isError, approved ? undefined : true)
    assert.equal(write.mock.callCount(), approved ? 1 : 0, 'unapproved commands must never reach the write adapter')
    assert.equal(settleWaits, approved ? 1 : 0, 'unapproved commands must not wait for a process response')
    assert.equal(samples.mock.callCount(), approved ? 2 : 1, 'unapproved commands may read before, never after')
    assert.equal(node.value, approved ? 51 : 50)
    assert.equal(row.write_status, approved ? 'ok' : 'rejected')
    assert.equal(row.control_before, 50, 'capture the control value before the shared object is mutated')
    assert.equal(row.control_after, approved ? 51 : 50)
    assert.equal(row.target_before, 100)
    assert.equal(row.target_after, approved ? 102 : null)
    assert.match(result.text, approved ? /探索步完成/ : /探索步被拒绝/)
    assert.equal(approvals.historyList().find(a => a.agentId === agentId)?.status, decision)
  })
}
