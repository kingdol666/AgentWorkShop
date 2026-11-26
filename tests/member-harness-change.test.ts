import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createAgentPrefabService } from '../server/services/workshop/agent-prefabs/service'
import { assertProfileStructurallyValid } from '../server/services/workshop/agent-prefabs/profile'
import { validateMemberHarnessChange } from '../server/services/workshop/sessions/member-harness'
import { initToolRegistryDb } from '../server/services/workshop/db/tool-registry.repo'

process.env.AGENTWORKSHOP_TEST = '1'

test('structural profile validation accepts only selectors the harness can consume', () => {
  assert.throws(
    () => assertProfileStructurallyValid('codex', { provider: 'local' }),
    (err: { code?: string }) => err?.code === 'HARNESS_PROFILE_UNSUPPORTED',
  )
  assert.throws(
    () => assertProfileStructurallyValid('mock', { model: 'anything' }),
    (err: { code?: string }) => err?.code === 'HARNESS_PROFILE_UNSUPPORTED',
  )
  assert.doesNotThrow(() => assertProfileStructurallyValid('codex', { model: 'gpt-5', effort: 'high' }))
  assert.doesNotThrow(() => assertProfileStructurallyValid('omp', { provider: 'local', model: 'gemma', thinkingLevel: 'high' }))
  // 空串/空值不参与校验（UI 用空串表示“不指定”）。
  assert.doesNotThrow(() => assertProfileStructurallyValid('codex', { provider: '', model: '' }))
})

test('member harness change dry-runs the prefab profile before commit', () => {
  const db = openWorkshopDb(':memory:')
  try {
    initToolRegistryDb(db)
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'member-harness' })
    const agents = createChannelAgentRepo(db)
    const prefabs = createAgentPrefabService(db)
    const prefab = prefabs.create({ id: 'owner' }, {
      name: 'omp-only', description: '', visibility: 'public' as const,
      prompt: { role: 'r', scenario: '', slots: [] },
      profile: { provider: 'local', model: 'gemma' },
      capabilities: [],
    })
    const rev = prefabs.publish({ id: 'owner' }, prefab.id, 0)
    const binding = prefabs.buildBinding({ id: 'owner' }, prefab.id, rev.revision, {})
    const member = agents.create({
      channelId: channel.id, templateId: null, name: 'worker', harness: 'omp', role: 'worker',
      config: { provider: 'local', model: 'gemma' },
      prefabBindingJson: JSON.stringify(binding),
    })
    const row = agents.findById(member.id)!
    assert.throws(
      () => validateMemberHarnessChange(db, row, 'codex', { model: 'gpt-5' }),
      (err: { code?: string }) => err?.code === 'PREFAB_PROFILE_UNSUPPORTED',
    )
    // 同一 harness：不触发校验（避免无意义阻断）。
    assert.doesNotThrow(() => validateMemberHarnessChange(db, row, 'omp', { provider: 'local', model: 'gemma' }))
  }
  finally {
    db.close()
  }
})

test('member harness change rejects an incompatible own config', () => {
  const db = openWorkshopDb(':memory:')
  try {
    initToolRegistryDb(db)
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'member-harness-config' })
    const agents = createChannelAgentRepo(db)
    const member = agents.create({
      channelId: channel.id, templateId: null, name: 'worker', harness: 'omp', role: 'worker',
      config: { provider: 'local', model: 'gemma' },
    })
    const row = agents.findById(member.id)!
    assert.throws(
      () => validateMemberHarnessChange(db, row, 'codex', { provider: 'local', model: 'gemma' }),
      (err: { code?: string }) => err?.code === 'HARNESS_PROFILE_UNSUPPORTED',
    )
    assert.doesNotThrow(() => validateMemberHarnessChange(db, row, 'codex', { model: 'gpt-5' }))
  }
  finally {
    db.close()
  }
})
