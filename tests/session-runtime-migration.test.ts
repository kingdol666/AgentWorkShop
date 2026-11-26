import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createSessionRuntimeOverrideRepo } from '../server/services/workshop/db/session-runtime.repo'
import { migrateSessionRuntimeOverrides } from '../server/services/workshop/db/database/migrations-session-runtime'

process.env.AGENTWORKSHOP_TEST = '1'

test('session runtime migration is idempotent and deleting the session cascades overrides', (t) => {
  const db = openWorkshopDb(':memory:')
  t.after(() => db.close())
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const channel = channels.create({ name: 'runtime-cascade', ownerUserId: 'owner' })
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead', config: {} })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'mock', role: 'worker', config: {} })
  const session = sessions.create({ channelId: channel.id, title: 'A', memberMap: { [base.id]: clone.id } })
  const repo = createSessionRuntimeOverrideRepo(db)
  assert.equal(repo.save({
    sessionId: session.id, agentId: clone.id, expectedRevision: 0,
    overridesJson: JSON.stringify({ runtimePrompt: 'x' }), updatedBy: 'owner',
  }), true)
  assert.ok(repo.get(session.id, clone.id))

  // 第二次执行迁移不得破坏已有数据
  migrateSessionRuntimeOverrides(db)
  assert.ok(repo.get(session.id, clone.id))

  sessions.remove(session.id)
  assert.equal(repo.get(session.id, clone.id), undefined, 'session FK cascade must remove runtime overrides')
})
