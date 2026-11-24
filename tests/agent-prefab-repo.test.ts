/**
 * AgentPrefab 仓储回归：不可变发布、head CAS、草稿 CAS、可见性、schema 契约版本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { migratePrefabColumns } from '../server/services/workshop/db/database/migrations-prefab'
import { createAgentPrefabRepo } from '../server/services/workshop/db/agent-prefab.repo'
import type { AgentPrefabDraft } from '../server/services/workshop/agent-prefabs/types'

function draft(name: string, extra: Partial<AgentPrefabDraft> = {}): AgentPrefabDraft {
  return {
    name,
    description: '',
    visibility: 'private',
    prompt: { role: 'role', scenario: 'scenario', slots: [] },
    profile: {},
    capabilities: [],
    ...extra,
  }
}

test('published revisions are immutable and head CAS prevents concurrent publish', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createAgentPrefabRepo(db)
    const row = repo.create({ name: 'P', ownerUserId: 'u1', draft: draft('P') })
    const first = repo.publish(row.id, 0, draft('P'), 'u1')
    assert.equal(first.revision, 1)
    assert.match(first.contentHash, /^[a-f0-9]{64}$/)

    // 同一 expectedHead 再次发布 → 冲突，且不产生 revision 2
    assert.throws(
      () => repo.publish(row.id, 0, draft('P2'), 'u1'),
      (err: { code?: string }) => err.code === 'PREFAB_REVISION_CONFLICT',
    )
    assert.equal(repo.listRevisions(row.id).length, 1)
    assert.deepEqual(JSON.parse(repo.findRevision(row.id, 1)!.snapshotJson).draft.prompt.role, 'role')

    const second = repo.publish(row.id, 1, draft('P2'), 'u1')
    assert.equal(second.revision, 2)
    assert.notEqual(second.contentHash, first.contentHash)
    assert.equal(repo.findById(row.id)!.headRevision, 2)
  }
  finally {
    db.close()
  }
})

test('draft update uses expectedUpdatedAt CAS and visibility lists privately', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createAgentPrefabRepo(db)
    const row = repo.create({ name: 'Mine', ownerUserId: 'u1', draft: draft('Mine') })
    const updated = repo.updateDraft(row.id, row.updatedAt, { draft: draft('Mine2'), name: 'Mine2' })
    assert.equal(updated.name, 'Mine2')
    assert.throws(
      () => repo.updateDraft(row.id, row.updatedAt, { draft: draft('Stale') }),
      (err: { code?: string }) => err.code === 'PREFAB_EDIT_CONFLICT',
    )
    assert.equal(repo.listVisible('u1').length, 1)
    assert.equal(repo.listVisible('u2').length, 0)
  }
  finally {
    db.close()
  }
})

test('existing prefab rows survive the additive archive migration', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createAgentPrefabRepo(db)
    const row = repo.create({ name: 'Existing', ownerUserId: 'u1', draft: draft('Existing') })
    const revision = repo.publish(row.id, 0, draft('Existing'), 'u1')
    db.exec('ALTER TABLE agent_prefabs DROP COLUMN archived_at')
    migratePrefabColumns(db)
    migratePrefabColumns(db)
    const next = createAgentPrefabRepo(db)
    assert.equal(next.findById(row.id)?.archivedAt, null)
    assert.deepEqual({ ...next.findRevision(row.id, 1) }, revision)
    assert.equal(next.listVisible('u1')[0]?.id, row.id)
  }
  finally {
    db.close()
  }
})

test('channel member prefab binding uses SQLite CAS and never replaces an existing bind', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
    const { createChannelAgentRepo, prefabBindingVersionOf } = await import('../server/services/workshop/db/channel-agent.repo')
    const channels = createChannelRepo(db)
    const channelAgents = createChannelAgentRepo(db)
    const channel = channels.create({ name: 'C', ownerUserId: 'u1' })
    const member = channelAgents.create({ channelId: channel.id, templateId: null, name: 'w', harness: 'mock', role: 'worker' })
    const prefabs = createAgentPrefabRepo(db)
    const prefab = prefabs.create({ name: 'Expert', ownerUserId: 'u1', draft: draft('Expert') })
    const rev = prefabs.publish(prefab.id, 0, draft('Expert'), 'u1')
    const binding = JSON.stringify({ prefabId: prefab.id, revision: 1, slotValues: {}, contentHash: rev.contentHash })
    const bound = channelAgents.setPrefabBinding(channel.id, member.id, binding)
    const version = prefabBindingVersionOf(bound.prefabBindingJson)
    assert.match(version ?? '', /^[0-9a-f-]{36}$/)
    assert.throws(() => channelAgents.setPrefabBinding(channel.id, member.id, binding), { code: 'PREFAB_ALREADY_BOUND' })
    assert.throws(() => channelAgents.setPrefabBinding(channel.id, member.id, '', 'stale'), { code: 'PREFAB_BINDING_CHANGED' })
    assert.equal(channelAgents.findById(member.id)?.prefabBindingJson, bound.prefabBindingJson)
    const cleared = channelAgents.setPrefabBinding(channel.id, member.id, '', version!)
    assert.equal(cleared.prefabBindingJson, '')
  }
  finally {
    db.close()
  }
})

test('migration adds prefab columns/tables without backfilling grants', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const ledger = db.prepare('SELECT MAX(version) AS v FROM aw_migration_ledger').get() as { v: number }
    assert.ok(ledger.v >= 8)
    const prefab = db.prepare('SELECT COUNT(*) AS n FROM agent_prefabs').get() as { n: number }
    assert.equal(prefab.n, 0)
    const cols = db.prepare('PRAGMA table_info(channel_agents)').all() as Array<{ name: string }>
    assert.ok(cols.some(c => c.name === 'prefab_binding_json'))
    const workCols = db.prepare('PRAGMA table_info(project_work_items)').all() as Array<{ name: string }>
    assert.ok(workCols.some(c => c.name === 'prefab_snapshot_json'))
    assert.ok(workCols.some(c => c.name === 'prefab_snapshot_hash'))
    const sessionCols = db.prepare('PRAGMA table_info(channel_sessions)').all() as Array<{ name: string }>
    assert.ok(sessionCols.some(c => c.name === 'prefab_snapshot_json'))
  }
  finally {
    db.close()
  }
})
