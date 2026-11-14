import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { register } from 'node:module'
import { createApp, createRouter, toWebHandler } from 'h3'

// The real route modules use Nuxt virtual imports; retain the H3 handler path with the repo test resolver.
register(new URL('../scripts/_audit/ts-resolve-hook.mjs', import.meta.url))

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-products-api-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelProductBindingRepo } = await import('../server/services/workshop/db/channel-product-binding.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { userRepository } = await import('../server/repositories/user.repository')
const { AppError } = await import('../server/utils/errors')
const { default: getProducts } = await import('../server/api/workshop/channels/[id]/products.get')
const { default: putProducts } = await import('../server/api/workshop/channels/[id]/products.put')

const db = openWorkshopDb(':memory:')
const channels = createChannelRepo(db)
const bindingRepo = createChannelProductBindingRepo(db)
const owner = userRepository.create({ name: 'product-owner', email: `product-owner-${process.pid}@test.local`, password: 'test-password-1', role: 'user', status: 'active' } as never)
const outsider = userRepository.create({ name: 'product-outsider', email: `product-outsider-${process.pid}@test.local`, password: 'test-password-1', role: 'user', status: 'active' } as never)
const ownerToken = userRepository.createToken(owner.id, 'products-test').raw
const outsiderToken = userRepository.createToken(outsider.id, 'products-test').raw
const channel = channels.create({ name: 'Products API', ownerUserId: owner.id })
const line = getDcwLineRepo().create({ name: 'Products API line' })
const otherLine = getDcwLineRepo().create({ name: 'Products API other line' })
const thirdLine = getDcwLineRepo().create({ name: 'Products API third line' })
const productA = getDcwProductRepo().create({ name: 'Product A', lineId: line.id })
const productB = getDcwProductRepo().create({ name: 'Product B', lineId: line.id })
const productOtherLine = getDcwProductRepo().create({ name: 'Other line product', lineId: otherLine.id })
const productThirdLine = getDcwProductRepo().create({ name: 'Third line product', lineId: thirdLine.id })
userRepository.setGrant(owner.id, line.id, 'readonly', null)
userRepository.setGrant(owner.id, thirdLine.id, 'readonly', null)

const manager = {
  deps: { db },
  getChannelForUser(channelId: string, userId: string) {
    const row = channels.findById(channelId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    if (row.ownerUserId !== userId) throw new AppError(403, 'SCOPE_VIOLATION', 'channel 不属于当前用户')
    return row
  },
  requireChannelOwner(channelId: string, user: { id: string, role?: string }) {
    const row = channels.findById(channelId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    if (user.role !== 'admin' && row.ownerUserId !== user.id) throw new AppError(403, 'FORBIDDEN', 'channel 不属于当前用户')
    return row
  },
}
;(globalThis as typeof globalThis & { __workshopManager?: unknown }).__workshopManager = manager

const app = createApp()
const router = createRouter()
router.get('/api/workshop/channels/:id/products', getProducts as never)
router.put('/api/workshop/channels/:id/products', putProducts as never)
app.use(router)
const web = toWebHandler(app)

async function request(path: string, method = 'GET', token = ownerToken, body?: unknown) {
  const res = await web(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }))
  return { status: res.status, body: await res.json() as { code: unknown, message: string, data: unknown } }
}

test('GET channel products requires visibility and includes the binding revision', async () => {
  bindingRepo.replaceForChannel(channel.id, [productA.id, productB.id], 0)
  const visible = await request(`/api/workshop/channels/${channel.id}/products`)
  assert.equal(visible.status, 200)
  assert.equal(visible.body.code, 0)
  assert.deepEqual(visible.body.data, { channelId: channel.id, productIds: [productA.id, productB.id].sort(), revision: 1 })

  const denied = await request(`/api/workshop/channels/${channel.id}/products`, 'GET', outsiderToken)
  assert.equal(denied.status, 403)
})

test('PUT channel products replaces all products for the owner', async () => {
  const result = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: [productB.id], expectedRevision: 1,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.code, 0)
  assert.deepEqual(result.body.data, { channelId: channel.id, productIds: [productB.id], revision: 2 })
})

test('PUT rejects unauthorized, missing, mixed-line, and stale product updates', async () => {
  const denied = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', outsiderToken, {
    productIds: [productA.id], expectedRevision: 2,
  })
  assert.equal(denied.status, 403)

  const missing = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: ['missing-product'], expectedRevision: 2,
  })
  assert.equal(missing.status, 404)

  const mixed = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: [productA.id, productThirdLine.id], expectedRevision: 2,
  })
  assert.equal(mixed.status, 400)

  const stale = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: [productA.id], expectedRevision: 1,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'CHANNEL_PRODUCT_BINDING_STALE')
  assert.deepEqual(bindingRepo.listByChannel(channel.id).map(row => row.productId), [productB.id])
})

test('PUT rejects a product whose line lacks readonly access and allows clearing bindings', async () => {
  const unauthorized = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: [productOtherLine.id], expectedRevision: 2,
  })
  assert.equal(unauthorized.status, 403)

  const empty = await request(`/api/workshop/channels/${channel.id}/products`, 'PUT', ownerToken, {
    productIds: [], expectedRevision: 2,
  })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.data, { channelId: channel.id, productIds: [], revision: 3 })
})

test('close database', () => db.close())
