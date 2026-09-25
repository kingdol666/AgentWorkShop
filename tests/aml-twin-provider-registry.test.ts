import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InjectionGreyboxProvider } from '../server/services/workshop/aml/twin/physics-runtime'
import { attachTwinPluginBridge, createTwinPluginBridge } from '../server/services/workshop/aml/twin/provider-loader'
import { TwinProviderRegistry, providerHashOf } from '../server/services/workshop/aml/twin/provider-registry'
import type {
  PhysicsProviderManifest,
  ScenePack,
  SolverAdapter,
  TwinPhysicsProvider,
  TwinPluginContribution,
} from '../server/services/workshop/aml/twin/provider-contracts'

function manifest(providerId: string, version: string): PhysicsProviderManifest {
  return {
    providerId,
    version,
    apiVersion: 'twin-provider.v1',
    sceneKinds: ['test-scene'],
    backend: 'typescript',
    stateVariables: [{ id: 'x', unit: 'ratio' }],
    controlVariables: [{ id: 'u', unit: 'ratio' }],
    disturbanceVariables: [],
    observationVariables: [{ id: 'y', unit: 'ratio' }],
    parameterPriors: {},
    capabilities: { onlineStep: true, rollout: true, calibration: false, uncertainty: false, externalSolver: false, mpc: false },
    artifactContract: { schemaVersion: 1, requiredArtifacts: [], optionalArtifacts: [] },
  }
}

function provider(providerId: string, version: string, health: 'healthy' | 'unhealthy' = 'healthy'): TwinPhysicsProvider {
  const providerManifest = manifest(providerId, version)
  return {
    manifest: () => providerManifest,
    validateScene: () => ({ valid: true }),
    initialize: () => ({ x: 0 }),
    step: input => ({ state: input.state, observations: { y: input.state.x ?? 0 }, guards: {} }),
    simulate: (_initial, controls) => ({ steps: controls.map(() => ({ state: { x: 0 }, observations: { y: 0 }, guards: {} })), failures: [] }),
    evaluateConstraints: () => [],
    health: () => ({ status: health, checkedAt: new Date().toISOString() }),
  }
}

const scenePack: ScenePack = {
  sceneKind: 'test-scene',
  sceneSchemaVersion: '1.0.0',
  objectives: [],
  constraints: [],
  datasetSchema: { schemaVersion: 1, columns: [] },
}

const solverAdapter: SolverAdapter = {
  manifest: { adapterId: 'test-solver', version: '1.0.0', backend: 'rom' },
  solve: async () => ({ status: 'completed', outputs: {} }),
}

function contribution(p: TwinPhysicsProvider, includeExtras = false): TwinPluginContribution {
  return includeExtras ? { providers: [p], scenePacks: [scenePack], solverAdapters: [solverAdapter] } : { providers: [p] }
}

test('registers providers, computes stable hashes, and is idempotent', () => {
  const registry = new TwinProviderRegistry()
  const p = provider('test-provider', '1.0.0')
  const first = registry.registerTwinPluginContribution('test-plugin', contribution(p, true), 1)
  const second = registry.registerTwinPluginContribution('test-plugin', contribution(p, true), 1)
  assert.equal(first.generation, 1)
  assert.equal(first.state, 'READY')
  assert.equal(second.idempotent, true)
  assert.equal(registry.listProviders().length, 1)
  assert.equal(registry.listScenePacks().length, 1)
  assert.equal(registry.listSolverAdapters().length, 1)
  assert.equal(providerHashOf(p), registry.listProviders()[0]?.providerHash)
})

test('resolves a lease and drains old generation without invalidating in-flight work', () => {
  const registry = new TwinProviderRegistry()
  const oldProvider = provider('reloadable', '1.0.0')
  const newProvider = provider('reloadable', '2.0.0')
  registry.registerTwinPluginContribution('reload-plugin', { providers: [oldProvider] }, 1)
  const oldLease = registry.acquireProvider('reloadable')
  assert.ok(oldLease)
  assert.equal(oldLease?.provider, oldProvider)

  registry.reloadGeneration('reload-plugin', { providers: [newProvider] }, 2)
  assert.equal(registry.listProviders()[0]?.version, '2.0.0')
  const oldSummary = registry.listProviders({ includeDraining: true }).find(item => item.version === '1.0.0')
  assert.equal(oldSummary?.state, 'DRAINING')
  assert.equal(oldSummary?.inFlight, 1)

  const drain = registry.drainGeneration('reload-plugin', 1)
  assert.equal(drain.retired, false)
  oldLease?.release()
  oldLease?.release()
  const retired = registry.listProviders({ includeRetired: true, includeDraining: true }).find(item => item.version === '1.0.0')
  assert.equal(retired?.state, 'RETIRED')
  assert.equal(retired?.inFlight, 0)
  assert.equal(registry.acquireProvider('reloadable')?.provider, newProvider)
})

test('retire waits for references and health marks failed providers unavailable', async () => {
  const registry = new TwinProviderRegistry()
  const unhealthy = provider('health-provider', '1.0.0', 'unhealthy')
  registry.registerTwinPluginContribution('health-plugin', { providers: [unhealthy] }, 1)
  const health = await registry.checkProviderHealth('health-provider')
  assert.equal(health.status, 'unhealthy')
  assert.equal(registry.resolveProvider('health-provider'), undefined)

  const good = provider('retire-provider', '1.0.0')
  registry.registerTwinPluginContribution('retire-plugin', { providers: [good] }, 1)
  const lease = registry.acquireProvider('retire-provider')
  assert.ok(lease)
  const pending = registry.retireProvider('retire-provider', '1.0.0')
  assert.equal(pending.state, 'DRAINING')
  assert.equal(pending.inFlight, 1)
  lease?.release()
  assert.equal(registry.listProviders({ includeRetired: true }).find(item => item.providerId === 'retire-provider')?.state, 'RETIRED')
})

test('legacy injection provider can be registered without changing physics-runtime', () => {
  const registry = new TwinProviderRegistry()
  const result = registry.registerPhysicsProvider(new InjectionGreyboxProvider(), 'twin-injection-default', 1)
  assert.equal(result.ok, true)
  const resolved = registry.acquireProvider('injection-greybox-v1')
  assert.ok(resolved)
  assert.equal(resolved?.manifest.sceneKinds[0], 'injection-hold-control')
  resolved?.release()
})

test('global twin bridge replays pending operations and forwards live operations', () => {
  const previous = (globalThis as unknown as { __twinPluginExt?: unknown }).__twinPluginExt
  const registry = new TwinProviderRegistry()
  const bridge = createTwinPluginBridge()
  const global = globalThis as unknown as { __twinPluginExt?: unknown }
  global.__twinPluginExt = bridge
  try {
    bridge.registerTwinPluginContribution('bridge-plugin', { providers: [provider('bridge-provider', '1.0.0')] }, 1)
    assert.equal(registry.listProviders().length, 0)
    attachTwinPluginBridge(registry)
    assert.equal(registry.listProviders()[0]?.providerId, 'bridge-provider')
    bridge.registerTwinPluginContribution('bridge-plugin', { providers: [provider('bridge-provider', '2.0.0')] }, 2)
    assert.equal(registry.listProviders()[0]?.version, '2.0.0')
    bridge.unregisterTwinPluginContribution('bridge-plugin', 2)
    assert.equal(registry.listProviders().length, 0)
  }
  finally {
    if (previous === undefined) delete global.__twinPluginExt
    else global.__twinPluginExt = previous
  }
})

