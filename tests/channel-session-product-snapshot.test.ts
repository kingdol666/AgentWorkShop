import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-session-product-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { migrateSessionContextColumns } = await import('../server/services/workshop/db/database/migrations-session')

test('channel session persists selected product and immutable binding snapshot', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const sessions = createChannelSessionRepo(db)
    const bindingSnapshot = {
      productId: 'product-picked',
      lineId: 'line-bound',
      bindings: [{ nodeId: 'pressure', kind: 'dcw' }],
    }
    const snapshotInput = {
      productId: bindingSnapshot.productId,
      lineId: bindingSnapshot.lineId,
      bindingSnapshotJson: JSON.stringify(bindingSnapshot),
      bindingSnapshotHash: 'sha256:binding-snapshot-v1',
      bindingSnapshotRevision: 7,
    }
    const created = sessions.create({
      channelId: 'channel-1',
      title: 'Selected product session',
      memberMap: { 'agent-template': 'agent-instance' },
      ...snapshotInput,
    })
    const read = sessions.findById(created.id)

    assert.ok(read, 'created session can be read back')
    assert.deepEqual({
      productId: read.productId,
      lineId: read.lineId,
      bindingSnapshotJson: read.bindingSnapshotJson,
      bindingSnapshotHash: read.bindingSnapshotHash,
      bindingSnapshotRevision: read.bindingSnapshotRevision,
    }, snapshotInput)
    assert.equal(sessions.updateBrief(created.id, { summary: 'Session summary', briefJson: '{"summary":"Session summary"}' }), true)
    const afterBriefUpdate = sessions.findById(created.id)!
    assert.deepEqual({
      productId: afterBriefUpdate.productId,
      lineId: afterBriefUpdate.lineId,
      bindingSnapshotJson: afterBriefUpdate.bindingSnapshotJson,
      bindingSnapshotHash: afterBriefUpdate.bindingSnapshotHash,
      bindingSnapshotRevision: afterBriefUpdate.bindingSnapshotRevision,
    }, snapshotInput, 'brief updates do not mutate the captured binding snapshot')
  }
  finally {
    db.close()
  }
})

test('legacy channel session rows survive snapshot migration with empty defaults', () => {
  const db = openWorkshopDb(':memory:')
  try {
    db.exec(`DROP TABLE channel_sessions;
      CREATE TABLE channel_sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        memory_policy TEXT NOT NULL DEFAULT 'session',
        member_map_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        project_id TEXT,
        project_work_item_id TEXT,
        created_by_kind TEXT NOT NULL DEFAULT 'user',
        instance_kind TEXT NOT NULL DEFAULT 'manual',
        summary TEXT NOT NULL DEFAULT '',
        brief_json TEXT NOT NULL DEFAULT '{}',
        last_active_at TEXT,
        generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO channel_sessions (id, channel_id, title, created_at)
      VALUES ('cs-legacy', 'channel-legacy', 'Legacy session', '2026-11-13T00:00:00.000Z');`)

    migrateSessionContextColumns(db)
    migrateSessionContextColumns(db)

    const legacy = createChannelSessionRepo(db).findById('cs-legacy')
    assert.ok(legacy, 'legacy row remains readable after migration')
    assert.equal(legacy.productId, null)
    assert.equal(legacy.lineId, null)
    assert.equal(legacy.bindingSnapshotJson, '')
    assert.equal(legacy.bindingSnapshotHash, '')
    assert.equal(legacy.bindingSnapshotRevision, 0)
  }
  finally {
    db.close()
  }
})
