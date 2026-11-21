/**
 * AgentPrefab 运行时接线：resolver 读取成员 binding/registry/Channel 策略；
 * Session clone 与 Project task instance 复制 binding 并固定快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'
import { createAgentPrefabService } from '../server/services/workshop/agent-prefabs/service'
import { prefabAllowsTool, prefabBlockedReason, resolveRuntimeForAgent } from '../server/services/workshop/agent-prefabs/runtime'
import { createChannelSession } from '../server/services/workshop/agents/session-clone'
import type { SessionCloneDeps } from '../server/services/workshop/agents/session-clone'
import { createTaskInstanceChannel } from '../server/services/workshop/agents/task-channel'
import type { TaskInstanceDeps } from '../server/services/workshop/agents/task-channel'

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Expert',
    description: '',
    visibility: 'private',
    prompt: { role: 'role', scenario: 'scenario', slots: [{ key: 'goal', label: 'Goal', defaultValue: 'stable', allowMemberOverride: true }] },
    profile: {},
    capabilities: [{ kind: 'tool', id: 'daq_query', required: true }],
    ...overrides,
  }
}

test('legacy member has no prefab restrictions; bound member resolves active tools', () => {
  const db = openWorkshopDb(':memory:')
  try {
    initToolRegistryDb(db)
    const channel = createChannelRepo(db).create({ name: 'c', ownerUserId: 'u1' })
    const service = createAgentPrefabService(db)
    const prefab = service.create({ id: 'u1', role: 'user' }, draft())
    const revision = service.publish({ id: 'u1', role: 'user' }, prefab.id, 0)
    const binding = service.buildBinding({ id: 'u1', role: 'user' }, prefab.id, revision.revision, { goal: 'grow' })
    const repo = createChannelAgentRepo(db)
    const legacy = repo.create({ channelId: channel.id, templateId: null, name: 'legacy', harness: 'omp', config: {}, role: 'worker' })
    const bound = repo.create({ channelId: channel.id, templateId: null, name: 'bound', harness: 'omp', config: {}, role: 'worker', prefabBindingJson: JSON.stringify(binding) })

    const legacyRuntime = resolveRuntimeForAgent(db, legacy.id)
    assert.equal(legacyRuntime?.resolution.mode, 'legacy')
    assert.equal(prefabAllowsTool(legacyRuntime!.resolution, 'anything'), true)

    const runtime = resolveRuntimeForAgent(db, bound.id)
    assert.equal(runtime?.binding?.contentHash, revision.contentHash)
    assert.equal(runtime?.resolution.mode, 'prefab')
    assert.ok(runtime!.resolution.toolIds.includes('daq_query'))
    assert.ok(runtime!.resolution.toolIds.includes('send_message_to_agent'))
    assert.equal(runtime!.resolution.prompt.slots.find(s => s.key === 'goal')?.text, 'grow')
    assert.equal(prefabAllowsTool(runtime!.resolution, 'daq_query'), true)
    assert.equal(prefabAllowsTool(runtime!.resolution, 'dcw_control'), false)
    assert.equal(prefabBlockedReason(runtime!.resolution), null)
  }
  finally {
    db.close()
  }
})

test('required missing or corrupt binding fails closed', () => {
  const db = openWorkshopDb(':memory:')
  try {
    initToolRegistryDb(db)
    const channel = createChannelRepo(db).create({ name: 'c', ownerUserId: 'u1' })
    const service = createAgentPrefabService(db)
    const prefab = service.create({ id: 'u1', role: 'user' }, draft({ capabilities: [{ kind: 'tool', id: 'not_registered', required: true }] }))
    const revision = service.publish({ id: 'u1', role: 'user' }, prefab.id, 0)
    const binding = service.buildBinding({ id: 'u1', role: 'user' }, prefab.id, revision.revision, {})
    const repo = createChannelAgentRepo(db)
    const missing = repo.create({ channelId: channel.id, templateId: null, name: 'm', harness: 'omp', config: {}, role: 'worker', prefabBindingJson: JSON.stringify(binding) })
    const corrupt = repo.create({ channelId: channel.id, templateId: null, name: 'x', harness: 'omp', config: {}, role: 'worker', prefabBindingJson: '{bad json' })

    const missingRuntime = resolveRuntimeForAgent(db, missing.id)
    assert.deepEqual(missingRuntime?.resolution.requiredMissing, ['tool:not_registered'])
    assert.match(prefabBlockedReason(missingRuntime!.resolution) ?? '', /not_registered/)

    const corruptRuntime = resolveRuntimeForAgent(db, corrupt.id)
    assert.deepEqual(corruptRuntime?.resolution.requiredMissing, ['__prefab__'])
    assert.ok(corruptRuntime?.bindingError)
  }
  finally {
    db.close()
  }
})

test('session clone copies member binding and stores a prefab snapshot', () => {
  const bindingJson = JSON.stringify({ prefabId: 'p1', revision: 1, slotValues: { goal: 'g' }, contentHash: 'hash' })
  const created: Array<{ prefabBindingJson?: string }> = []
  let sessionInput: { prefabSnapshotJson?: string, prefabSnapshotHash?: string } | undefined
  const deps: SessionCloneDeps = {
    channelAgents: {
      listByChannel: () => [
        { id: 'lead-1', name: 'Lead', harness: 'omp', role: 'lead', enabled: 1, configJson: '{}', prefabBindingJson: bindingJson },
        { id: 'w-1', name: 'Worker', harness: 'omp', role: 'worker', enabled: 1, configJson: '{}', prefabBindingJson: bindingJson },
      ],
      create: (input) => {
        created.push(input)
        return { id: `clone-${created.length}`, name: input.name, role: input.role }
      },
    },
    tasks: { list: () => [], cancelTree: () => [] },
    bindings: { byAgent: () => [], bind: () => undefined },
    unloadAgent: async () => {},
  }
  const result = createChannelSession(deps, {
    channelId: 'c1',
    actorId: 'u1',
    sessionRepo: {
      create: (input) => {
        sessionInput = input
        return { id: 'cs-1' } as never
      },
    },
  })
  assert.equal(result.members.length, 2)
  assert.ok(created.every(x => x.prefabBindingJson === bindingJson))
  assert.ok(sessionInput?.prefabSnapshotJson?.includes('lead-1'))
  assert.match(sessionInput?.prefabSnapshotHash ?? '', /^[a-f0-9]{64}$/)
})

test('project task instance copies bindings and returns pinned snapshot', async () => {
  const created: Array<{ prefabBindingJson?: string }> = []
  let leadInput: { prefabBindingJson?: string } | undefined
  let sessionInput: { prefabSnapshotJson?: string, prefabSnapshotHash?: string } | undefined
  const deps: TaskInstanceDeps = {
    channels: {
      findById: () => ({ id: 'tpl', name: 'Tpl', scenarioPrompt: '', llmJson: '', ownerUserId: 'u1' }),
    },
    channelAgents: {
      listByChannel: () => [
        { id: 'lead-1', name: 'Lead', harness: 'omp', role: 'lead', enabled: 1, configJson: '{}', prefabBindingJson: 'lead-binding' },
        { id: 'w-1', name: 'Worker', harness: 'omp', role: 'worker', enabled: 1, configJson: '{}', prefabBindingJson: 'worker-binding' },
      ],
      create: (input) => {
        created.push(input)
        return { id: 'inst-1', name: input.name, role: input.role }
      },
    },
    sessions: {
      create: (input) => {
        sessionInput = input
        return { id: 'cs-task' }
      },
    },
    createChannel: async (input) => {
      leadInput = input.leadAgent
      return { channelId: 'new-ch', leadAgentId: 'lead-inst', workspace: '/w' }
    },
  }
  const result = await createTaskInstanceChannel(deps, { projectId: 'p', workItemId: 'w', templateChannelId: 'tpl', title: 'task', actorId: 'u1' })
  assert.equal(leadInput?.prefabBindingJson, 'lead-binding')
  assert.equal(created[0]?.prefabBindingJson, 'worker-binding')
  assert.match(result.prefabSnapshotHash, /^[a-f0-9]{64}$/)
  assert.ok(result.prefabSnapshotJson.includes('lead-1'))
  assert.equal(sessionInput?.prefabSnapshotHash, result.prefabSnapshotHash)
})
