import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createSessionRuntimeOverrideRepo } from '../server/services/workshop/db/session-runtime.repo'
import { createAgentPrefabService } from '../server/services/workshop/agent-prefabs/service'
import { createSessionRuntimeService } from '../server/services/workshop/sessions/runtime-service'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'
import type { HarnessCatalog } from '../server/services/workshop/agents/harness-models'

process.env.AGENTWORKSHOP_TEST = '1'

const catalog: HarnessCatalog = {
  providers: [
    { id: 'local', models: [
      { id: 'google/gemma-4-12b-qat', efforts: ['low', 'medium', 'high'] },
      { id: 'qwen3.5-9b', efforts: ['low', 'medium', 'high'] },
    ] },
    { id: 'cloud', models: [{ id: 'deepseek-flash', efforts: ['low', 'max'] }] },
  ],
  effortMode: 'levels',
}

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: 'runtime-service', ownerUserId: 'owner' })
  const base = agents.create({
    channelId: channel.id, templateId: null, name: '基础主管', harness: 'omp', role: 'lead',
    config: { provider: 'local', model: 'google/gemma-4-12b-qat', effort: 'low', systemPromptPrefix: 'base prompt' },
  })
  const first = agents.create({
    channelId: channel.id, templateId: null, name: '基础主管·session·1', harness: 'omp', role: 'worker',
    config: { provider: 'local', model: 'google/gemma-4-12b-qat', effort: 'low', systemPromptPrefix: 'base prompt' },
  })
  const second = agents.create({
    channelId: channel.id, templateId: null, name: '基础主管·session·2', harness: 'omp', role: 'worker',
    config: { provider: 'local', model: 'google/gemma-4-12b-qat', effort: 'low', systemPromptPrefix: 'base prompt' },
  })
  const session = sessions.create({ channelId: channel.id, title: '会话 A', memberMap: { [base.id]: first.id } })
  const other = sessions.create({ channelId: channel.id, title: '会话 B', memberMap: { [base.id]: second.id } })
  return { db, channel, agents, sessions, base, first, second, session, other }
}

test('session runtime service persists per-session overrides and reset without touching other sessions', async () => {
  const f = fixture()
  try {
    initToolRegistryDb(f.db)
    const service = createSessionRuntimeService(f.db, { catalog: async () => catalog })
    const before = service.get(f.channel.id, f.session.id, f.first.id)
    assert.equal(before.revision, 0)
    assert.equal(before.customized, false)
    assert.equal(before.effective.model, 'google/gemma-4-12b-qat')
    assert.equal(before.editableFields.includes('prefab'), true)

    const updated = await service.update({
      channelId: f.channel.id,
      sessionId: f.session.id,
      agentId: f.first.id,
      expectedRevision: 0,
      actor: { id: 'owner' },
      overrides: {
        model: 'qwen3.5-9b',
        effort: 'high',
        runtimePrompt: '本轮只看数据，不做设备写入。',
      },
    })
    assert.equal(updated.revision, 1)
    assert.equal(updated.customized, true)
    assert.equal(updated.effective.model, 'qwen3.5-9b')
    assert.equal(updated.effective.effort, 'high')
    assert.match(updated.effective.runtimePrompt ?? '', /只看数据/)

    const other = service.get(f.channel.id, f.other.id, f.second.id)
    assert.equal(other.revision, 0, 'editing one session must not touch another session runtime')
    assert.equal(other.effective.model, 'google/gemma-4-12b-qat')
    assert.equal(f.agents.findById(f.first.id)?.configJson, f.agents.findById(f.second.id)?.configJson)

    const reset = await service.update({
      channelId: f.channel.id,
      sessionId: f.session.id,
      agentId: f.first.id,
      expectedRevision: 1,
      actor: { id: 'owner' },
      reset: true,
    })
    assert.equal(reset.revision, 2)
    assert.equal(reset.customized, false)
    assert.equal(reset.effective.model, 'google/gemma-4-12b-qat')
    assert.equal(reset.effective.runtimePrompt, undefined)
  }
  finally {
    f.db.close()
  }
})

test('session runtime update CAS, ownership and managed guards fail closed', async () => {
  const f = fixture()
  try {
    initToolRegistryDb(f.db)
    const service = createSessionRuntimeService(f.db, { catalog: async () => catalog })
    await service.update({
      channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 0,
      actor: { id: 'owner' }, overrides: { effort: 'medium' },
    })
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { effort: 'high' },
      }),
      (err: { code?: string }) => err?.code === 'RUNTIME_REVISION_CONFLICT',
    )
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 1,
        actor: { id: 'owner' }, overrides: { command: 'evil' },
      }),
      (err: { code?: string }) => err?.code === 'RUNTIME_FIELD_FORBIDDEN',
    )
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 1,
        actor: { id: 'owner' }, overrides: { model: 'not-in-catalog' },
      }),
      (err: { code?: string }) => err?.code === 'RUNTIME_PROFILE_UNSUPPORTED',
    )
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: 'missing', expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { effort: 'low' },
      }),
      (err: { code?: string }) => err?.code === 'NOT_FOUND',
    )

    const task = f.sessions.create({
      channelId: f.channel.id, title: '任务会话', instanceKind: 'task',
      memberMap: { [f.base.id]: f.second.id },
    })
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: task.id, agentId: f.second.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { effort: 'low' },
      }),
      (err: { code?: string }) => err?.code === 'SESSION_MANAGED',
    )

    f.sessions.close(f.session.id)
    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 1,
        actor: { id: 'owner' }, overrides: { effort: 'low' },
      }),
      (err: { code?: string }) => err?.code === 'SESSION_NOT_ACTIVE',
    )
  }
  finally {
    f.db.close()
  }
})

test('session runtime prefab override validates revision and leaves clone/session snapshot untouched', async () => {
  const f = fixture()
  try {
    initToolRegistryDb(f.db)
    const prefabs = createAgentPrefabService(f.db)
    const draft = {
      name: '会话预制件',
      description: '',
      visibility: 'public' as const,
      prompt: { role: '只读分析', scenario: '', slots: [] },
      profile: { provider: 'local', model: 'qwen3.5-9b', effort: 'medium' },
      capabilities: [],
    }
    const prefab = prefabs.create({ id: 'owner' }, draft)
    const rev = prefabs.publish({ id: 'owner' }, prefab.id, 0)
    const service = createSessionRuntimeService(f.db, { catalog: async () => catalog })
    const cloneBefore = f.agents.findById(f.first.id)!
    const sessionBefore = f.sessions.findById(f.session.id)!

    const updated = await service.update({
      channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 0,
      actor: { id: 'owner' },
      overrides: { prefabBinding: { prefabId: prefab.id, revision: rev.revision, slotValues: {} } },
    })
    assert.equal(updated.effective.prefab?.prefabId, prefab.id)
    assert.equal(updated.effective.prefab?.revision, rev.revision)
    assert.equal(updated.effective.model, 'qwen3.5-9b')
    assert.equal(f.agents.findById(f.first.id)?.prefabBindingJson, cloneBefore.prefabBindingJson)
    assert.equal(f.sessions.findById(f.session.id)?.prefabSnapshotJson, sessionBefore.prefabSnapshotJson)
    assert.equal(f.sessions.findById(f.session.id)?.prefabSnapshotHash, sessionBefore.prefabSnapshotHash)

    await assert.rejects(
      service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.first.id, expectedRevision: 1,
        actor: { id: 'owner' },
        overrides: { prefabBinding: { prefabId: prefab.id, revision: 99, slotValues: {} } },
      }),
      (err: { code?: string }) => err?.code === 'PREFAB_REVISION_NOT_FOUND',
    )
    // 校验失败不落库、不加 revision、不写坏 binding
    const row = createSessionRuntimeOverrideRepo(f.db).get(f.session.id, f.first.id)
    assert.equal(row?.revision, 1)
    assert.equal(JSON.parse(row!.overridesJson).prefabBinding.revision, rev.revision)
  }
  finally {
    f.db.close()
  }
})
