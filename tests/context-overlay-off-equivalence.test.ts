import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalHash, canonicalJson } from '../shared/context/hash'
import {
  createContextOverlayRegistry,
  createEmptyContextOverlay,
  type ContextOverlayProvider,
} from '../server/services/workshop/context/overlay-registry'

const scope = { tenantId: 'tenant-a', workspaceId: 'workspace-a' }

function provider(read: ContextOverlayProvider['read']): ContextOverlayProvider {
  return {
    overlayId: 'fixture-shadow',
    version: '1.0.0',
    generation: 1,
    source: { id: 'fixture-source', label: 'Fixture source', revision: 'r1' },
    scope,
    owner: { ownerId: 'fixture-owner', dispose: async () => undefined },
    read,
    drain: async () => undefined,
    retire: async () => undefined,
  }
}

function hostPrompt(base: string, overlay: ReturnType<typeof createEmptyContextOverlay>): string {
  return overlay.items.length === 0 ? base : `${base}\n${canonicalJson(overlay.items)}`
}

test('disabled or unavailable flags return the empty overlay without reading providers', async () => {
  for (const flags of [
    undefined,
    () => undefined,
    { available: false, enabled: true },
    { available: true, enabled: false },
  ] as const) {
    let reads = 0
    const registry = createContextOverlayRegistry({ flags })
    registry.registerOne(provider(async () => {
      reads += 1
      return { data: { shouldNotBeRead: true } }
    }))

    const overlay = await registry.resolve(scope)
    assert.deepEqual(overlay, createEmptyContextOverlay())
    assert.equal(reads, 0)
    await registry.dispose()
  }
})

test('feature-off seam preserves the host prompt bytes and hash', async () => {
  const base = 'stable host prompt\nwith existing context'
  const registry = createContextOverlayRegistry({ flags: { available: false, enabled: true } })
  registry.registerOne(provider(async () => ({ data: { value: 'unreachable' } })))

  const overlay = await registry.resolve(scope)
  const before = hostPrompt(base, createEmptyContextOverlay())
  const after = hostPrompt(base, overlay)

  assert.equal(after, before)
  assert.equal(canonicalHash(after), canonicalHash(before))
  assert.equal(overlay.contentHash, createEmptyContextOverlay().contentHash)
  await registry.dispose()
})
