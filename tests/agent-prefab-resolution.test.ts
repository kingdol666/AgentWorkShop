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

test('a unique Skill alias resolves to the managed revision id, subject to pin, enabled state and harness support', () => {
  const key = 'skill:skill'
  const entry = { kind: 'skill', id: 'skill@rev', version: 'full-hash', enabled: true, reviewStatus: 'approved' } as const
  const base = input({
    prefab: prefab({ capabilities: [{ kind: 'skill', id: 'skill', version: 'full-hash', required: true }] }),
    registry: { [key]: entry },
  })
  const allowed = resolveAgentCapabilitySet(base)
  assert.deepEqual(allowed.skillIds, ['skill@rev'])
  assert.deepEqual(allowed.active.map(cap => cap.id), ['skill@rev'])
  assert.deepEqual(allowed.requiredMissing, [])
  assert.ok(allowed.toolIds.includes('activate_skill'))

  for (const overrides of [
    { registry: { 'skill:skill@rev': entry } },
    { registry: { [key]: { ...entry, version: 'other-hash' } } },
    { registry: { [key]: { ...entry, enabled: false } } },
    { harness: { ...base.harness, managedSkillIds: ['skill'] } },
  ]) {
    const denied = resolveAgentCapabilitySet({ ...base, ...overrides })
    assert.deepEqual(denied.skillIds, [])
    assert.deepEqual(denied.requiredMissing, [key])
    assert.equal(denied.toolIds.includes('activate_skill'), false)
  }
})

test('invalid slot values use canonical validation and expose no prompt or tools', () => {
  const cases = [
    [{ goal: '' }, /goal.*必填/, ['slot:goal']],
    [{ policy: 'changed' }, /policy.*不允许/, []],
    [{ goal: 'x'.repeat(101) }, /goal.*长度/, ['slot:goal']],
    [{ unknown: 'x' }, /未声明.*unknown/, []],
  ] as const
  for (const [slotValues, error, missing] of cases) {
    const resolution = resolveAgentCapabilitySet(input({ slotValues }))
    assert.equal(resolution.mode, 'prefab')
    assert.equal(resolution.slotErrors.length, 1)
    assert.match(resolution.slotErrors[0]!, error)
    assert.deepEqual(resolution.requiredMissing, missing)
    assert.deepEqual(resolution.toolIds, [])
    assert.deepEqual(resolution.skillIds, [])
    assert.deepEqual(resolution.prompt, { role: '', scenario: '', slots: [] })
  }
})

test('worker cannot get lead-only baseline or selected tools; plugin roles also narrow selection', () => {
  const base = input({
    prefab: prefab({ capabilities: [{ kind: 'tool', id: 'dispatch_task' }, { kind: 'plugin-tool', id: 'lead_plugin' }] }),
    harness: { managedToolIds: ['dispatch_task', 'lead_plugin'], managedSkillIds: [] },
    registry: {
      'tool:dispatch_task': { kind: 'tool', id: 'dispatch_task', enabled: true },
      'plugin-tool:lead_plugin': { kind: 'plugin-tool', id: 'lead_plugin', enabled: true, roles: ['lead'] },
    },
  })
  const worker = resolveAgentCapabilitySet(base)
  const lead = resolveAgentCapabilitySet({ ...base, member: { ...base.member, role: 'lead' } })
  for (const name of ['submit_task', 'read_channel_mail', 'dispatch_task', 'lead_plugin']) {
    assert.equal(worker.toolIds.includes(name), false, name)
    assert.equal(lead.toolIds.includes(name), true, name)
  }
  assert.ok(worker.toolIds.includes('poll_messages'))
  assert.deepEqual(worker.denied.map(cap => cap.id), ['dispatch_task', 'lead_plugin'])
})

test('pinned capability versions require an exact registry match, including baseline refs', () => {
  const id = 'send_message_to_agent'
  const key = `tool:${id}`
  for (const [pinned, actual, allowed] of [
    ['v1', 'v1', true], ['v1', 'V1', false], ['v1', undefined, false],
    ['', undefined, false], [undefined, 'v2', true],
  ] as const) {
    const result = resolveAgentCapabilitySet(input({
      prefab: prefab({ capabilities: [{ kind: 'tool', id, version: pinned, required: true }] }),
      registry: { [key]: { kind: 'tool', id, enabled: true, version: actual } },
      harness: { managedToolIds: [id], managedSkillIds: [] },
    }))
    assert.equal(result.toolIds.includes(id), allowed)
    assert.deepEqual(result.requiredMissing, allowed ? [] : [key])
    if (!allowed) assert.match(result.reasons[key]!, /版本不匹配/)
  }
})
