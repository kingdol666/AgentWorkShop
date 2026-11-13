import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

test('SSR theme emits the same dark class that the client plugin toggles', () => {
  const app = read('app/app.vue')
  assert.match(app, /htmlAttrs:[\s\S]*class:/, 'SSR htmlAttrs must include a theme class')
  assert.match(app, /store\.isDark \? ['"]dark['"]/, 'SSR class must derive from the cookie-backed store')
})

test('dashboard and Town release DAQ/DCW feed references on unmount', () => {
  const dashboard = read('app/pages/index.vue')
  assert.match(dashboard, /releaseDaqFeed = daq\.ensureWsFeed\(\)/)
  assert.match(dashboard, /releaseDaqFeed\?\.\(\)/)
  const town = read('app/composables/workshop/town/useTownRailData.ts')
  assert.match(town, /releaseDaqFeed = daq\.ensureWsFeed\(\)/)
  assert.match(town, /releaseDcwFeed = dcw\.ensureWsFeed\(\)/)
  assert.match(town, /releaseDaqFeed\?\.\(\)[\s\S]*releaseDcwFeed\?\.\(\)/)
})

test('CI runs every required static and responsive quality gate', () => {
  const ci = read('.github/workflows/ci.yml')
  for (const command of ['i18n:check', 'check:cssvars', 'frontend-lifecycle-contract']) {
    assert.match(ci, new RegExp(`pnpm run ${command}`), `${command} must be a CI gate`)
  }
})
