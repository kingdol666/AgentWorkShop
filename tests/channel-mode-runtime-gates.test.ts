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

test('generic mode filters production tools and rejects direct invocation while keeping collaboration and generic plugin tools', async () => {
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
    assert.equal(hostToolsForRole('worker', 'ch-1').some(t => t.name === 'daq_query'), true)
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), false, 'agent snapshot overrides channel mode')
    agentMode = 'production_line_integrated'
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), true)
    channelMode = 'generic'
    assert.equal(hostToolsForAgent('worker-1', 'worker', 'ch-1').some(t => t.name === 'daq_query'), true, 'integrated snapshot survives channel change')
  }
  finally {
    unregisterPluginTools('diag-bridge')
    unregisterPluginTools('generic-test')
    g.__workshopManager = oldManager
  }
})
