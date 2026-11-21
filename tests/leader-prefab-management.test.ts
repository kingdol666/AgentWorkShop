import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { AgentInfo, AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { SchedulerDecision } from '../server/services/workshop/runtime/scheduler-loop/types'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_PROMPTS_DIR = resolve('.AgentWorkShop/prompts')

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { initToolRegistryDb } = await import('../server/services/workshop/db/tool-registry.repo')
const { createAgentPrefabService } = await import('../server/services/workshop/agent-prefabs/service')
const { AgentChannelManager } = await import('../server/services/workshop/runtime/manager/facade')
const { handleCreateTeamAgent, handleListTeamAgents, handleUpdateTeamAgent } = await import('../server/services/workshop/agents/host-tool-bridge/tools/team')
const { SchedulerLoopExecute } = await import('../server/services/workshop/runtime/scheduler-loop/execute')
const { loadHostToolDefs } = await import('../server/services/workshop/prompts/loader')

function fixture(t: TestContext, ownerUserId: string | null = 'channel-owner') {
  const home = mkdtempSync(join(tmpdir(), 'aw-lead-prefab-'))
  const previousHome = process.env.AW_HOME
  process.env.AW_HOME = home
  const db = openWorkshopDb(':memory:')
  t.after(() => {
    db.close()
    if (previousHome === undefined) delete process.env.AW_HOME
    else process.env.AW_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channelAgents = createChannelAgentRepo(db)
  const agents = createAgentRepo(db)
  const channel = channels.create({ name: 'Team', ownerUserId })
  const memberInput = { channelId: channel.id, templateId: null, name: 'Member', harness: 'mock', role: 'worker' as const }
  const lead = channelAgents.create({ ...memberInput, role: 'lead' })
  channels.update(channel.id, { leadAgentId: lead.id })
  const notices: string[] = []
  const reloads: string[] = []
  const manager = Object.assign(Object.create(AgentChannelManager.prototype) as InstanceType<typeof AgentChannelManager>, {
    deps: { db, repos: { channels, channelAgents, agents } },
    activeInvocationScopes: new Map(),
    ensureAgentRuntime: () => undefined,
    unloadAgent: async (_: string, id: string) => { reloads.push(id) },
    notifyMember: (_: string, event: { op: string }) => { notices.push(event.op) },
  })
  const agentInfo: AgentInfo = { id: lead.id, channelId: channel.id, name: lead.name, harness: 'mock', role: 'lead', config: {} }
  const ws = (manager as unknown as { buildWorkspace: (agent: AgentInfo, memory: unknown) => AgentWorkspace }).buildWorkspace(agentInfo, {})
  const prefabs = createAgentPrefabService(db)
  function publish(id = 'channel-owner', visibility = 'private', capabilities: unknown[] = []) {
    const author = { id }
    const prefab = prefabs.create(author, {
      name: 'Expert', visibility, capabilities,
      prompt: { slots: [{ key: 'goal', label: 'Goal', required: true }] },
    })
    return prefabs.publish(author, prefab.id, 0)
  }
  return { db, channels, channel, channelAgents, agents, memberInput, lead, manager, ws, prefabs, publish, notices, reloads }
}

test('lead tools atomically bind a published revision, display safe metadata and switch or detach', async (t) => {
  const f = fixture(t)
  const first = f.publish()
  const second = f.prefabs.publish({ id: 'channel-owner' }, first.prefabId, 1)
  const beforeDraft = f.prefabs.get({ id: 'channel-owner' }, first.prefabId)
  const protectedMember = f.channelAgents.create(f.memberInput)
  const create = await handleCreateTeamAgent({
    name: 'My worker', harness: 'mock',
    prefab: { prefabId: first.prefabId, revision: 1, slotValues: { goal: 'sensitive-slot-value' } },
  }, f.ws)
  const worker = f.channelAgents.listByChannel(f.channel.id).find(row => row.name === 'My worker')!
  assert.equal(worker.createdById, f.lead.id)
  assert.match(create.text, /revision=1/)
  assert.equal(JSON.parse(worker.prefabBindingJson!).contentHash, first.contentHash)
  const roster = await handleListTeamAgents(f.ws)
  assert.ok(roster.text.split('\n').some(line => line.includes(worker.id) && line.includes(first.contentHash) && line.includes('manageable=true, protected=false')))
  assert.ok(roster.text.split('\n').some(line => line.includes(protectedMember.id) && line.includes('manageable=false, protected=true')))
  assert.ok(!roster.text.includes('sensitive-slot-value') && !roster.text.includes(worker.token))

  await handleUpdateTeamAgent({ agent_id: worker.id, name: 'Renamed' }, f.ws)
  assert.equal(f.channelAgents.findById(worker.id)?.prefabBindingJson, worker.prefabBindingJson)
  const update = await handleUpdateTeamAgent({
    agent_id: worker.id,
    prefab: { prefabId: second.prefabId, revision: 2, slotValues: { goal: 'new goal' } },
  }, f.ws)
  assert.match(update.text, /revision=2/)
  assert.equal(JSON.parse(f.channelAgents.findById(worker.id)!.prefabBindingJson!).contentHash, second.contentHash)
  await handleUpdateTeamAgent({ agent_id: worker.id, prefab: null }, f.ws)
  assert.equal(f.channelAgents.findById(worker.id)?.prefabBindingJson, '')
  assert.deepEqual(f.notices, ['added', 'updated', 'updated', 'updated'])
  assert.deepEqual(f.reloads, [worker.id, worker.id, worker.id])
  assert.deepEqual(f.prefabs.get({ id: 'channel-owner' }, first.prefabId), beforeDraft)
})

test('binding failures and insert failures leave no template/member and emit no add event', async (t) => {
  const f = fixture(t)
  const foreign = f.publish('other-user')
  const own = f.publish()
  const blocked = f.publish('channel-owner', 'private', [{ kind: 'tool', id: 'unregistered_tool', required: true }])
  const templateCount = f.agents.list().length
  const create = (prefabId: string, revision: number, slotValues?: Record<string, string>) => f.ws.createTeamMember({
    name: 'Worker', harness: 'mock', prefab: { prefabId, revision, slotValues },
  })
  await assert.rejects(create(foreign.prefabId, 1, { goal: 'x' }), { code: 'PREFAB_FORBIDDEN' })
  await assert.rejects(create(own.prefabId, 2, { goal: 'x' }), { code: 'PREFAB_REVISION_NOT_FOUND' })
  await assert.rejects(create(own.prefabId, 1), { code: 'VALIDATION_ERROR' })
  await assert.rejects(create(blocked.prefabId, 1, { goal: 'x' }), { code: 'PREFAB_REQUIRED_CAPABILITY_MISSING' })
  await assert.rejects(handleCreateTeamAgent({ name: 'Worker', harness: 'mock', prefab: { prefabId: own.prefabId, revision: 1, slotValues: { goal: 'x' }, contentHash: 'forged' } }, f.ws), { code: 'VALIDATION_ERROR' })
  f.db.exec(`CREATE TRIGGER fail_worker_insert BEFORE INSERT ON channel_agents WHEN NEW.role = 'worker' BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;`)
  await assert.rejects(create(own.prefabId, 1, { goal: 'x' }), /test insert failure/)
  assert.equal(f.agents.list().length, templateCount)
  assert.deepEqual(f.channelAgents.listByChannel(f.channel.id).map(row => row.id), [f.lead.id])
  assert.deepEqual(f.notices, [])
})

test('ownerless channels bind only public revisions; stale lead, workers, protected targets cannot mutate', async (t) => {
  const f = fixture(t, null)
  const foreign = f.publish(f.lead.id)
  const pub = f.publish('foreign', 'public')
  const otherLead = f.channelAgents.create({ ...f.memberInput, role: 'lead' })
  const protectedWorker = f.channelAgents.create(f.memberInput)
  const selection = { prefabId: pub.prefabId, revision: 1, slotValues: { goal: 'x' } }
  const createInput = { name: 'New worker', harness: 'mock', prefab: selection }
  await assert.rejects(f.manager.createTeamMember(f.channel.id, otherLead.id, createInput), { code: 'SCOPE_VIOLATION' })
  await assert.rejects(f.manager.createTeamMember(f.channel.id, protectedWorker.id, createInput), { code: 'SCOPE_VIOLATION' })
  await assert.rejects(f.ws.createTeamMember({ ...createInput, prefab: { ...selection, prefabId: foreign.prefabId } }), { code: 'PREFAB_FORBIDDEN' })
  const worker = await f.ws.createTeamMember(createInput)
  assert.equal(worker.prefabBinding?.prefabId, pub.prefabId)
  await assert.rejects(f.ws.updateTeamMember(protectedWorker.id, { prefab: selection }), { code: 'SCOPE_VIOLATION' })
  await assert.rejects(f.ws.updateTeamMember(f.lead.id, { prefab: null }), { code: 'SCOPE_VIOLATION' })
  const before = f.channelAgents.findById(worker.id)
  await assert.rejects(f.ws.updateTeamMember(worker.id, { name: 'must not change', prefab: { ...selection, prefabId: foreign.prefabId } }), { code: 'PREFAB_FORBIDDEN' })
  assert.deepEqual(f.channelAgents.findById(worker.id), before)
  f.channels.update(f.channel.id, { leadAgentId: otherLead.id })
  await assert.rejects(f.ws.updateTeamMember(worker.id, { prefab: null }), { code: 'SCOPE_VIOLATION' })
  await assert.rejects(f.ws.removeTeamMember(worker.id), { code: 'SCOPE_VIOLATION' })
  await assert.rejects(f.manager.updateTeamMember(f.channel.id, otherLead.id, worker.id, { prefab: null }), { code: 'SCOPE_VIOLATION' })
  assert.equal((await f.manager.listTeamMembers(f.channel.id, otherLead.id)).find(x => x.id === worker.id)?.protected, true)
})

test('scheduler forwards selectors and explicit detach unchanged to the same workspace', () => {
  const seen: unknown[] = []
  const scheduler = Object.assign(Object.create(SchedulerLoopExecute.prototype) as { execute: (decision: SchedulerDecision) => void }, {
    lead: { workspace: {
      createTeamMember: async (input: unknown) => { seen.push(input) },
      updateTeamMember: async (id: string, patch: unknown) => { seen.push([id, patch]) },
    } },
  })
  const prefab = { prefabId: 'published', revision: 4, slotValues: { goal: 'x' } }
  scheduler.execute({ kind: 'spawn_agent', name: 'Worker', prefab })
  scheduler.execute({ kind: 'update_agent', agentId: 'worker', prefab })
  scheduler.execute({ kind: 'update_agent', agentId: 'worker', prefab: null, enabled: false })
  assert.deepEqual(seen, [
    { name: 'Worker', prefab, harness: undefined, config: undefined, templateId: undefined, reason: undefined },
    ['worker', { name: undefined, config: undefined, prefab, enabled: undefined, reason: undefined }],
    ['worker', { name: undefined, config: undefined, prefab: null, enabled: 0, reason: undefined }],
  ])
})

test('tool catalog exposes the selector for both locales', () => {
  for (const locale of ['zh', 'en'] as const) {
    const tools = loadHostToolDefs(locale)
    const create = tools.find(tool => tool.name === 'create_team_agent')!
    const update = tools.find(tool => tool.name === 'update_team_agent')!
    assert.deepEqual((create.parameters as { properties: { prefab: { required: string[] } } }).properties.prefab.required, ['prefabId', 'revision'])
    assert.ok((update.parameters as { properties: { prefab: { anyOf: Array<{ type: string }> } } }).properties.prefab.anyOf.some(schema => schema.type === 'null'))
  }
})
