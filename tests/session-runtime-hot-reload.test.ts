import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createSessionRuntimeOverrideRepo } from '../server/services/workshop/db/session-runtime.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'

process.env.AGENTWORKSHOP_TEST = '1'

test('runtime revision change is detected and hot swap replaces the single clone runtime without stopping others', async (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'runtime-hotswap', ownerUserId: 'owner' })
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead', config: { provider: 'local', model: 'a' } })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'omp', role: 'worker', config: { provider: 'local', model: 'a' } })
  const sibling = agents.create({ channelId: channel.id, templateId: null, name: 'worker·session·2', harness: 'omp', role: 'worker', config: { provider: 'local', model: 'a' } })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  createSessionRuntimeOverrideRepo(db).save({
    sessionId: session.id, agentId: clone.id, expectedRevision: 0,
    overridesJson: JSON.stringify({ model: 'b' }), updatedBy: 'owner',
  })

  let stopped = 0
  const old = {
    agentId: clone.id,
    stop: async () => { stopped += 1 },
    stopForHotSwap: async () => { stopped += 1 },
  }
  const manager = Object.assign(Object.create(ManagerRuntimeWiring.prototype), {
    deps: {
      db,
      repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
      implFactory: (agent: AgentInfo) => ({ agentInfo: agent }),
    },
    buses: new Map([[channel.id, { notifyAgent() {}, publish() {} }]]),
    agentIndex: new Map([[`${channel.id}\u0000${clone.id}`, old], [`${channel.id}\u0000${sibling.id}`, { agentId: sibling.id, stop: async () => {} }]]),
    appliedRuntimeRevisions: new Map([[`${channel.id}\u0000${clone.id}`, 0], [`${channel.id}\u0000${sibling.id}`, 0]]),
    runtimeHotSwaps: new Map(),
    ensureChannelRuntime: () => ({ addAgent() {}, wakeScheduler() {} }),
    buildWorkspace: () => ({}),
    channelWorkspace: () => '',
    getTaskEngine: () => ({}),
    reviveScheduler: () => {},
  }) as Record<string, unknown>

  t.mock.method(AgentRuntime.prototype, 'start', () => {})
  t.mock.method(AgentRuntime.prototype, 'wakeMailbox', () => {})

  const changed = manager as { runtimeRevisionChanged: (c: string, a: string) => boolean }
  assert.equal(changed.runtimeRevisionChanged(channel.id, clone.id), true)
  assert.equal(changed.runtimeRevisionChanged(channel.id, sibling.id), false)

  await (manager as { hotReloadRuntime: (c: string, a: string) => Promise<boolean> }).hotReloadRuntime(channel.id, clone.id)

  const index = manager.agentIndex as Map<string, unknown>
  const replacement = index.get(`${channel.id}\u0000${clone.id}`)
  assert.ok(replacement && replacement !== old, 'clone runtime must be replaced')
  assert.equal(stopped, 1, 'old clone runtime must be stopped')
  assert.ok(index.get(`${channel.id}\u0000${sibling.id}`), 'sibling session runtime must remain')
  const revisions = manager.appliedRuntimeRevisions as Map<string, number>
  assert.equal(revisions.get(`${channel.id}\u0000${clone.id}`), 1)
  assert.equal(changed.runtimeRevisionChanged(channel.id, clone.id), false)
})
