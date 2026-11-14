import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-product-bindings-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')

type ChannelProductBindingRepo = {
  replaceForChannel(channelId: string, productIds: readonly string[], expectedRevision: number): { revision: number }
  listByChannel(channelId: string): Array<{ productId: string }>
  getRevision(channelId: string): number
}

const bindingRepoModulePath = '../server/services/workshop/db/channel-product-binding.repo'
const bindingRepoModule = await import(bindingRepoModulePath).catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error
  return undefined
}) as
| { createChannelProductBindingRepo?: (db: DatabaseSync) => ChannelProductBindingRepo }
| undefined

test('channel product bindings support multiple products and reject stale revisions', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const channel = channels.create({ name: 'Product bindings' })
    const otherChannel = channels.create({ name: 'Other channel' })

    const createRepo = bindingRepoModule?.createChannelProductBindingRepo
    assert.equal(typeof createRepo, 'function', 'channel-product-binding.repo must export createChannelProductBindingRepo')
    const repo = createRepo!(db)

    const initial = repo.replaceForChannel(channel.id, ['product-a', 'product-b', 'product-a'], 0)
    assert.equal(initial.revision, 1)
    assert.equal(repo.getRevision(channel.id), 1)
    assert.deepEqual(
      repo.listByChannel(channel.id).map(binding => binding.productId).sort(),
      ['product-a', 'product-b'],
    )
    const unchanged = repo.replaceForChannel(channel.id, ['product-b', 'product-a'], initial.revision)
    assert.equal(unchanged.revision, 2, 'replacing the same product set still advances the revision')
    assert.equal(repo.getRevision(channel.id), 2)

    const snapshot = {
      productId: 'product-a',
      lineId: 'line-1',
      bindingSnapshotJson: JSON.stringify({ productId: 'product-a', revision: initial.revision }),
      bindingSnapshotHash: 'sha256:product-a-revision-1',
      bindingSnapshotRevision: initial.revision,
    }
    const sessions = createChannelSessionRepo(db)
    const session = sessions.create({
      channelId: channel.id,
      title: 'Product binding snapshot',
      memberMap: {},
      ...snapshot,
    } as Parameters<typeof sessions.create>[0])

    repo.replaceForChannel(channel.id, ['product-b'], unchanged.revision)
    const persistedSession = sessions.findById(session.id) as (typeof session & typeof snapshot) | undefined
    assert.ok(persistedSession, 'created session can be read back')
    assert.deepEqual({
      productId: persistedSession.productId,
      lineId: persistedSession.lineId,
      bindingSnapshotJson: persistedSession.bindingSnapshotJson,
      bindingSnapshotHash: persistedSession.bindingSnapshotHash,
      bindingSnapshotRevision: persistedSession.bindingSnapshotRevision,
    }, snapshot, 'changing channel bindings must not alter a prior session snapshot')

    repo.replaceForChannel(otherChannel.id, ['product-c'], 0)
    assert.deepEqual(repo.listByChannel(otherChannel.id).map(binding => binding.productId), ['product-c'])
    assert.deepEqual(
      repo.listByChannel(channel.id).map(binding => binding.productId),
      ['product-b'],
    )

    assert.throws(
      () => repo.replaceForChannel(channel.id, ['product-stale'], 0),
      'a stale channel binding revision must be rejected',
    )
    assert.deepEqual(
      repo.listByChannel(channel.id).map(binding => binding.productId),
      ['product-b'],
      'a rejected stale write must leave the existing bindings unchanged',
    )

    const updated = repo.replaceForChannel(channel.id, ['product-c'], 3)
    assert.equal(updated.revision, 4)
    assert.deepEqual(repo.listByChannel(channel.id).map(binding => binding.productId), ['product-c'])
  }
  finally {
    db.close()
  }
})
