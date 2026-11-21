/**
 * AgentPrefab 有效能力解析：交集、deny/missing/unsupported、slot 校验、legacy 兼容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentCapabilitySet } from '../server/services/workshop/agent-prefabs/resolution'
import type { AgentCapabilityInput, AgentPrefabDraft } from '../server/services/workshop/agent-prefabs/types'

function prefab(overrides: Partial<AgentPrefabDraft> = {}): AgentPrefabDraft {
  return {
    name: 'expert',
    description: '',
    visibility: 'private',
    prompt: {
      role: 'You are an expert.',
      scenario: 'Line context.',
      slots: [
        { key: 'goal', label: 'Goal', defaultValue: 'stable', required: true, allowMemberOverride: true, maxLength: 100 },
        { key: 'policy', label: 'Policy', defaultValue: 'fixed', allowMemberOverride: false, maxLength: 100 },
      ],
    },
    profile: {},
    capabilities: [{ kind: 'tool', id: 'daq_query', required: true }],
    ...overrides,
  }
}

function input(overrides: Partial<AgentCapabilityInput> = {}): AgentCapabilityInput {
  return {
    binding: { prefabId: 'p1', revision: 1, slotValues: { goal: 'grow' }, contentHash: 'hash-1' },
    member: { id: 'a1', channelId: 'c1', role: 'worker', harness: 'omp' },
    channelPolicy: { mode: 'all', enabledToolIds: null },
    projectScope: null,
    harness: { managedToolIds: ['daq_query', 'activate_skill'], managedSkillIds: ['skill@rev'] },
    registry: { 'tool:daq_query': { kind: 'tool', id: 'daq_query', enabled: true } },
    prefab: prefab(),
    slotValues: { goal: 'grow' },
    ...overrides,
  }
}

test('no binding keeps legacy behavior', () => {
  const resolution = resolveAgentCapabilitySet(input({ binding: null, prefab: null }))
  assert.equal(resolution.mode, 'legacy')
  assert.equal(resolution.toolIds.length, 0)
  assert.equal(resolution.requiredMissing.length, 0)
})

test('missing revision snapshot fails closed', () => {
  const resolution = resolveAgentCapabilitySet(input({ prefab: null }))
  assert.equal(resolution.mode, 'prefab')
  assert.deepEqual(resolution.requiredMissing, ['__prefab__'])
  assert.equal(resolution.toolIds.length, 0)
})

test('active capability intersects registry/channel/project/harness and keeps baseline', () => {
  const resolution = resolveAgentCapabilitySet(input())
  assert.equal(resolution.mode, 'prefab')
  assert.ok(resolution.active.some(x => x.id === 'daq_query'))
  assert.ok(resolution.toolIds.includes('daq_query'))
  assert.ok(resolution.toolIds.includes('send_message_to_agent'))
  assert.equal(resolution.prompt.role, 'You are an expert.')
  assert.deepEqual(resolution.prompt.slots.find(s => s.key === 'goal')?.text, 'grow')
  assert.deepEqual(resolution.prompt.slots.find(s => s.key === 'policy')?.text, 'fixed')
})

test('disabled/denied/unsupported capabilities are classified and required missing blocks', () => {
  const disabled = resolveAgentCapabilitySet(input({
    registry: { 'tool:daq_query': { kind: 'tool', id: 'daq_query', enabled: false } },
  }))
  assert.equal(disabled.disabled[0]?.id, 'daq_query')
  assert.deepEqual(disabled.requiredMissing, ['tool:daq_query'])

  const denied = resolveAgentCapabilitySet(input({
    channelPolicy: { mode: 'selected', enabledToolIds: ['send_message_to_agent'] },
  }))
  assert.equal(denied.denied[0]?.id, 'daq_query')
  assert.equal(denied.toolIds.includes('daq_query'), false)
  assert.equal(denied.toolIds.includes('send_message_to_agent'), true)

  const projectDenied = resolveAgentCapabilitySet(input({ projectScope: { allowedToolIds: [] } }))
  assert.equal(projectDenied.denied[0]?.id, 'daq_query')

  const unsupported = resolveAgentCapabilitySet(input({
    harness: { managedToolIds: null, managedSkillIds: null },
  }))
  assert.equal(unsupported.unsupported[0]?.id, 'daq_query')
})

test('MCP tools require approved review; skills require harness support and expose activate_skill', () => {
  const mcpPrefab = prefab({
    capabilities: [
      { kind: 'mcp-tool', id: 'mcp_mes_search', required: true },
      { kind: 'skill', id: 'skill@rev', required: true },
    ],
  })
  const base = input({
    prefab: mcpPrefab,
    harness: { managedToolIds: ['daq_query', 'activate_skill', 'mcp_mes_search'], managedSkillIds: ['skill@rev'] },
    registry: {
      'mcp-tool:mcp_mes_search': { kind: 'mcp-tool', id: 'mcp_mes_search', enabled: true, reviewStatus: 'pending' },
      'skill:skill@rev': { kind: 'skill', id: 'skill@rev', enabled: true, reviewStatus: 'approved' },
    },
  })
  const pending = resolveAgentCapabilitySet(base)
  assert.ok(pending.disabled.some(x => x.id === 'mcp_mes_search'))
  assert.ok(pending.skillIds.includes('skill@rev'))
  assert.ok(pending.toolIds.includes('activate_skill'))

  const approved = resolveAgentCapabilitySet({
    ...base,
    registry: { ...base.registry, 'mcp-tool:mcp_mes_search': { kind: 'mcp-tool', id: 'mcp_mes_search', enabled: true, reviewStatus: 'approved' } },
  })
  assert.ok(approved.toolIds.includes('mcp_mes_search'))
})

test('slot validation: required, override policy and max length', () => {
  const resolution = resolveAgentCapabilitySet(input({
    slotValues: { goal: '', policy: 'changed' },
  }))
  assert.ok(resolution.slotErrors.some(e => e.startsWith('goal:')))
  assert.ok(resolution.slotErrors.some(e => e.startsWith('policy:')))
  assert.ok(resolution.requiredMissing.includes('slot:goal'))
  assert.equal(resolution.prompt.slots.find(s => s.key === 'policy')?.text, 'fixed')

  const tooLong = resolveAgentCapabilitySet(input({ slotValues: { goal: 'x'.repeat(101) } }))
  assert.ok(tooLong.slotErrors.some(e => e.startsWith('goal:')))
})
