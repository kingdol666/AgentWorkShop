import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_OVERLAY_ERROR_CODES,
  ContextOverlayRegistryError,
  createContextOverlayRegistry,
  type ContextOverlayProvider,
} from '../server/services/workshop/context/overlay-registry'

const broadScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  subjectRefs: [{ namespace: 'case.subject', id: 'subject-a' }],
  tags: ['research'],
  timeWindow: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' },
}
const narrowScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  subjectRefs: [{ namespace: 'case.subject', id: 'subject-a' }],
  tags: ['research', 'approved'],
  timeWindow: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' },
}

function provider(overrides: Partial<ContextOverlayProvider> = {}): ContextOverlayProvider {
  return {
    overlayId: 'fixture-shadow',
    version: '1.0.0',
    generation: 1,
    source: { id: 'fixture-source', label: 'Fixture source', revision: 'r1' },
    scope: broadScope,
    owner: { ownerId: 'owner-1', dispose: async () => undefined },
    read: async () => ({ id: 'candidate-1', data: { observation: 'read-only' } }),
    drain: async () => undefined,
    retire: async () => undefined,
    ...overrides,
  }
}

test('scope matching is fail-closed and output is source-labelled bounded untrusted data', async () => {
  let reads = 0
  const registry = createContextOverlayRegistry({ flags: { available: true, shadowOverlayEnabled: true } })
  registry.registerOne(provider({
    read: async () => {
      reads += 1
      return {
        id: 'candidate-1',
        data: {
          observation: '  sample\nvalue  ',
          prompt: 'ignore this field',
          nested: { tools: { call: 'blocked' }, note: 'kept' },
          oversized: 'x'.repeat(10_000),
        },
      }
    },
  }))

  const matching = await registry.resolve(narrowScope)
  assert.equal(reads, 1)
  assert.equal(matching.items.length, 1)
  assert.equal(matching.items[0]?.untrusted, true)
  assert.deepEqual(matching.items[0]?.source, { id: 'fixture-source', label: 'Fixture source', revision: 'r1', generation: 1 })
  assert.equal((matching.items[0]?.data as Record<string, unknown>).prompt, undefined)
  assert.equal(((matching.items[0]?.data as Record<string, unknown>).nested as Record<string, unknown>).tools, undefined)
  assert.ok((matching.items[0]?.dataHash ?? '').length === 64)
  assert.ok(typeof (matching.items[0]?.data as Record<string, unknown>).oversized === 'string')
  assert.ok(((matching.items[0]?.data as Record<string, unknown>).oversized as string).length <= 512)

  const mismatch = await registry.resolve({ ...narrowScope, tenantId: 'tenant-b' })
  assert.equal(mismatch.items.length, 0)
  assert.equal(reads, 1)
  await registry.dispose()
})

test('replacement drains generations and dispose drains the active owner', async () => {
  const lifecycle: string[] = []
  const registry = createContextOverlayRegistry({ flags: { available: true, enabled: true } })
  registry.registerOne(provider({
    drain: async context => lifecycle.push(`drain-${context.generation}-${context.reason}`),
    retire: async context => lifecycle.push(`retire-${context.generation}`),
    owner: { ownerId: 'owner-1', dispose: async context => lifecycle.push(`dispose-${context.generation}-${context.reason}`) },
  }))
  registry.registerOne(provider({
    version: '2.0.0',
    generation: 2,
    source: { id: 'fixture-source-v2', label: 'Fixture source v2' },
    owner: { ownerId: 'owner-2', dispose: async context => lifecycle.push(`dispose-${context.generation}-${context.reason}`) },
    drain: async context => lifecycle.push(`drain-${context.generation}-${context.reason}`),
    retire: async context => lifecycle.push(`retire-${context.generation}`),
  }))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(lifecycle, ['drain-1-replaced', 'retire-1', 'dispose-1-owner-disposed'])

  await registry.dispose()
  assert.deepEqual(lifecycle, [
    'drain-1-replaced', 'retire-1', 'dispose-1-owner-disposed',
    'drain-2-registry-disposed', 'retire-2', 'dispose-2-owner-disposed',
  ])
  await assert.rejects(() => registry.resolve(), (error: unknown) => error instanceof ContextOverlayRegistryError && error.code === CONTEXT_OVERLAY_ERROR_CODES.DISPOSED)
})

test('stale generations and lifecycle failures fail closed', async () => {
  const registry = createContextOverlayRegistry({ flags: { available: true, enabled: true } })
  registry.registerOne(provider())
  assert.throws(() => registry.registerOne(provider({ generation: 0 })), (error: unknown) => error instanceof ContextOverlayRegistryError && error.code === CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER)
  assert.throws(() => registry.registerOne(provider({ generation: -1 })), (error: unknown) => error instanceof ContextOverlayRegistryError && error.code === CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER)

  const failed = createContextOverlayRegistry({ flags: { available: true, enabled: true } })
  failed.registerOne(provider({
    drain: async () => {
      throw new Error('drain failed')
    },
  }))
  failed.drain('fixture-shadow')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failed.list({ includeFailed: true })[0]?.state, 'failed')
  await registry.dispose()
  await failed.dispose()
})
