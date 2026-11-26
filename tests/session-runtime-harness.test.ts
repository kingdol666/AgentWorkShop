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
import { AppError } from '../server/utils/errors'
import type { HarnessCatalog } from '../server/services/workshop/agents/harness-models'

process.env.AGENTWORKSHOP_TEST = '1'

const catalogs: Record<string, HarnessCatalog> = {
  omp: {
    providers: [{ id: 'local', models: [{ id: 'gemma', efforts: ['low', 'high'] }] }],
    effortMode: 'levels',
  },
  codex: {
    providers: [{ id: 'default', models: [{ id: 'gpt-5', efforts: ['low', 'high'] }] }],
    effortMode: 'levels',
  },
  mock: { providers: [], effortMode: 'unsupported' },
}

function fixture(prepare?: (db: ReturnType<typeof openWorkshopDb>) => string | undefined) {
  const db = openWorkshopDb(':memory:')
  initToolRegistryDb(db)
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: 'harness-service', ownerUserId: 'owner' })
  const prefabBindingJson = prepare?.(db)
  const base = agents.create({
    channelId: channel.id, templateId: null, name: '主管', harness: 'omp', role: 'lead',
    config: { provider: 'local', model: 'gemma', effort: 'low' },
  })
  const clone = agents.create({
    channelId: channel.id, templateId: null, name: '主管·session·1', harness: 'omp', role: 'worker',
    config: { provider: 'local', model: 'gemma', effort: 'low' },
    prefabBindingJson,
  })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  const service = createSessionRuntimeService(db, {
    catalog: async (harness) => {
      if (harness === 'opencode') throw new Error('catalog down')
      return catalogs[harness] ?? { providers: [], effortMode: 'unsupported' }
    },
    harnessUsable: (harness) => {
      if (harness === 'nope') throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${harness}`)
      if (harness === 'unavailable') throw new AppError(409, 'HARNESS_UNAVAILABLE', `${harness} 未安装`)
    },
  })
  return { db, channels, agents, sessions, channel, base, clone, session, service }
}

test('harness change with an inherited selector the target cannot use is rejected before write', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { harness: 'codex' },
      }),
      (err: { code?: string }) => err?.code === 'RUNTIME_PROFILE_UNSUPPORTED',
    )
    assert.equal(createSessionRuntimeOverrideRepo(f.db).get(f.session.id, f.clone.id)?.revision ?? 0, 0)
  }
  finally {
    f.db.close()
  }
})

test('harness change with explicit suppression clears inherited provider/model and persists', async () => {
  const f = fixture()
  try {
    const view = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
      actor: { id: 'owner' }, overrides: { harness: 'codex', provider: '', model: '', effort: '' },
    })
    assert.equal(view.harness, 'codex')
    assert.equal(view.baseHarness, 'omp')
    assert.equal(view.effective.provider, undefined)
    assert.equal(view.effective.model, undefined)
    assert.equal(view.effective.effort, undefined)
    assert.equal(view.revision, 1)
    assert.equal(view.customized, true)
    assert.equal(view.editableFields.includes('harness'), true)
    assert.deepEqual(view.profileSupport, { provider: false, model: true, effort: true })
    assert.deepEqual(view.overrides, { harness: 'codex', provider: '', model: '', effort: '' })
    assert.equal(f.agents.findById(f.clone.id)?.harness, 'omp', 'clone row must not change')
  }
  finally {
    f.db.close()
  }
})

test('explicit model for the target harness is accepted and effective', async () => {
  const f = fixture()
  try {
    const view = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
      actor: { id: 'owner' },
      overrides: { harness: 'codex', provider: '', model: 'gpt-5', effort: 'high' },
    })
    assert.equal(view.harness, 'codex')
    assert.equal(view.effective.model, 'gpt-5')
    assert.equal(view.effective.effort, 'high')
  }
  finally {
    f.db.close()
  }
})

test('unknown and unavailable harness fail closed with actionable codes', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { harness: 'nope' },
      }),
      (err: { code?: string }) => err?.code === 'UNKNOWN_HARNESS',
    )
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { harness: 'unavailable' },
      }),
      (err: { code?: string }) => err?.code === 'HARNESS_UNAVAILABLE',
    )
  }
  finally {
    f.db.close()
  }
})

test('catalog failure for the target harness refuses the write', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
        actor: { id: 'owner' }, overrides: { harness: 'opencode' },
      }),
      (err: { code?: string }) => err?.code === 'HARNESS_CATALOG_UNAVAILABLE',
    )
    assert.equal(createSessionRuntimeOverrideRepo(f.db).get(f.session.id, f.clone.id)?.revision ?? 0, 0)
  }
  finally {
    f.db.close()
  }
})

test('a prefab profile pinned to the old harness blocks the harness switch', async () => {
  const f = fixture((db) => {
    const prefabs = createAgentPrefabService(db)
    const prefab = prefabs.create({ id: 'owner' }, {
      name: 'omp-only', description: '', visibility: 'public' as const,
      prompt: { role: 'r', scenario: '', slots: [] },
      profile: { provider: 'local', model: 'gemma' },
      capabilities: [],
    })
    const rev = prefabs.publish({ id: 'owner' }, prefab.id, 0)
    return JSON.stringify(prefabs.buildBinding({ id: 'owner' }, prefab.id, rev.revision, {}))
  })
  try {
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, agentId: f.clone.id, expectedRevision: 0,
        actor: { id: 'owner' },
        overrides: { harness: 'codex', provider: '', model: '', effort: '' },
      }),
      (err: { code?: string }) => err?.code === 'PREFAB_PROFILE_UNSUPPORTED',
    )
    assert.equal(createSessionRuntimeOverrideRepo(f.db).get(f.session.id, f.clone.id)?.revision ?? 0, 0)
  }
  finally {
    f.db.close()
  }
})
