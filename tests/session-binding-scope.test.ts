import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createChannelProductBindingRepo } from '../server/services/workshop/db/channel-product-binding.repo'
import { createSessionBindingOverrideRepo } from '../server/services/workshop/db/session-binding.repo'
import { createChannelSessionBindingSnapshot, resolveTrustedSessionBinding } from '../server/services/workshop/agents/session-snapshot'
import { createSessionBindingService, type SessionBindingCatalog } from '../server/services/workshop/sessions/session-binding-service'
import type { ProductView, RecipeView } from '../shared/dcw-protocol'

process.env.AGENTWORKSHOP_TEST = '1'

function makeCatalog(): { catalog: SessionBindingCatalog, recipes: RecipeView[] } {
  const products = [
    { id: 'pd-1', name: '产品一', lineId: 'ln-1', description: '', createdAt: '' },
    { id: 'pd-2', name: '产品二', lineId: 'ln-1', description: '', createdAt: '' },
  ] as unknown as ProductView[]
  const recipes = [
    { id: 'rc-1', productId: 'pd-1', lineId: 'ln-1', name: '配方一', version: 1, params: [], daqWindows: [] },
    { id: 'rc-2', productId: 'pd-1', lineId: 'ln-1', name: '配方二', version: 2, params: [], daqWindows: [] },
    { id: 'rc-3', productId: 'pd-2', lineId: 'ln-1', name: '配方三', version: 1, params: [], daqWindows: [] },
  ] as unknown as RecipeView[]
  return {
    recipes,
    catalog: {
      allProducts: () => products,
      productById: id => products.find(p => p.id === id),
      allRecipes: () => recipes,
      recipeById: id => recipes.find(r => r.id === id),
    },
  }
}

function fixture() {
  const { catalog, recipes } = makeCatalog()
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const channel = channels.create({ name: 'scope', ownerUserId: 'owner' })
  channels.setLine(channel.id, 'ln-1')
  createChannelProductBindingRepo(db).replaceForChannel(channel.id, ['pd-1', 'pd-2'], 0)
  const agents = createChannelAgentRepo(db)
  const base = agents.create({ channelId: channel.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead', config: {} })
  const clone = agents.create({ channelId: channel.id, templateId: null, name: 'lead·session·1', harness: 'mock', role: 'worker', config: {} })
  const snapshot = createChannelSessionBindingSnapshot({
    channelId: channel.id,
    selectedProductId: 'pd-1',
    lineId: 'ln-1',
    bindingRevision: 1,
    boundProductIds: ['pd-1', 'pd-2'],
    recipes: recipes.filter(r => r.productId === 'pd-1').map(r => ({ id: r.id, productId: r.productId, lineId: r.lineId, version: r.version, params: r.params, daqWindows: r.daqWindows })),
    agentBindings: [],
    executionProfile: { mode: 'manual' },
  })
  const sessions = createChannelSessionRepo(db)
  const session = sessions.create({
    channelId: channel.id,
    title: 'scoped',
    memberMap: { [base.id]: clone.id },
    channelMode: 'production_line_integrated',
    productId: 'pd-1',
    lineId: 'ln-1',
    bindingSnapshotJson: snapshot.json,
    bindingSnapshotHash: snapshot.hash,
    bindingSnapshotRevision: snapshot.revision,
  })
  const service = createSessionBindingService(db, { catalog })
  return { db, channel, session, service, catalog, recipes }
}

test('session binding scope update writes an override and resolves live recipes', async () => {
  const f = fixture()
  try {
    const before = f.service.get(f.channel.id, f.session.id)
    assert.equal(before.source, 'snapshot')
    assert.equal(before.mutable, false)
    assert.deepEqual(before.recipes.map(r => r.id), ['rc-1', 'rc-2'])
    assert.equal(before.revision, 1)
    assert.equal(before.overrideRevision, 0)

    const updated = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
      expectedRevision: 0, productId: 'pd-1', recipeIds: ['rc-2'],
    })
    assert.equal(updated.revision, 1)
    assert.equal(updated.overrideRevision, 1)
    assert.equal(updated.source, 'override')
    assert.equal(updated.mutable, true)
    assert.deepEqual(updated.recipes.map(r => r.id), ['rc-2'])
    assert.ok(createSessionBindingOverrideRepo(f.db).get(f.session.id))

    const switched = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
      expectedRevision: 1, productId: 'pd-2', recipeIds: ['rc-3'],
    })
    assert.equal(switched.revision, 2)
    assert.equal(switched.productId, 'pd-2')
    assert.deepEqual(switched.recipes.map(r => r.id), ['rc-3'])

    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
        expectedRevision: 1, productId: 'pd-1',
      }),
      (err: { code?: string }) => err?.code === 'SESSION_BINDING_REVISION_CONFLICT',
    )
  }
  finally {
    f.db.close()
  }
})

test('session binding scope validates product/recipe ownership and supports reset', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
        expectedRevision: 0, productId: 'pd-x',
      }),
      (err: { code?: string }) => err?.code === 'SESSION_PRODUCT_NOT_BOUND',
    )
    await assert.rejects(
      f.service.update({
        channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
        expectedRevision: 0, productId: 'pd-1', recipeIds: ['rc-3'],
      }),
      (err: { code?: string }) => err?.code === 'SESSION_RECIPE_SCOPE_MISMATCH',
    )
    const saved = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
      expectedRevision: 0, productId: 'pd-1',
    })
    assert.equal(saved.revision, 1)
    const reset = await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
      expectedRevision: 1, reset: true,
    })
    // 回到创建快照：revision 是快照 revision（1），不是 0
    assert.equal(reset.revision, 1)
    assert.equal(reset.overrideRevision, 0)
    assert.equal(reset.source, 'snapshot')
    assert.equal(reset.mutable, false)
    assert.deepEqual(reset.recipes.map(r => r.id), ['rc-1', 'rc-2'])
  }
  finally {
    f.db.close()
  }
})

test('resolver follows live recipe versions and fingerprints the effective scope', async () => {
  const f = fixture()
  try {
    await f.service.update({
      channelId: f.channel.id, sessionId: f.session.id, actor: { id: 'owner', role: 'admin' },
      expectedRevision: 0, productId: 'pd-1', recipeIds: ['rc-1', 'rc-2'],
    })
    const lookup = (id: string) => f.catalog.recipeById(id)
    const before = resolveTrustedSessionBinding(f.db, f.session, { recipeLookup: lookup })!
    assert.equal(before.mutable, true)
    const beforeFingerprint = before.fingerprint

    const recipe = f.recipes.find(r => r.id === 'rc-1')!
    recipe.version = 9
    recipe.params = [{ nodeId: 'dcw-1', value: 1 }] as never
    const after = resolveTrustedSessionBinding(f.db, f.session, { recipeLookup: lookup })!
    assert.equal(after.recipes.find(r => r.id === 'rc-1')?.version, 9)
    assert.notEqual(after.fingerprint, beforeFingerprint)

    // 删除一个 recipe → 覆盖范围自动收缩（不阻断其余）
    const index = f.recipes.findIndex(r => r.id === 'rc-2')
    f.recipes.splice(index, 1)
    const shrunk = resolveTrustedSessionBinding(f.db, f.session, { recipeLookup: lookup })!
    assert.deepEqual(shrunk.recipes.map(r => r.id), ['rc-1'])
  }
  finally {
    f.db.close()
  }
})
