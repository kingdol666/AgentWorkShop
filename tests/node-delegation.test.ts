import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getAgentNodeBindingRepo } from '../server/services/workshop/agents/node-bindings.repo'
import { applyDelegation, planDelegation, revokeDelegation } from '../server/services/workshop/agents/node-delegation'

const tag = randomUUID().slice(0, 8)
const leadId = `nbtest-lead-${tag}`
const workerId = `nbtest-worker-${tag}`
const otherId = `nbtest-other-${tag}`

const members = [
  { id: leadId, role: 'lead' as const, enabled: 1 },
  { id: workerId, role: 'worker' as const, enabled: 1 },
  { id: otherId, role: 'worker' as const, enabled: 1 },
]

function cleanup(): void {
  const repo = getAgentNodeBindingRepo()
  repo.removeAgent(leadId)
  repo.removeAgent(workerId)
  repo.removeAgent(otherId)
}

test('delegation fails closed when node is outside the lead binding surface', () => {
  assert.throws(
    () => planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-ghost'], members }),
    (err: unknown) => (err as { code?: string }).code === 'DELEGATION_NOT_OWNED',
  )
})

test('delegation refused for non-lead caller and for lead-to-self', () => {
  assert.throws(
    () => planDelegation({ leaderAgentId: workerId, channelId: 'c1', targetAgentId: otherId, nodeIds: ['n1'], members }),
    (err: unknown) => (err as { code?: string }).code === 'DELEGATION_NOT_LEAD',
  )
  assert.throws(
    () => planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: leadId, nodeIds: ['n1'], members }),
    (err: unknown) => (err as { code?: string }).code === 'VALIDATION_ERROR',
  )
})

test('grant copies kind/tuning with provenance; mode defaults to manual (never inherits auto)', () => {
  cleanup()
  const repo = getAgentNodeBindingRepo()
  repo.bind(leadId, 'node-a', 'dcw', 'manual', { step: 2, note: '温度设定' })
  repo.bind(leadId, 'node-a', 'daq', 'auto')
  repo.bind(leadId, 'node-b', 'daq', 'auto')

  const plan = planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-a', 'node-b'], members })
  assert.equal(plan.grants.length, 3) // node-a 的 dcw+daq 两种 + node-b 的 daq
  const bindings = applyDelegation(plan, leadId)
  assert.equal(bindings.length, 3)
  assert.ok(bindings.every(b => b.grantedByAgentId === leadId && b.grantedAt))
  const dcwA = bindings.find(b => b.nodeId === 'node-a' && b.kind === 'dcw')
  assert.equal(dcwA?.mode, 'manual')
  assert.equal(dcwA?.tuning?.step, 2)
  // 2026-10-28 审查 B-P1-3:缺省不再继承 lead 的 auto —— 委派不得静默摘闸门
  const daqA = bindings.find(b => b.nodeId === 'node-a' && b.kind === 'daq')
  assert.equal(daqA?.mode, 'manual')
  assert.ok(bindings.every(b => b.mode === 'manual'), '缺省委派必须全部 manual')

  // 显式 mode=auto 必须带 confirm:true(摘除逐次人工审批)
  assert.throws(
    () => planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-a'], members, mode: 'auto' }),
    (err: unknown) => (err as { code?: string }).code === 'DELEGATION_MODE_CONFIRM_REQUIRED',
  )
  const plan2 = planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-a'], members, mode: 'auto', confirm: true })
  applyDelegation(plan2, leadId)
  const after = repo.find(workerId, 'node-a', 'dcw')
  assert.equal(after?.mode, 'auto')

  // 重复授予不建重复行
  const before = repo.byAgent(workerId).length
  applyDelegation(planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-a', 'node-b'], members }), leadId)
  assert.equal(repo.byAgent(workerId).length, before)
  cleanup()
})

test('revoke takes back granted nodes; refuses nodes neither granted nor held by lead', () => {
  cleanup()
  const repo = getAgentNodeBindingRepo()
  repo.bind(leadId, 'node-a', 'dcw', 'manual')
  applyDelegation(planDelegation({ leaderAgentId: leadId, channelId: 'c1', targetAgentId: workerId, nodeIds: ['node-a'], members }), leadId)
  // worker 自己(或他人)绑的、lead 既没授予也不持有的节点
  repo.bind(workerId, 'node-x', 'daq', 'auto')

  const results = revokeDelegation({ leaderAgentId: leadId, targetAgentId: workerId, nodeIds: ['node-a', 'node-x'], members })
  assert.equal(results.find(r => r.nodeId === 'node-a')?.revoked, true)
  assert.equal(results.find(r => r.nodeId === 'node-x')?.revoked, false)
  assert.equal(repo.find(workerId, 'node-a', 'dcw'), undefined)
  assert.ok(repo.find(workerId, 'node-x', 'daq'))
  cleanup()
})
