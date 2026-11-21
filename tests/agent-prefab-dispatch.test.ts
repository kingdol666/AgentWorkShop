import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { HostToolBridgeContext } from '../server/services/workshop/agents/host-tool-bridge/types'

const home = mkdtempSync(join(tmpdir(), 'aw-prefab-dispatch-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home
delete process.env.DAQ_TSDB_URL

const { getTsdb } = await import('../server/services/workshop/daq/storage')
after(async () => {
  await getTsdb().close?.()
  rmSync(home, { recursive: true, force: true })
})

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { initChannelPluginsDb } = await import('../server/services/workshop/db/channel-plugins.repo')
const { initToolRegistryDb } = await import('../server/services/workshop/db/tool-registry.repo')
const { createAgentPrefabService } = await import('../server/services/workshop/agent-prefabs/service')
const { dispatchHostTool } = await import('../server/services/workshop/agents/host-tool-bridge/dispatch')
const { hostToolsForAgent } = await import('../server/services/workshop/agents/host-tool-bridge/per-agent')
const { registerPluginTool, unregisterPluginTools } = await import('../server/services/workshop/agents/plugin-tools')
const { initProjectService } = await import('../server/services/workshop/projects/service')

test('ordinary and Project tools reject invalid prefab bindings before handlers execute', async (t) => {
  const db = openWorkshopDb(':memory:')
  const globals = globalThis as unknown as { __workshopManager?: unknown }
  const previous = globals.__workshopManager
  t.after(() => {
    globals.__workshopManager = previous
    unregisterPluginTools('prefab-dispatch-test')
    db.close()
  })
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  globals.__workshopManager = { deps: { db, repos: { channels, channelAgents: agents } } }
  initToolRegistryDb(db)
  initChannelPluginsDb(db)
  const channel = channels.create({ name: 'dispatch' })
  const member = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead' })
  const ctx: HostToolBridgeContext = {
    identity: { agentId: member.id, channelId: channel.id, name: member.name, role: 'lead' },
    state: { currentTaskId: null, sessionId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    getWorkspace: () => null,
  }
  const ordinaryTool = 'prefab_dispatch_probe'
  const projectTool = 'project_propose_plan'
  let ordinaryCalls = 0
  registerPluginTool('prefab-dispatch-test', {
    name: ordinaryTool, description: 'local probe', parameters: {}, riskClass: 'read',
    handler: () => {
      ordinaryCalls++
      return { text: 'ok' }
    },
  })
  const projects = initProjectService({} as Parameters<typeof initProjectService>[0], db)
  // The existing Project gate sees an authorized project lead. Spy on the mutation
  // boundary so a denied call cannot create a proposal or approval.
  t.mock.method(projects, 'agentProjectContext', () => ({ isLeader: true }))
  const projectHandler = t.mock.method(projects, 'agentRequestPlan', () => ({ approval: { id: 'approval' }, version: 1, proposalId: 'proposal' }))
  const invoke = (toolName: string) => dispatchHostTool(ctx, { toolName, arguments: { plan: {} } })

  for (const malformed of ['{invalid', ' \t ', 'null', '{}']) {
    agents.update(member.id, { prefabBindingJson: malformed })
    const project = await invoke(projectTool)
    assert.equal(project.isError, true)
    assert.match(project.text, /FORBIDDEN:.*AgentPrefab/)
    assert.deepEqual(hostToolsForAgent(member.id, 'lead', channel.id), [])
  }
  assert.equal(projectHandler.mock.callCount(), 0)

  t.mock.method(projects, 'agentProjectContext', () => null)
  for (const malformed of ['{invalid', ' \t ', 'null', '{}']) {
    agents.update(member.id, { prefabBindingJson: malformed })
    const ordinary = await invoke(ordinaryTool)
    assert.equal(ordinary.isError, true)
    assert.match(ordinary.text, /FORBIDDEN:.*AgentPrefab/)
  }
  assert.equal(ordinaryCalls, 0)
  agents.update(member.id, { prefabBindingJson: '' })
  assert.equal((await invoke(ordinaryTool)).text, 'ok')
  assert.equal(ordinaryCalls, 1)

  // A structurally valid binding still constrains Project tools; no binding keeps
  // the original Project path, and an explicitly selected tool can use that path.
  t.mock.method(projects, 'agentProjectContext', () => ({ isLeader: true }))
  const prefabs = createAgentPrefabService(db)
  const owner = { id: 'u1' }
  for (const allowed of [false, true]) {
    const prefab = prefabs.create(owner, { name: 'project', capabilities: allowed ? [{ kind: 'tool', id: projectTool }] : [] })
    const revision = prefabs.publish(owner, prefab.id, 0)
    const binding = prefabs.buildBinding(owner, prefab.id, revision.revision, {})
    agents.update(member.id, { prefabBindingJson: JSON.stringify(binding) })
    const result = await invoke(projectTool)
    assert.equal(result.isError === true, !allowed)
    assert.equal(projectHandler.mock.callCount(), allowed ? 1 : 0)
  }
  agents.update(member.id, { prefabBindingJson: '' })
  assert.equal((await invoke(projectTool)).isError, undefined)
  assert.equal(projectHandler.mock.callCount(), 2)

  t.mock.method(projects, 'agentProjectContext', () => null)
  const prefab = prefabs.create(owner, { name: 'collaboration' })
  const revision = prefabs.publish(owner, prefab.id, 0)
  const binding = prefabs.buildBinding(owner, prefab.id, revision.revision, {})
  agents.update(member.id, { prefabBindingJson: JSON.stringify(binding) })
  for (const [persistedRole, runtimeRole] of [['worker', 'lead'], ['lead', 'worker']] as const) {
    agents.update(member.id, { role: persistedRole })
    ctx.identity.role = runtimeRole
    const result = await invoke('submit_task')
    assert.equal(result.isError, true)
    assert.match(result.text, /FORBIDDEN:.*AgentPrefab/)
  }
})

test('native dispatch requires a live member in its claimed Channel before ordinary or Project tools run', async (t) => {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const channel = channels.create({ name: 'dispatch' })
  const other = channels.create({ name: 'other' })
  const member = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead' })
  const globals = globalThis as unknown as { __workshopManager?: unknown }
  const previous = globals.__workshopManager
  const manager = { deps: { db, repos: { channels, channelAgents: agents } } }
  globals.__workshopManager = manager
  t.after(() => {
    globals.__workshopManager = previous
    unregisterPluginTools('dispatch-membership-test')
    db.close()
  })
  initToolRegistryDb(db)
  initChannelPluginsDb(db)
  const ctx: HostToolBridgeContext = {
    identity: { agentId: member.id, channelId: channel.id, name: member.name, role: 'lead' },
    state: { currentTaskId: null, sessionId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    getWorkspace: () => null,
  }
  const ordinaryTool = 'dispatch_membership_probe'
  const projectTool = 'project_propose_plan'
  const ordinaryHandler = t.mock.fn(() => ({ text: 'ok' }))
  registerPluginTool('dispatch-membership-test', {
    name: ordinaryTool, description: 'local probe', parameters: {}, riskClass: 'read', handler: ordinaryHandler,
  })
  const projects = initProjectService({} as Parameters<typeof initProjectService>[0], db)
  let projectLead = false
  t.mock.method(projects, 'agentProjectContext', () => projectLead ? { isLeader: true } : null)
  const projectHandler = t.mock.method(projects, 'agentRequestPlan', () => ({ approval: { id: 'approval' }, version: 1, proposalId: 'proposal' }))
  const invoke = (toolName: string) => {
    projectLead = toolName === projectTool
    return dispatchHostTool(ctx, { toolName, arguments: { plan: {} } })
  }
  const assertDenied = async (reason: string) => {
    for (const tool of [ordinaryTool, projectTool]) {
      const result = await invoke(tool)
      assert.equal(result.isError, true, `${reason}: ${tool}`)
      assert.match(result.text, /^FORBIDDEN:.*Channel/, `${reason}: ${tool}`)
    }
    assert.equal(ordinaryHandler.mock.callCount(), 1, reason)
    assert.equal(projectHandler.mock.callCount(), 1, reason)
  }

  // A persisted member with no prefab binding remains legacy.
  assert.equal(agents.findById(member.id)?.prefabBindingJson, '')
  assert.equal((await invoke(ordinaryTool)).text, 'ok')
  assert.equal((await invoke(projectTool)).isError, undefined)
  assert.equal(projectHandler.mock.callCount(), 1)

  // Reuse the same native context to simulate a harness with a cached tool list.
  agents.update(member.id, { enabled: 0 })
  await assertDenied('disabled member')
  agents.update(member.id, { enabled: 1 })
  channels.update(channel.id, { enabled: 0 })
  await assertDenied('disabled Channel')
  channels.update(channel.id, { enabled: 1 })

  ctx.identity.channelId = other.id
  await assertDenied('member does not belong to the claimed Channel')
  ctx.identity.channelId = channel.id

  globals.__workshopManager = undefined
  await assertDenied('no trusted manager DB')
  globals.__workshopManager = manager
  const lookup = t.mock.method(agents, 'findByChannelAgent', () => {
    throw new Error('DB unavailable')
  })
  await assertDenied('member lookup failed')
  lookup.mock.restore()

  // Keep the member row to exercise the Channel check independently of FK cascade.
  db.exec('PRAGMA foreign_keys = OFF')
  channels.remove(channel.id)
  assert.ok(agents.findById(member.id))
  await assertDenied('missing Channel')
  agents.remove(channel.id, member.id)
  await assertDenied('missing member')
})
