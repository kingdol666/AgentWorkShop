import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime/facade'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'
import { createAgentPrefabService } from '../server/services/workshop/agent-prefabs/service'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'

process.env.AGENTWORKSHOP_TEST = '1'

test('wireMember calls setChannelSessionScope with the impl as receiver', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'scope-wire' })
    const agents = createChannelAgentRepo(db)
    const agent = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'fake', role: 'lead' })
    let calls = 0
    const impl = {
      bridgeCtx: { identity: {} } as Record<string, unknown>,
      setChannelSessionScope(scope: unknown) {
        calls += 1
        // 解构后裸调用时 this=undefined → 这里抛 TypeError,与线上频道激活 500 同型
        this.bridgeCtx.channelSessionScope = scope
      },
    }
    const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
    manager.deps = {
      db,
      repos: { channels, channelAgents: agents, messages: createMessageRepo(db), memories: createMemoryRepo(db) },
      implFactory: () => impl,
    }
    manager.buses = new Map([[channel.id, { notifyAgent() {}, publish() {} }]])
    manager.agentIndex = new Map()
    manager.ensureChannelRuntime = () => ({ addAgent() {}, scheduler: null, wakeScheduler() {} })
    manager.buildWorkspace = () => ({})
    manager.channelWorkspace = () => ''
    manager.getTaskEngine = () => ({})
    manager.reviveScheduler = () => {}
    const start = AgentRuntime.prototype.start
    AgentRuntime.prototype.start = function () {}
    try {
      const wire = (manager as { wireMember: (m: unknown) => { stop: () => Promise<void> } }).wireMember
      const runtime = wire.call(manager, agents.findById(agent.id))
      assert.equal(calls, 1, 'setChannelSessionScope must be invoked exactly once')
      assert.equal(impl.bridgeCtx.channelSessionScope, null, 'generic channel wires a null session scope')
      assert.ok(runtime)
    }
    finally {
      AgentRuntime.prototype.start = start
    }
  }
  finally {
    db.close()
  }
})

test('wireMember applies the pinned Prefab profile before implFactory without touching launch or context settings', (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'profile-wire', scenarioPrompt: 'channel scenario' })
  channels.update(channel.id, { llm: { provider: 'channel-provider', model: 'channel-model', effort: 'low' } })
  const agents = createChannelAgentRepo(db)
  const prefabs = createAgentPrefabService(db)
  const owner = { id: 'u1' }
  const draft = { name: 'Expert', prompt: { role: 'prefab role' }, profile: {
    provider: 'prefab-provider', model: 'prefab-model', effort: 'high', settings: { thinkingLevel: 'low' },
  } }
  const prefab = prefabs.create(owner, draft)
  const first = prefabs.publish(owner, prefab.id, 0)
  const binding = prefabs.buildBinding(owner, prefab.id, first.revision, {})
  prefabs.update(owner, prefab.id, prefabs.get(owner, prefab.id).updatedAt, { ...draft, profile: { model: 'new-head' } })
  prefabs.publish(owner, prefab.id, first.revision)
  const config = {
    provider: 'member-provider', model: 'member-model', effort: 'minimal', thinkingLevel: 'minimal',
    command: 'omp', args: ['--existing'], env: { KEEP: 'yes' }, cwd: '/member', systemPromptPrefix: 'platform prefix',
  }
  const member = agents.create({ channelId: channel.id, templateId: null, name: 'worker', harness: 'omp', role: 'worker', config, prefabBindingJson: JSON.stringify(binding) })
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
    ensureChannelRuntime: () => ({ addAgent() {}, wakeScheduler() {} }),
    buildWorkspace: () => ({}),
    channelWorkspace: () => '/channel',
    getTaskEngine: () => ({}),
  }) as { wireMember: (row: typeof member) => void }
  t.mock.method(AgentRuntime.prototype, 'start', () => {})

  manager.wireMember(member)
  assert.equal(wired?.harness, 'omp')
  assert.deepEqual(wired?.config, {
    ...config,
    provider: 'prefab-provider', model: 'prefab-model', effort: 'high', thinkingLevel: 'high', cwd: '/channel',
    scenarioPrompt: 'channel scenario', prefabPrompt: wired?.config.prefabPrompt, prefabBindingHash: first.contentHash,
  })
  assert.match(String(wired?.config.prefabPrompt), /prefab role/)
  assert.deepEqual(JSON.parse(agents.findById(member.id)!.configJson), config)

  const partial = prefabs.create(owner, { name: 'Partial', profile: { settings: { thinkingLevel: 'high' } } })
  const partialRev = prefabs.publish(owner, partial.id, 0)
  const partialBinding = prefabs.buildBinding(owner, partial.id, partialRev.revision, {})
  const partialMember = agents.update(member.id, { config: { model: 'member-model' }, prefabBindingJson: JSON.stringify(partialBinding) })
  manager.wireMember(partialMember!)
  assert.equal(wired?.config.provider, 'channel-provider')
  assert.equal(wired?.config.model, 'member-model')
  assert.equal(wired?.config.thinkingLevel, 'high')
  assert.equal(wired?.config.effort, 'high')

  const openCodePrefab = prefabs.create(owner, { name: 'OpenCode', profile: {
    provider: 'prefab-provider', model: 'prefab-model', settings: { variant: 'high' },
  } })
  const openCodeRev = prefabs.publish(owner, openCodePrefab.id, 0)
  const openCodeBinding = prefabs.buildBinding(owner, openCodePrefab.id, openCodeRev.revision, {})
  const openCodeMember = agents.create({
    channelId: channel.id, templateId: null, name: 'opencode-worker', harness: 'opencode', role: 'worker',
    config: { model: 'member-provider/member-model', variant: 'low' }, prefabBindingJson: JSON.stringify(openCodeBinding),
  })
  manager.wireMember(openCodeMember)
  assert.equal(wired?.config.provider, 'prefab-provider')
  assert.equal(wired?.config.model, 'prefab-provider/prefab-model')
  assert.equal(wired?.config.variant, 'high')

  for (const [harness, profile, code] of [
    ['omp', { settings: { providerBaseUrl: 'untrusted' } }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['omp', { settings: { piExtensionPath: 'untrusted' } }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['omp', { settings: { thinkingLevel: true } }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['omp', { effort: 'unknown-level' }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['omp', { model: '--not-a-model' }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['codex', { provider: 'unused' }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['dsh', { effort: 'high' }, 'PREFAB_PROFILE_UNSUPPORTED'],
    ['opencode', { provider: 'first', model: 'second/model' }, 'PREFAB_PROFILE_CONFLICT'],
  ] as const) {
    const unsafe = prefabs.create(owner, { name: 'Unsafe', profile })
    const unsafeRev = prefabs.publish(owner, unsafe.id, 0)
    const unsafeBinding = prefabs.buildBinding(owner, unsafe.id, unsafeRev.revision, {})
    const updated = agents.create({ channelId: channel.id, templateId: null, name: `rejected-${unsafe.id}`, harness, role: 'worker', prefabBindingJson: JSON.stringify(unsafeBinding) })
    wired = undefined
    assert.throws(() => manager.wireMember(updated), { code })
    assert.equal(wired, undefined, 'unsupported settings must not reach implFactory')
  }

  const legacy = agents.update(member.id, { prefabBindingJson: '' })
  manager.wireMember(legacy!)
  assert.deepEqual((wired as AgentInfo | undefined)?.config, {
    model: 'member-model', provider: 'channel-provider', effort: 'low', cwd: '/channel', scenarioPrompt: 'channel scenario',
  })
})
