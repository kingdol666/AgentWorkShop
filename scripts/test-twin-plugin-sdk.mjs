/* eslint-disable @stylistic/max-statements-per-line */
import assert from 'node:assert/strict'
import { createPluginContext, TWIN_BRIDGE_KEY } from '../sdk/context.mjs'
import { HookBus } from '../sdk/hooks.mjs'

const registrations = []
globalThis[TWIN_BRIDGE_KEY] = {
  pending: [],
  register(kind, payload, source) { registrations.push({ kind, payload, source }); return { ok: true } },
  listProviders() { return [] },
  getProviderHealth() { return { status: 'healthy' } },
  resolveProvider() { return null },
  validateProvider() { return { valid: true, errors: [], warnings: [] } },
  retireProvider() { return { ok: true } },
}
const disposables = []
const ctx = createPluginContext({
  name: 'sdk-twin-test', scope: 'project', dir: process.cwd(), hooks: new HookBus(),
  config: null, paths: { home: process.cwd(), configRoot: process.cwd(), dataDir: process.cwd() },
  emitter: { registerRoute: () => true }, selfOrigin: 'http://127.0.0.1:3000',
  onDispose: (fn) => { disposables.push(fn); return fn },
})
ctx.twin.registerPhysicsProvider({ manifest: { providerId: 'test-provider', version: '1.0.0' } })
ctx.twin.registerScenePack({ scenePackId: 'test-scene', version: '1.0.0' })
assert.equal(registrations.length, 2)
assert.equal(registrations[0].kind, 'registerPhysicsProvider')
assert.equal(registrations[1].kind, 'registerScenePack')
assert.equal(ctx.twin.isRegistryAvailable(), true)
for (const dispose of disposables) dispose()
console.log('Twin SDK bridge: 5 passed / 0 failed')
