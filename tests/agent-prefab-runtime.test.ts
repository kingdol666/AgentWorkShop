/**
 * AgentPrefab 运行时接线：resolver 读取成员 binding/registry/Channel 策略；
 * Session clone 与 Project task instance 复制 binding 并固定快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCapabilityRegistry } from '../server/services/workshop/agent-prefabs/registry'
import { hashSchema, newManifest, writeManifest } from '../server/services/workshop/mcp-client/config'
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

test('persisted binding must match the published revision and canonical slot rules', () => {
  const db = openWorkshopDb(':memory:')
  try {
    initToolRegistryDb(db)
    const channel = createChannelRepo(db).create({ name: 'c', ownerUserId: 'u1' })
    const owner = { id: 'u1' }
    const service = createAgentPrefabService(db)
    const prefab = service.create(owner, draft({
      prompt: { slots: [
        { key: 'goal', label: 'Goal', required: true, maxLength: 4 },
        { key: 'policy', label: 'Policy', defaultValue: 'fixed', allowMemberOverride: false },
      ] },
    }))
    const revision = service.publish(owner, prefab.id, 0)
    const binding = service.buildBinding(owner, prefab.id, revision.revision, { goal: 'grow' })
    const repo = createChannelAgentRepo(db)
    const member = repo.create({ channelId: channel.id, templateId: null, name: 'bound', harness: 'omp', config: {}, role: 'worker', prefabBindingJson: JSON.stringify(binding) })
    assert.equal(resolveRuntimeForAgent(db, member.id)?.resolution.prompt.slots.find(s => s.key === 'policy')?.text, 'fixed')

    for (const [value, error] of [
      [' \t ', /绑定格式非法/],
      ['null', /绑定格式非法/],
      [JSON.stringify({ ...binding, revision: revision.revision + 1 }), /快照缺失/],
      [JSON.stringify({ ...binding, contentHash: '0'.repeat(64) }), /contentHash/],
      [JSON.stringify({ ...binding, slotValues: { goal: 'grow', unknown: 'value' } }), /未声明的 slot/],
      [JSON.stringify({ ...binding, slotValues: JSON.parse('{"goal":"grow","__proto__":"unknown"}') }), /未声明的 slot/],
      [JSON.stringify({ ...binding, slotValues: {} }), /goal.*必填/],
      [JSON.stringify({ ...binding, slotValues: { goal: 'longer' } }), /goal.*长度/],
      [JSON.stringify({ ...binding, slotValues: { goal: 'grow', policy: 'changed' } }), /policy.*不允许/],
    ] as const) {
      repo.update(member.id, { prefabBindingJson: value })
      const runtime = resolveRuntimeForAgent(db, member.id)!
      assert.equal(runtime.resolution.mode, 'prefab', value)
      assert.deepEqual(runtime.resolution.toolIds, [], value)
      assert.deepEqual(runtime.resolution.skillIds, [], value)
      assert.equal(prefabAllowsTool(runtime.resolution, 'send_message_to_agent'), false, value)
      assert.ok(prefabBlockedReason(runtime.resolution), value)
      assert.match(runtime.resolution.reasons.__prefab__ ?? runtime.resolution.slotErrors[0] ?? '', error)
    }
  }
  finally {
    db.close()
  }
})

test('registry publishes full Skill hashes and MCP schema hashes as capability versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-prefab-versions-'))
  try {
    const skillHash = 'a'.repeat(64)
    const skillDir = join(root, 'skills', 'test-skill', skillHash)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify({ name: 'test-skill', contentHash: skillHash }))
    const manifest = newManifest({ id: 'test', label: 'Test', endpoint: 'https://example.com/mcp', dataSharing: 'shared-safe' })
    const inputSchema = { type: 'object' }
    const schemaHash = hashSchema(inputSchema)
    manifest.tools.push({ id: 'mcp_test_read', exposedName: 'mcp_test_read', serverId: manifest.id, upstreamName: 'read', description: '', inputSchema, schemaHash, reviewStatus: 'approved', classification: 'read' })
    writeManifest(root, manifest)

    const { registry } = buildCapabilityRegistry('', root)
    assert.equal(registry[`skill:test-skill@${skillHash.slice(0, 12)}`]?.version, skillHash)
    assert.equal(registry['skill:test-skill']?.version, skillHash)
    assert.equal(registry['mcp-tool:mcp_test_read']?.version, schemaHash)
    assert.equal(registry['tool:submit_task']?.version, undefined)
    assert.deepEqual(registry['tool:submit_task']?.roles, ['lead'])
  }
  finally {
    rmSync(root, { recursive: true, force: true })
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
