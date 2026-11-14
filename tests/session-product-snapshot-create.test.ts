import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { canonicalHash } from '../shared/context/hash'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-session-snapshot-create-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createChannelProductBindingRepo } = await import('../server/services/workshop/db/channel-product-binding.repo')
const { createChannelSession } = await import('../server/services/workshop/agents/session-clone')
const { createChannelSessionBindingSnapshot } = await import('../server/services/workshop/agents/session-snapshot')

test('session creation requires a currently bound product and freezes its canonical binding snapshot', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channel = createChannelRepo(db).create({ name: 'Snapshot channel' })
    const agentRepo = createChannelAgentRepo(db)
    const lead = agentRepo.create({ channelId: channel.id, templateId: null, name: 'Lead', harness: 'mock', role: 'lead' })
    const bindingRepo = createChannelProductBindingRepo(db)
    const revision = bindingRepo.replaceForChannel(channel.id, ['product-a', 'product-b'], 0).revision
    const sessions = createChannelSessionRepo(db)
    const resolveProduct = (id: string) => id === 'product-a'
      ? { id, lineId: 'line-a', name: 'A' }
      : id === 'product-b' ? { id, lineId: 'line-a', name: 'B' } : undefined
    const recipesForProduct = (id: string) => id === 'product-a'
      ? [{ id: 'recipe-a', productId: id, lineId: 'line-a', version: 2, params: [{ nodeId: 'node-a', value: 1 }], daqWindows: [] }]
      : [{ id: 'recipe-b', productId: id, lineId: 'line-a', version: 1, params: [], daqWindows: [] }]
    const snapshotFor = (productId: string) => {
      const product = resolveProduct(productId)
      if (!product) throw new Error('SESSION_PRODUCT_NOT_FOUND')
      return createChannelSessionBindingSnapshot({
        channelId: channel.id,
        selectedProductId: product.id,
        lineId: product.lineId,
        bindingRevision: bindingRepo.getRevision(channel.id),
        boundProductIds: bindingRepo.listByChannel(channel.id).map(row => row.productId),
        recipes: recipesForProduct(productId),
        agentBindings: [{ agentId: lead.id, bindings: [{ nodeId: 'node-a', kind: 'daq', mode: 'auto' }] }],
        executionProfile: { mode: 'manual' },
      })
    }
    assert.throws(() => snapshotFor('unbound-product'), /SESSION_PRODUCT_NOT_BOUND|SESSION_PRODUCT_NOT_FOUND/)

    const bindingSnapshot = snapshotFor('product-a')
    const created = createChannelSession({
      channelAgents: agentRepo,
      tasks: { list: () => [], cancelTree: () => [] },
      bindings: { byAgent: () => [{ nodeId: 'node-a', kind: 'daq', mode: 'auto' }], bind: () => undefined },
      unloadAgent: async () => undefined,
    }, {
      channelId: channel.id,
      actorId: 'owner',
      productId: 'product-a',
      lineId: 'line-a',
      bindingSnapshot,
      sessionRepo: sessions,
    })
    const first = sessions.findById(created.sessionId)!
    assert.equal(first.productId, 'product-a')
    assert.equal(first.lineId, 'line-a')
    assert.equal(first.bindingSnapshotRevision, revision)
    assert.equal(first.bindingSnapshotHash, canonicalHash(JSON.parse(first.bindingSnapshotJson)))
    const snapshot = JSON.parse(first.bindingSnapshotJson)
    assert.equal(snapshot.productId, 'product-a')
    assert.equal(snapshot.lineId, 'line-a')
    assert.equal(snapshot.recipes[0].id, 'recipe-a')
    assert.equal(snapshot.agentBindings[0].bindings[0].nodeId, 'node-a')
    assert.deepEqual(snapshot.executionProfile, { mode: 'manual' })

    bindingRepo.replaceForChannel(channel.id, ['product-b'], revision)
    const after = sessions.findById(created.sessionId)!
    assert.equal(after.productId, 'product-a')
    assert.equal(after.bindingSnapshotJson, first.bindingSnapshotJson)
    assert.equal(after.bindingSnapshotHash, first.bindingSnapshotHash)
  }
  finally { db.close() }
})
