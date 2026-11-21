import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ChannelAgentCreationSource } from '../server/services/workshop/db/database/rows'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-agent-removal-'))

const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createChatMessageRepo } = await import('../server/services/workshop/db/chat-message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const { AgentChannelManager } = await import('../server/services/workshop/runtime/manager/facade')

function fixture(t: TestContext) {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  const channels = createChannelRepo(db)
  const channelAgents = createChannelAgentRepo(db)
  const agents = createAgentRepo(db)
  const chatMessages = createChatMessageRepo(db)
  const sessions = createChannelSessionRepo(db)
  const subscriptions = createSubscriptionRepo(db)
  const channel = channels.create({ name: 'Channel', ownerUserId: 'owner' })
  const template = agents.create({ name: 'Global template', harness: 'mock', ownerUserId: 'owner' })
  const workerInput = { channelId: channel.id, templateId: template.id, name: 'Worker', harness: 'mock', role: 'worker' as const }
  const lead = channelAgents.create({ ...workerInput, role: 'lead', name: 'Lead', templateId: null })
  channels.update(channel.id, { leadAgentId: lead.id })
  const stopped: string[] = []
  const notices: string[] = []
  let taskLookups = 0
  const manager = Object.assign(Object.create(AgentChannelManager.prototype) as InstanceType<typeof AgentChannelManager>, {
    deps: {
      db,
      repos: { channels, channelAgents, agents, chatMessages, subscriptions, tasks: { listByChannelAssignee: () => { taskLookups++; return [] } } },
    },
    activeInvocationScopes: new Map(),
    ensureAgentRuntime: () => undefined,
    stopAndDetach: async (_channelId: string, id: string) => { stopped.push(id) },
    notifyMember: (_channelId: string, member: { op: string }) => { notices.push(member.op) },
  })
  return { db, channel, channels, channelAgents, agents, template, workerInput, lead, sessions, chatMessages, stopped, notices, taskLookups: () => taskLookups, manager }
}

function assertSource(row: ChannelAgentCreationSource | undefined, source: ChannelAgentCreationSource) {
  assert.equal(row?.createdByKind, source.createdByKind)
  assert.equal(row?.createdById, source.createdById)
  assert.equal(row?.createdVia, source.createdVia)
  assert.equal(row?.createdReason, source.createdReason)
}

function seedDelivery(f: ReturnType<typeof fixture>, targetAgentId: string, status: 'pending' | 'delivered' | 'consumed' = 'pending') {
  const { row } = f.chatMessages.create({ channelId: f.channel.id, senderType: 'user', senderId: 'owner', text: 'Test' })
  return f.chatMessages.createDelivery({ chatMessageId: row.id, channelId: f.channel.id, targetAgentId, status }).row
}

test('user and leader provenance round trips; event attribution does not grant ownership', async (t) => {
  const f = fixture(t)
  const user = { createdByKind: 'user', createdById: 'owner', createdVia: 'manual', createdReason: 'Owner request' } as const
  const userWorker = await f.manager.addAgentToChannel({ channelId: f.channel.id, agentId: f.template.id, role: 'worker', ...user })
  const leadWorker = await f.manager.createTeamMember(f.channel.id, f.lead.id, { name: 'Leader worker', templateId: f.template.id, reason: 'Extra capacity' })
  const unattributed = await f.manager.addAgentToChannel({ channelId: f.channel.id, agentId: f.template.id, role: 'worker', by: `lead:${f.lead.id}` })
  assertSource(f.channelAgents.findById(userWorker.id), user)
  assertSource(f.channelAgents.findById(leadWorker.id), { createdByKind: 'leader', createdById: f.lead.id, createdVia: 'lead_team', createdReason: 'Extra capacity' })
  assertSource(f.channelAgents.findById(unattributed.id), { createdByKind: 'system', createdById: null, createdVia: 'protected', createdReason: '' })
  assertSource(f.channelAgents.update(userWorker.id, { name: 'Updated' }), user)
})

test('leader removal rejects protected, user, other-leader, and cross-channel workers before side effects', async (t) => {
  const f = fixture(t)
  const defaults = f.channelAgents.create(f.workerInput)
  const user = f.channelAgents.create({ ...f.workerInput, createdByKind: 'user', createdById: f.lead.id })
  const otherLead = f.channelAgents.create({ ...f.workerInput, role: 'lead' })
  const otherWorker = f.channelAgents.create({ ...f.workerInput, createdByKind: 'leader', createdById: otherLead.id })
  const foreignChannel = f.channels.create({ name: 'Other channel' })
  const foreignWorker = f.channelAgents.create({ ...f.workerInput, channelId: foreignChannel.id, createdByKind: 'leader', createdById: f.lead.id })
  const delivery = seedDelivery(f, user.id)
  for (const target of [defaults, user, otherWorker, otherLead]) {
    await assert.rejects(f.manager.removeTeamMember(f.channel.id, f.lead.id, target.id), { code: 'SCOPE_VIOLATION' })
    assert.ok(f.channelAgents.findById(target.id))
  }
  await assert.rejects(f.manager.removeTeamMember(f.channel.id, f.lead.id, foreignWorker.id), { code: 'NOT_FOUND' })
  assert.ok(f.channelAgents.findById(foreignWorker.id))
  assert.equal(f.taskLookups(), 0)
  assert.deepEqual(f.stopped, [])
  assert.equal(f.chatMessages.findDeliveryById(delivery.id)?.status, 'pending')
})

test('removing a leader-owned worker preserves the last global template and cleans up only its deliveries and bindings', async (t) => {
  const f = fixture(t)
  const worker = await f.manager.createTeamMember(f.channel.id, f.lead.id, { name: 'Worker', templateId: f.template.id })
  const pending = seedDelivery(f, worker.id)
  const delivered = seedDelivery(f, worker.id, 'delivered')
  const consumed = seedDelivery(f, worker.id, 'consumed')
  const other = seedDelivery(f, f.lead.id)
  const bindings = getAgentNodeBindingRepo()
  bindings.bind(worker.id, 'worker-node', 'daq', 'manual')
  bindings.bind(f.lead.id, 'lead-node', 'daq', 'manual')
  t.after(() => bindings.removeAgent(f.lead.id))
  f.db.exec(`CREATE TRIGGER require_cancel_before_agent_delete BEFORE DELETE ON channel_agents
    WHEN EXISTS (SELECT 1 FROM chat_deliveries WHERE channel_id = OLD.channel_id AND target_agent_id = OLD.id AND status IN ('pending', 'delivered'))
    BEGIN SELECT RAISE(ABORT, 'delivery must be cancelled first'); END;`)

  assert.deepEqual(await f.manager.removeTeamMember(f.channel.id, f.lead.id, worker.id), { recycledTasks: [] })
  assert.deepEqual(f.stopped, [worker.id])
  assert.deepEqual(f.notices, ['added', 'removed'])
  assert.equal(f.channelAgents.findById(worker.id), undefined)
  assert.ok(f.agents.findById(f.template.id))
  for (const d of [pending, delivered]) assert.equal(f.chatMessages.findDeliveryById(d.id)?.status, 'cancelled')
  assert.equal(f.chatMessages.findDeliveryById(consumed.id)?.status, 'consumed')
  assert.equal(f.chatMessages.findDeliveryById(other.id)?.status, 'pending')
  assert.equal(bindings.byAgent(worker.id).length, 0)
  assert.equal(bindings.byAgent(f.lead.id).length, 1)
})

test('ordinary removal blocks lead, project leader and unclosed clones, then permits a closed clone', async (t) => {
  const f = fixture(t)
  const office = f.channelAgents.create({ ...f.workerInput, agentKind: 'project_leader' })
  const clone = f.channelAgents.create({ ...f.workerInput, createdByKind: 'leader', createdById: f.lead.id, createdVia: 'lead_team' })
  const session = f.sessions.create({ channelId: f.channel.id, memberMap: { [f.lead.id]: clone.id } })
  const duplicate = f.sessions.create({ channelId: f.channel.id, instanceKind: 'task', memberMap: { [f.lead.id]: clone.id } })
  const delivery = seedDelivery(f, clone.id)
  for (const target of [f.lead, office, clone]) {
    await assert.rejects(f.manager.removeAgentFromChannel(f.channel.id, target.id), { code: 'CHANNEL_AGENT_PROTECTED' })
    assert.ok(f.channelAgents.findById(target.id))
  }
  await assert.rejects(f.manager.removeTeamMember(f.channel.id, f.lead.id, clone.id), { code: 'CHANNEL_AGENT_PROTECTED' })
  f.sessions.close(duplicate.id)
  f.sessions.beginClosing(session.id)
  await assert.rejects(f.manager.removeAgentFromChannel(f.channel.id, clone.id), { code: 'CHANNEL_AGENT_PROTECTED' })
  assert.deepEqual(f.stopped, [])
  assert.equal(f.taskLookups(), 0)
  assert.equal(f.chatMessages.findDeliveryById(delivery.id)?.status, 'pending')

  f.sessions.close(session.id)
  await f.manager.removeAgentFromChannel(f.channel.id, clone.id)
  assert.equal(f.channelAgents.findById(clone.id), undefined)
  assert.equal(f.chatMessages.findDeliveryById(delivery.id)?.status, 'cancelled')
  assert.equal(f.channels.findById(f.channel.id)?.leadAgentId, f.lead.id)
})
