import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createSessionRuntimeOverrideRepo } from '../server/services/workshop/db/session-runtime.repo'
import { createAgentPrefabService } from '../server/services/workshop/agent-prefabs/service'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'

process.env.AGENTWORKSHOP_TEST = '1'

test('wireMember applies session runtime overrides after prefab profile and appends low-trust runtime prompt', (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'runtime-wire', scenarioPrompt: 'channel scenario' })
  channels.update(channel.id, { llm: { provider: 'channel-provider', model: 'channel-model', effort: 'low' } })
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const prefabs = createAgentPrefabService(db)
  const owner = { id: 'owner' }
  const prefab = prefabs.create(owner, {
    name: '会话 runtime Prefab', description: '', visibility: 'public',
    prompt: { role: 'prefab role', scenario: '', slots: [] },
    profile: { provider: 'prefab-provider', model: 'prefab-model', effort: 'high' },
    capabilities: [],
  })
  const rev = prefabs.publish(owner, prefab.id, 0)
  const binding = prefabs.buildBinding(owner, prefab.id, rev.revision, {})
  const base = agents.create({
    channelId: channel.id, templateId: null, name: 'lead', harness: 'omp', role: 'lead',
    config: { provider: 'member-provider', model: 'member-model', effort: 'minimal' },
  })
  const clone = agents.create({
    channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'omp', role: 'worker',
    config: { provider: 'member-provider', model: 'member-model', effort: 'minimal', systemPromptPrefix: 'member prompt' },
    prefabBindingJson: JSON.stringify(binding),
  })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  const repo = createSessionRuntimeOverrideRepo(db)
  repo.save({
    sessionId: session.id, agentId: clone.id, expectedRevision: 0,
    overridesJson: JSON.stringify({
      provider: 'session-provider',
      model: 'session-model',
      effort: 'medium',
      runtimePrompt: '只读分析，不写设备',
    }),
    updatedBy: 'owner',
  })

  let wired: AgentInfo | undefined
  const manager = Object.assign(Object.create(ManagerRuntimeWiring.prototype), {
    deps: {
      db,
      repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
      implFactory: (agent: AgentInfo) => {
        wired = agent
        return {}
      },
    },
    buses: new Map([[channel.id, {}]]),
    agentIndex: new Map(),
    appliedRuntimeRevisions: new Map(),
    runtimeHotSwaps: new Map(),
    ensureChannelRuntime: () => ({ addAgent() {}, wakeScheduler() {} }),
    buildWorkspace: () => ({}),
    channelWorkspace: () => '/channel',
    getTaskEngine: () => ({}),
    reviveScheduler: () => {},
  }) as { wireMember: (row: unknown) => unknown }
  t.mock.method(AgentRuntime.prototype, 'start', () => {})

  manager.wireMember(agents.findById(clone.id))

  assert.equal(wired?.config.provider, 'session-provider')
  assert.equal(wired?.config.model, 'session-model')
  assert.equal(wired?.config.effort, 'medium')
  assert.equal(wired?.config.thinkingLevel, 'medium')
  assert.match(String(wired?.config.runtimePrompt), /^## 会话运行提示/)
  assert.match(String(wired?.config.runtimePrompt), /只读分析/)
  assert.match(String(wired?.config.prefabPrompt), /prefab role/)
  assert.equal(wired?.config.cwd, '/channel')
  assert.equal(wired?.config.scenarioPrompt, 'channel scenario')

  // 只改 session runtime 的覆盖表；clone 与 base 成员行字节不变
  assert.equal(JSON.parse(agents.findById(clone.id)!.configJson).provider, 'member-provider')
  assert.equal(JSON.parse(agents.findById(base.id)!.configJson).provider, 'member-provider')
})

test('wireMember rejects unsupported session runtime profile before implFactory', (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'runtime-wire-bad', ownerUserId: 'owner' })
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'codex', role: 'lead', config: {} })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'codex', role: 'worker', config: {} })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  createSessionRuntimeOverrideRepo(db).save({
    sessionId: session.id, agentId: clone.id, expectedRevision: 0,
    overridesJson: JSON.stringify({ provider: 'unsupported-provider' }), updatedBy: 'owner',
  })
  let wired: AgentInfo | undefined
  const manager = Object.assign(Object.create(ManagerRuntimeWiring.prototype), {
    deps: {
      db,
      repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
      implFactory: (agent: AgentInfo) => {
        wired = agent
        return {}
      },
    },
    buses: new Map([[channel.id, {}]]),
    agentIndex: new Map(),
    appliedRuntimeRevisions: new Map(),
    runtimeHotSwaps: new Map(),
    ensureChannelRuntime: () => ({ addAgent() {}, wakeScheduler() {} }),
    buildWorkspace: () => ({}),
    channelWorkspace: () => '',
    getTaskEngine: () => ({}),
    reviveScheduler: () => {},
  }) as { wireMember: (row: unknown) => unknown }
  t.mock.method(AgentRuntime.prototype, 'start', () => {})
  assert.throws(() => manager.wireMember(agents.findById(clone.id)), { code: 'RUNTIME_PROFILE_UNSUPPORTED' })
  assert.equal(wired, undefined)
})
