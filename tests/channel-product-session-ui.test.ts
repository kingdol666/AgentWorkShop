import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const api = read('app/composables/workshop/useWorkshopApi.ts')
const settings = read('app/components/workshop/session-list/ChannelSettingsModal.vue')
const sessions = read('app/components/workshop/SessionManageView.vue')

test('channel product API uses revisioned bindings and optional generic-session product', () => {
  assert.match(api, /getChannelProducts:\s*\(id: string\).*?\/products/s)
  assert.match(api, /putChannelProducts:\s*\(id: string, body: \{ expectedRevision: number, productIds: string\[\] \}\).*?\/products/s)
  assert.match(api, /createChannelSession:\s*\(id: string, body: \{ title\?: string, productId\?: string \}\)/)
  assert.match(api, /bindingSnapshotHash:\s*string/)
})

test('channel settings load revisioned product bindings and save them without channel patch', () => {
  assert.match(settings, /api\.getChannelProducts\(props\.channelId\)/)
  assert.match(settings, /api\.putChannelProducts\(props\.channelId,\s*\{\s*expectedRevision:/)
  assert.match(settings, /mode="multiple"/)
  assert.match(settings, /product\.lineId\s*===\s*lineId/)
  assert.match(settings, /api\.patchChannel\(props\.channelId/)
})

test('session creation requires a selected product and shows immutable snapshot identity', () => {
  assert.match(sessions, /api\.createChannelSession\(props\.channelId,\s*\{[^}]*productId:/s)
  assert.match(sessions, /:disabled="[^"]*createProductId/)
  assert.match(sessions, /bindingSnapshotHash/)
  assert.match(sessions, /productId/)
})
