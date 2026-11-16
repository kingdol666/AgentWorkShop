import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mode-tools-'))

const { canonicalHash, canonicalJson } = await import('../shared/context/hash')
const { hostToolsForRole } = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
const { hostToolsForAgent } = await import('../server/services/workshop/agents/host-tool-bridge/per-agent')
const { dispatchHostTool } = await import('../server/services/workshop/agents/host-tool-bridge/dispatch')
const { registerPluginTool, unregisterPluginTools } = await import('../server/services/workshop/agents/plugin-tools')
const { ManagerHostTools } = await import('../server/services/workshop/runtime/manager/host-tools')
const { OBSERVE_BLOCKED_TOOL_NAMES } = await import('../server/services/workshop/agents/tool-classes')

const g = globalThis as typeof globalThis & { __workshopManager?: unknown }
const oldManager = g.__workshopManager
let agentMode = 'generic'
let channelMode = 'generic'
g.__workshopManager = {
  channelModeOf: () => channelMode,
  channelModeForAgent: () => agentMode,
}

test('channel line binding uses an active session snapshot and never falls back for generic or stale clones', async () => {
  const { ManagerAdminAgents } = await import('../server/services/workshop/runtime/manager/admin-agents')
  const { openWorkshopDb } = await import('../server/services/workshop/db/database')
  const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
  const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
  const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const sessions = createChannelSessionRepo(db)
    const channel = channels.create({ name: 'mode', channelMode: 'production_line_integrated' })
    channels.setLine(channel.id, 'mutable-line')
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'base', harness: 'mock', role: 'worker' })
    const clone = agents.create({ channelId: channel.id, templateId: null, name: 'base·session·1', harness: 'mock', role: 'worker' })
    const snapshot = { schemaVersion: 1, channelId: channel.id, bindingRevision: 1, productId: 'product-1', lineId: 'snapshot-line', recipes: [], agentBindings: [], executionProfile: { mode: 'auto' } }
    const session = sessions.create({ channelId: channel.id, memberMap: { [base.id]: clone.id }, channelMode: 'production_line_integrated', productId: 'product-1', lineId: 'snapshot-line', bindingSnapshotJson: canonicalJson(snapshot), bindingSnapshotHash: canonicalHash(snapshot), bindingSnapshotRevision: 1 })
    const manager = Object.create(ManagerAdminAgents.prototype) as { deps: unknown, channelLineBindingOf: (id: string) => string | null }
    manager.deps = { db, repos: { channels, channelAgents: agents } }
    assert.equal(manager.channelLineBindingOf(base.id), 'mutable-line')
    assert.equal(manager.channelLineBindingOf(clone.id), 'snapshot-line')
    channels.update(channel.id, { channelMode: 'generic' })
    assert.equal(manager.channelLineBindingOf(base.id), null)
    assert.equal(manager.channelLineBindingOf(clone.id), 'snapshot-line')
    sessions.close(session.id)
    channels.update(channel.id, { channelMode: 'production_line_integrated' })
    assert.equal(manager.channelLineBindingOf(clone.id), null)
  }
  finally { db.close() }
})

const ctx = { identity: { agentId: 'worker-1', channelId: 'ch-1', role: 'worker' as const, name: 'worker' }, state: { currentTaskId: null, sessionId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null }, getWorkspace: () => null }

test('ManagerHostTools plugin shortcut applies the same generic-mode gate as native dispatch', async () => {
  let serialCalled = false
  let genericCalled = false
  registerPluginTool('serial-bridge', {
    name: 'serial_ports',
    description: 'enumerate serial ports',
    riskClass: 'read',
    handler: async () => {
      serialCalled = true
      return { text: 'ports' }
    },
  })
  registerPluginTool('generic-test', {
    name: 'rsi_manager_generic_test',
    description: 'generic plugin tool',
    riskClass: 'read',
    handler: async () => {
      genericCalled = true
      return { text: 'generic-ok' }
    },
  })
  const manager = Object.create(ManagerHostTools.prototype) as Record<string, unknown>
  const row = { id: 'manager-worker', enabled: 1, channelId: 'manager-channel', role: 'worker', name: 'worker', token: 'token' }
  manager.lastToolInvokeAt = new Map()
  manager.deps = {
    repos: { channelAgents: { findById: () => row, isTokenValid: () => true } },
  }
  manager.activeScopeOf = () => null
  manager.ensureAgentRuntime = () => ({
    dispatchHostTool: async () => null,
    workspace: {
      sendMessageToAgent: async () => ({ messageId: 'm1' }),
      recallMemory: async () => [],
      saveMemory: async () => ({ scope: 'private', dedupKey: 'k' }),
    },
  })
  manager.getTaskEngine = () => ({})
  manager.channelSessionScopeOfAgent = () => null
  manager.auditCollabInvocation = () => {}
  g.__workshopManager = {
    channelModeOf: () => 'generic',
    channelModeForAgent: () => 'generic',
    invocationScopeOf: () => null,
  }
  try {
    const invoke = ManagerHostTools.prototype.invokeHostTool as (input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }) => Promise<{ text: string, isError?: boolean }>
    const serial = await invoke.call(manager, { agentId: row.id, token: 'token', tool: 'serial_ports', args: {} })
    assert.equal(serial.isError, true)
    assert.match(serial.text, /通用频道/)
    assert.equal(serialCalled, false, 'generic mode must deny before plugin handler side effects')

    const generic = await invoke.call(manager, { agentId: row.id, token: 'token', tool: 'rsi_manager_generic_test', args: {} })
    assert.equal(generic.text, 'generic-ok')
    assert.equal(genericCalled, true)
  }
  finally {
    unregisterPluginTools('serial-bridge')
    unregisterPluginTools('generic-test')
    g.__workshopManager = oldManager
  }
})

test('external agent tokens cannot dispatch hazardous tools without turn provenance', async () => {
  const manager = Object.create(ManagerHostTools.prototype) as Record<string, unknown>
  const row = { id: 'provenance-lead', enabled: 1, channelId: 'provenance-channel', role: 'lead', name: 'lead' }
  let validToken = true
  let runtimeCalls = 0
  let dispatchCalls = 0
  let fallbackCalls = 0
  manager.lastToolInvokeAt = new Map()
  manager.deps = { repos: { channelAgents: { findById: () => row, isTokenValid: () => validToken } } }
  manager.activeScopeOf = () => null
  manager.ensureAgentRuntime = () => {
    runtimeCalls++
    return { dispatchHostTool: async () => {
      dispatchCalls++
      return { text: 'native-ok' }
    } }
  }
  manager.invokeAgentWorkspaceTool = async () => {
    fallbackCalls++
    return { text: 'fallback-ok' }
  }
  manager.auditCollabInvocation = () => {}
  const invoke = ManagerHostTools.prototype.invokeHostTool as (input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }) => Promise<{ text: string, isError?: boolean }>
  const authorizationTools = ['team_grant_nodes', 'team_revoke_nodes', 'dispatch_task', 'create_team_agent', 'update_team_agent', 'remove_team_agent']

  registerPluginTool('collision-test', { name: 'line_start', description: 'shadow', parameters: {}, riskClass: 'read', handler: async () => {
    throw new Error('shadow handler called')
  } })
  registerPluginTool('collision-test', { name: 'search_memory', description: 'shadow', parameters: {}, riskClass: 'write', handler: async () => {
    throw new Error('shadow handler called')
  } })
  try {
    for (const tool of [...OBSERVE_BLOCKED_TOOL_NAMES, ...authorizationTools]) {
      const result = await invoke.call(manager, { agentId: row.id, token: 'token', tool })
      assert.equal(result.isError, true, tool)
      assert.match(result.text, /turn provenance/, tool)
    }
    for (const args of [
      { grant_node_ids: ['dcw-1'], grant_mode: 'auto', grant_confirm: true },
      { grantNodeIds: ['dcw-1'], grant_mode: 'auto', grant_confirm: true },
      { grant_node_ids: null, grantNodeIds: ['dcw-1'] },
    ]) {
      const result = await invoke.call(manager, { agentId: row.id, token: 'token', tool: 'dispatch_task', args })
      assert.equal(result.isError, true)
      assert.match(result.text, /turn provenance/)
    }
    assert.equal(runtimeCalls, 0)
    assert.equal(dispatchCalls, 0)
    assert.equal(fallbackCalls, 0)
    assert.equal((manager.lastToolInvokeAt as Map<string, number>).size, 0)

    validToken = false
    await assert.rejects(invoke.call(manager, { agentId: row.id, token: 'invalid', tool: 'line_start' }), /agent token/)
    validToken = true
    assert.equal((await invoke.call(manager, { agentId: row.id, token: 'token', tool: 'search_memory' })).text, 'native-ok')
    for (const tool of [...OBSERVE_BLOCKED_TOOL_NAMES, ...authorizationTools]) {
      assert.equal((await invoke.call(manager, { agentId: row.id, tool })).text, 'native-ok', tool)
    }
    assert.equal((await invoke.call(manager, { agentId: row.id, tool: 'dispatch_task', args: { grant_node_ids: ['dcw-1'], grant_mode: 'auto', grant_confirm: true } })).text, 'native-ok')
  }
  finally {
    unregisterPluginTools('collision-test')
  }
})

test('external agent token plugin calls require an explicit read risk class', async () => {
  const manager = Object.create(ManagerHostTools.prototype) as Record<string, unknown>
  const row = { id: 'risk-worker', enabled: 1, channelId: 'risk-channel', role: 'worker', name: 'worker' }
  const called: string[] = []
  for (const risk of ['read', 'write', 'admin', 'undeclared', 'invalid'] as const) {
    registerPluginTool('risk-test', {
      name: `risk_test_${risk}`,
      description: 'risk test',
      parameters: {},
      ...(risk === 'undeclared' ? {} : { riskClass: risk as 'read' | 'write' | 'admin' }),
      handler: async () => {
        called.push(risk)
        return { text: `${risk}-ok` }
      },
    })
  }
  manager.lastToolInvokeAt = new Map()
  manager.deps = { repos: { channelAgents: { findById: () => row, isTokenValid: () => true } } }
  manager.activeScopeOf = () => null
  manager.ensureAgentRuntime = () => ({ workspace: {}, dispatchHostTool: async () => null })
  manager.channelSessionScopeOfAgent = () => null
  manager.auditCollabInvocation = () => {}
  g.__workshopManager = { channelModeOf: () => 'generic', channelModeForAgent: () => 'generic', invocationScopeOf: () => null }
  const invoke = ManagerHostTools.prototype.invokeHostTool as (input: { agentId: string, token?: string, tool: string }) => Promise<{ text: string, isError?: boolean }>
  try {
    for (const risk of ['write', 'admin', 'undeclared', 'invalid']) {
      const result = await invoke.call(manager, { agentId: row.id, token: 'token', tool: `risk_test_${risk}` })
      assert.equal(result.isError, true, risk)
      assert.match(result.text, /turn provenance/, risk)
    }
    assert.deepEqual(called, [])
    assert.equal((await invoke.call(manager, { agentId: row.id, token: 'token', tool: 'risk_test_read' })).text, 'read-ok')
    for (const risk of ['write', 'admin', 'undeclared', 'invalid']) {
      assert.equal((await invoke.call(manager, { agentId: row.id, tool: `risk_test_${risk}` })).text, `${risk}-ok`)
    }
    assert.deepEqual(called, ['read', 'write', 'admin', 'undeclared', 'invalid'])
  }
  finally {
    unregisterPluginTools('risk-test')
    g.__workshopManager = oldManager
  }
})

test('generic mode filters production tools and rejects direct invocation while keeping collaboration and generic plugin tools', async () => {
  const initialAgentMode = agentMode
  const initialChannelMode = channelMode
  let called = false
  registerPluginTool('diag-bridge', {
    name: 'diag_mode_test', description: 'diagnostic', handler: async () => {
      called = true
      return { text: 'executed' }
    },
  })
  registerPluginTool('generic-test', { name: 'rsi_generic_test', description: 'generic', handler: async () => ({ text: 'ok' }) })
  try {
    const names = new Set(hostToolsForAgent('worker-1', 'worker', 'ch-1').map(t => t.name))
    for (const name of ['daq_query', 'line_context', 'aml_node_catalog', 'mes_fetch', 'exp_collect', 'diag_mode_test']) assert.equal(names.has(name), false, name)
    for (const name of ['save_memory', 'search_memory', 'send_message_to_agent', 'rsi_generic_test']) assert.equal(names.has(name), true, name)
    for (const name of ['daq_query', 'line_context', 'aml_node_catalog', 'mes_fetch', 'exp_collect', 'diag_mode_test']) {
      const result = await dispatchHostTool(ctx, { toolName: name, arguments: {} })
      assert.equal(result.isError, true, name)
      assert.match(result.text, /通用频道/)
    }
    assert.equal(called, false)
    assert.equal((await dispatchHostTool(ctx, { toolName: 'rsi_generic_test', arguments: {} })).text, 'ok')

    channelMode = 'production_line_integrated'
    assert.equal(hostToolsForRole('worker', 'ch-1').some(t => t.name === 'daq_query'), false, 'without AML runtime, profile lookup fails closed to legacy')
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), false, 'agent snapshot overrides channel mode even when profile is unavailable')
    agentMode = 'production_line_integrated'
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), false, 'unavailable AML profile remains fail-closed')
    channelMode = 'generic'
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), false, 'generic snapshot stays filtered after channel change')
  }
  finally {
    unregisterPluginTools('diag-bridge')
    unregisterPluginTools('generic-test')
    agentMode = initialAgentMode
    channelMode = initialChannelMode
    g.__workshopManager = oldManager
  }
})
