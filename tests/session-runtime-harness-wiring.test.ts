import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createSessionRuntimeOverrideRepo } from '../server/services/workshop/db/session-runtime.repo'
import { applySessionRuntimeOverrides, parseSessionRuntimeOverrides } from '../server/services/workshop/sessions/runtime-overrides'
import { resolveRuntimeForMember } from '../server/services/workshop/agent-prefabs/runtime'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'

process.env.AGENTWORKSHOP_TEST = '1'

test('overrides parse keeps harness and explicit selector suppression', () => {
  const parsed = parseSessionRuntimeOverrides(JSON.stringify({
    harness: 'codex',
    provider: '',
    model: '',
    effort: '',
    runtimePrompt: 'keep',
  }))
  assert.equal(parsed.harness, 'codex')
  assert.equal(parsed.provider, '')
  assert.equal(parsed.model, '')
  assert.equal(parsed.effort, '')
  assert.equal(parsed.runtimePrompt, 'keep')
})

test('suppression deletes inherited selectors and the native effort alias', () => {
  const config: Record<string, unknown> = {
    provider: 'local',
    model: 'gemma',
    effort: 'high',
    thinkingLevel: 'high',
    variant: 'high',
  }
  applySessionRuntimeOverrides(config, 'omp', { provider: '', model: '', effort: '' })
  assert.equal('provider' in config, false)
  assert.equal('model' in config, false)
  assert.equal('effort' in config, false)
  assert.equal('thinkingLevel' in config, false)
  assert.equal('variant' in config, false)
})

test('resolveRuntimeForMember resolves capabilities against the overridden harness', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'harness-resolve' })
    const agents = createChannelAgentRepo(db)
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'omp', role: 'worker', config: {} })
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({ channelId: channel.id, title: 's', memberMap: { [base.id]: base.id } })
    createSessionRuntimeOverrideRepo(db).save({
      sessionId: session.id,
      agentId: base.id,
      expectedRevision: 0,
      overridesJson: JSON.stringify({ harness: 'codex' }),
      updatedBy: 'owner',
    })
    const resolved = resolveRuntimeForMember(db, agents.findById(base.id)!)
    assert.equal(resolved.member.harness, 'codex')
    assert.equal(resolved.overrides?.harness, 'codex')
  }
  finally {
    db.close()
  }
})

test('wireMember builds the impl with the session-overridden harness', () => {
  const db = openWorkshopDb(':memory:')
  const start = AgentRuntime.prototype.start
  AgentRuntime.prototype.start = function () {}
  try {
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'harness-wire' })
    const agents = createChannelAgentRepo(db)
    const base = agents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'omp', role: 'worker', config: {} })
    const clone = agents.create({ channelId: channel.id, templateId: null, name: 'worker·session·1', harness: 'omp', role: 'worker', config: {} })
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({ channelId: channel.id, title: 's', memberMap: { [base.id]: clone.id } })
    createSessionRuntimeOverrideRepo(db).save({
      sessionId: session.id,
      agentId: clone.id,
      expectedRevision: 0,
      overridesJson: JSON.stringify({ harness: 'codex' }),
      updatedBy: 'owner',
    })

    const seen: string[] = []
    const impl = {
      bridgeCtx: { identity: {} } as Record<string, unknown>,
      setChannelSessionScope() {},
      setTrustedSessionId() {},
    }
    const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
    manager.deps = {
      db,
      repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
      implFactory: (agent: { harness: string }) => {
        seen.push(agent.harness)
        return impl
      },
    }
    manager.buses = new Map([[channel.id, { notifyAgent() {}, publish() {} }]])
    manager.agentIndex = new Map()
    manager.ensureChannelRuntime = () => ({ addAgent() {}, scheduler: null, wakeScheduler() {} })
    manager.buildWorkspace = () => ({})
    manager.channelWorkspace = () => ''
    manager.getTaskEngine = () => ({})
    manager.reviveScheduler = () => {}

    const wire = (manager as { wireMember: (m: unknown) => unknown }).wireMember
    wire.call(manager, agents.findById(clone.id))
    assert.deepEqual(seen, ['codex'])
  }
  finally {
    AgentRuntime.prototype.start = start
    db.close()
  }
})
